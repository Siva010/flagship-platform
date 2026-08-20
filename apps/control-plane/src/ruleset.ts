import {
  filterSnapshotForKey,
  findServerOnlyLeaks,
  isValidDistribution,
  type Flag,
  type RuleNode,
  type RulesetSnapshot,
  type Segment,
  type TargetingRule,
} from '@flagship/core';

/**
 * Compiles database rows into the payloads SDKs receive.
 *
 * Two payloads come out of one source: the server payload with every rule, and
 * the client payload with server-only material stripped. They are built here,
 * once per publish, rather than filtered per request — filtering on the hot
 * path would put a security-critical transform in the latency budget, and a
 * cache miss would be a leak waiting to happen.
 */

export interface FlagRow {
  key: string;
  salt: string;
  bucket_by: string;
  variations: unknown;
  enabled: boolean;
  default_variation_key: string;
  off_variation_key: string;
  rules: unknown;
  prerequisites: unknown;
}

export interface SegmentRow {
  key: string;
  rule_tree: unknown;
}

export interface CompiledRuleset {
  server: RulesetSnapshot;
  client: RulesetSnapshot;
}

export class RulesetValidationError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`ruleset is invalid: ${problems.join('; ')}`);
    this.name = 'RulesetValidationError';
    this.problems = problems;
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Structural validation of a rule tree.
 *
 * Rule trees arrive as JSONB, so the database enforces nothing about their
 * shape. An invalid tree that reaches an SDK is worse than a rejected publish:
 * it fails closed at evaluation time, silently disabling a flag in production.
 */
function validateRuleNode(node: unknown, path: string, problems: string[], depth = 0): void {
  // Bounds recursion. A deeply nested tree would otherwise be a stack-overflow
  // vector against both this validator and every SDK.
  if (depth > 32) {
    problems.push(`${path}: rule tree nested deeper than 32 levels`);
    return;
  }

  if (typeof node !== 'object' || node === null) {
    problems.push(`${path}: expected an object`);
    return;
  }

  const candidate = node as Record<string, unknown>;
  switch (candidate['kind']) {
    case 'condition': {
      if (typeof candidate['attribute'] !== 'string' || candidate['attribute'] === '') {
        problems.push(`${path}: condition needs a non-empty attribute`);
      }
      if (typeof candidate['operator'] !== 'string') {
        problems.push(`${path}: condition needs an operator`);
      }
      if (!Array.isArray(candidate['values']) || candidate['values'].length === 0) {
        problems.push(`${path}: condition needs at least one value`);
      }
      if (candidate['visibility'] !== 'client' && candidate['visibility'] !== 'server') {
        // Defaulting would be dangerous in one direction: guessing 'client'
        // would publish a server-only rule to browsers.
        problems.push(`${path}: condition needs visibility of "client" or "server"`);
      }
      return;
    }
    case 'and':
    case 'or':
    case 'not': {
      const children = candidate['children'];
      if (!Array.isArray(children)) {
        problems.push(`${path}: ${String(candidate['kind'])} needs a children array`);
        return;
      }
      children.forEach((child, index) =>
        validateRuleNode(child, `${path}.children[${index}]`, problems, depth + 1),
      );
      return;
    }
    case 'segment': {
      if (typeof candidate['segmentKey'] !== 'string' || candidate['segmentKey'] === '') {
        problems.push(`${path}: segment reference needs a segmentKey`);
      }
      if (typeof candidate['negate'] !== 'boolean') {
        problems.push(`${path}: segment reference needs a boolean negate`);
      }
      return;
    }
    default:
      problems.push(`${path}: unknown node kind ${JSON.stringify(candidate['kind'])}`);
  }
}

function validateFlag(flag: Flag, segmentKeys: ReadonlySet<string>, problems: string[]): void {
  const variationKeys = new Set(flag.variations.map((variation) => variation.key));

  if (variationKeys.size === 0) {
    problems.push(`flag "${flag.key}": needs at least one variation`);
    return;
  }
  if (variationKeys.size !== flag.variations.length) {
    problems.push(`flag "${flag.key}": duplicate variation keys`);
  }
  if (!variationKeys.has(flag.defaultVariationKey)) {
    problems.push(`flag "${flag.key}": defaultVariationKey is not a declared variation`);
  }
  if (!variationKeys.has(flag.offVariationKey)) {
    problems.push(`flag "${flag.key}": offVariationKey is not a declared variation`);
  }

  for (const [index, rule] of flag.rules.entries()) {
    const path = `flag "${flag.key}" rule[${index}]`;
    validateRuleNode(rule.when, path, problems);

    // Every segment a rule references must exist, or the rule silently never
    // matches — which looks identical to "the flag is off" when debugging.
    for (const segmentKey of collectSegmentKeys(rule.when)) {
      if (!segmentKeys.has(segmentKey)) {
        problems.push(`${path}: references unknown segment "${segmentKey}"`);
      }
    }

    if ('variationKey' in rule.serve) {
      if (!variationKeys.has(rule.serve.variationKey)) {
        problems.push(`${path}: serves undeclared variation "${rule.serve.variationKey}"`);
      }
    } else {
      if (!isValidDistribution(rule.serve.rollout)) {
        problems.push(`${path}: rollout weights must be non-negative integers summing to 100000`);
      }
      for (const slice of rule.serve.rollout) {
        if (!variationKeys.has(slice.variationKey)) {
          problems.push(`${path}: rollout references undeclared variation "${slice.variationKey}"`);
        }
      }
    }
  }
}

function collectSegmentKeys(node: RuleNode, into = new Set<string>()): Set<string> {
  if (node.kind === 'segment') into.add(node.segmentKey);
  else if (node.kind === 'and' || node.kind === 'or' || node.kind === 'not') {
    for (const child of node.children) collectSegmentKeys(child, into);
  }
  return into;
}

/**
 * Builds both payloads and validates them.
 *
 * Throws RulesetValidationError rather than publishing something malformed:
 * rejecting a bad publish is recoverable, shipping one to every SDK is not.
 */
export function compileRuleset(options: {
  environmentKey: string;
  version: number;
  flags: FlagRow[];
  segments: SegmentRow[];
  servedAt?: string;
}): CompiledRuleset {
  const problems: string[] = [];

  const segments: Segment[] = options.segments.map((row) => ({
    key: row.key,
    when: row.rule_tree as RuleNode,
  }));

  for (const segment of segments) {
    validateRuleNode(segment.when, `segment "${segment.key}"`, problems);
  }

  const segmentKeys = new Set(segments.map((segment) => segment.key));

  const flags: Flag[] = options.flags.map((row) => ({
    key: row.key,
    enabled: row.enabled,
    salt: row.salt,
    bucketBy: row.bucket_by,
    variations: asArray(row.variations) as Flag['variations'],
    defaultVariationKey: row.default_variation_key,
    offVariationKey: row.off_variation_key,
    prerequisites: asArray(row.prerequisites) as Flag['prerequisites'],
    rules: asArray(row.rules) as TargetingRule[],
  }));

  const flagKeys = new Set(flags.map((flag) => flag.key));
  for (const flag of flags) {
    validateFlag(flag, segmentKeys, problems);
    for (const prerequisite of flag.prerequisites) {
      if (!flagKeys.has(prerequisite.flagKey)) {
        problems.push(`flag "${flag.key}": prerequisite "${prerequisite.flagKey}" does not exist`);
      }
    }
  }

  const cycle = findPrerequisiteCycle(flags);
  if (cycle) {
    problems.push(`prerequisite cycle: ${cycle.join(' -> ')}`);
  }

  if (problems.length > 0) throw new RulesetValidationError(problems);

  const server: RulesetSnapshot = {
    environmentKey: options.environmentKey,
    version: options.version,
    flags,
    segments,
    servedAt: options.servedAt ?? new Date().toISOString(),
  };

  const client = filterSnapshotForKey(server, 'client');

  // Defence in depth. If the filter ever regresses, this fails the publish
  // rather than shipping server-only rules to browsers.
  const leaks = findServerOnlyLeaks(client);
  if (leaks.length > 0) {
    throw new RulesetValidationError([
      `client payload would leak server-only material: ${leaks.join(', ')}`,
    ]);
  }

  return { server, client };
}

/**
 * Detects a prerequisite cycle, returning the path if one exists.
 *
 * The SDK guards against cycles at evaluation time, but catching them here
 * means the ruleset never ships in a state where a flag silently fails closed.
 */
function findPrerequisiteCycle(flags: readonly Flag[]): string[] | undefined {
  const byKey = new Map(flags.map((flag) => [flag.key, flag]));
  const state = new Map<string, 'visiting' | 'done'>();
  const path: string[] = [];

  function visit(key: string): string[] | undefined {
    const current = state.get(key);
    if (current === 'done') return undefined;
    if (current === 'visiting') return [...path.slice(path.indexOf(key)), key];

    const flag = byKey.get(key);
    if (flag === undefined) return undefined;

    state.set(key, 'visiting');
    path.push(key);

    for (const prerequisite of flag.prerequisites) {
      const found = visit(prerequisite.flagKey);
      if (found) return found;
    }

    path.pop();
    state.set(key, 'done');
    return undefined;
  }

  for (const flag of flags) {
    const found = visit(flag.key);
    if (found) return found;
  }
  return undefined;
}
