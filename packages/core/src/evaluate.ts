import { bucketFor, variationForBucket } from './bucketing.ts';
import { applyOperator } from './operators.ts';
import type {
  AttributeValue,
  EvaluationContext,
  EvaluationResult,
  Flag,
  RuleNode,
  RulesetSnapshot,
  Segment,
  Variation,
} from './types.ts';

/**
 * Rule evaluation.
 *
 * Two invariants hold throughout, because this code runs inside someone else's
 * request path hundreds of times per request:
 *
 *  1. It never throws. Every failure becomes an `error` reason carrying the
 *     caller's fallback value.
 *  2. It never performs I/O. Everything needed is in the indexed snapshot.
 */

export interface EvaluationEnvironment {
  readonly flags: ReadonlyMap<string, Flag>;
  readonly segments: ReadonlyMap<string, Segment>;
}

/**
 * Builds the lookup maps once per snapshot, rather than scanning arrays on every
 * evaluation. This is the "compile into an evaluation tree, not an interpreted
 * JSON walk" step: index cost is paid on ruleset apply, not on the hot path.
 */
export function indexSnapshot(snapshot: RulesetSnapshot): EvaluationEnvironment {
  const flags = new Map<string, Flag>();
  for (const flag of snapshot.flags) flags.set(flag.key, flag);

  const segments = new Map<string, Segment>();
  for (const segment of snapshot.segments) segments.set(segment.key, segment);

  return { flags, segments };
}

function resolveAttribute(
  context: EvaluationContext,
  attribute: string,
): AttributeValue | undefined {
  // "key" is the canonical context identifier and is addressable as an attribute
  // so rules can target it without a special case.
  if (attribute === 'key') return context.key;
  return context.attributes[attribute];
}

/**
 * Evaluates a rule node.
 *
 * `seenSegments` guards against a segment that references itself, directly or
 * through a cycle. Without it a malformed ruleset would recurse until the stack
 * overflows — inside the host application's request path.
 */
function matchNode(
  node: RuleNode,
  context: EvaluationContext,
  env: EvaluationEnvironment,
  seenSegments: Set<string>,
): boolean {
  switch (node.kind) {
    case 'condition':
      return applyOperator(node.operator, resolveAttribute(context, node.attribute), node.values);

    case 'and':
      // Vacuous truth: an empty AND matches, matching boolean-algebra convention.
      return node.children.every((child) => matchNode(child, context, env, seenSegments));

    case 'or':
      return node.children.some((child) => matchNode(child, context, env, seenSegments));

    case 'not':
      // NOT negates the conjunction of its children, so a single child behaves
      // as expected and an empty NOT is false.
      return !node.children.every((child) => matchNode(child, context, env, seenSegments));

    case 'segment': {
      if (seenSegments.has(node.segmentKey)) return false; // Cycle: fail closed.
      const segment = env.segments.get(node.segmentKey);
      if (segment === undefined) return false; // Unknown segment: fail closed.

      seenSegments.add(node.segmentKey);
      try {
        const matched = matchNode(segment.when, context, env, seenSegments);
        return node.negate ? !matched : matched;
      } finally {
        seenSegments.delete(node.segmentKey);
      }
    }

    default: {
      const _exhaustive: never = node;
      void _exhaustive;
      return false;
    }
  }
}

function findVariation(flag: Flag, key: string): Variation | undefined {
  return flag.variations.find((variation) => variation.key === key);
}

/** The value used for bucketing. Absent means the flag cannot roll out to this context. */
function resolveBucketKey(flag: Flag, context: EvaluationContext): string | undefined {
  const raw = resolveAttribute(context, flag.bucketBy);
  if (raw === undefined || raw === null) return undefined;
  return String(raw);
}

function resultFor<T>(
  flag: Flag,
  variationKey: string,
  reason: EvaluationResult<T>['reason'],
  fallback: T,
  bucket?: number,
): EvaluationResult<T> {
  const variation = findVariation(flag, variationKey);
  if (variation === undefined) {
    return {
      value: fallback,
      variationKey,
      reason: { kind: 'error', message: `unknown variation "${variationKey}"` },
    };
  }
  return bucket === undefined
    ? { value: variation.value as T, variationKey, reason }
    : { value: variation.value as T, variationKey, reason, bucket };
}

/**
 * Evaluates one flag against a context.
 *
 * `seenFlags` guards prerequisite cycles (A requires B requires A), which a
 * malformed ruleset could otherwise turn into unbounded recursion.
 */
function evaluateInternal<T>(
  flagKey: string,
  context: EvaluationContext,
  env: EvaluationEnvironment,
  fallback: T,
  seenFlags: Set<string>,
): EvaluationResult<T> {
  const flag = env.flags.get(flagKey);
  if (flag === undefined) {
    return {
      value: fallback,
      variationKey: '',
      reason: { kind: 'error', message: `unknown flag "${flagKey}"` },
    };
  }

  if (seenFlags.has(flagKey)) {
    return {
      value: fallback,
      variationKey: '',
      reason: { kind: 'error', message: `prerequisite cycle at "${flagKey}"` },
    };
  }
  seenFlags.add(flagKey);

  try {
    // A disabled flag short-circuits everything, including prerequisites.
    if (!flag.enabled) {
      return resultFor(flag, flag.offVariationKey, { kind: 'off' }, fallback);
    }

    // Prerequisites: this flag only evaluates if each required flag currently
    // serves the required variation.
    for (const prerequisite of flag.prerequisites) {
      const upstream = evaluateInternal(
        prerequisite.flagKey,
        context,
        env,
        undefined,
        seenFlags,
      );
      if (upstream.variationKey !== prerequisite.variationKey) {
        return resultFor(
          flag,
          flag.offVariationKey,
          { kind: 'prerequisiteFailed', flagKey: prerequisite.flagKey },
          fallback,
        );
      }
    }

    // Targeting rules, in declaration order. First match wins.
    for (const rule of flag.rules) {
      if (!matchNode(rule.when, context, env, new Set())) continue;

      if ('variationKey' in rule.serve) {
        return resultFor(flag, rule.serve.variationKey, { kind: 'ruleMatch', ruleId: rule.id }, fallback);
      }

      const bucketKey = resolveBucketKey(flag, context);
      if (bucketKey === undefined) {
        // No bucketing attribute: cannot place this context in a rollout, so
        // fall through to the default rather than guessing.
        break;
      }

      const bucket = bucketFor(flag.key, flag.salt, bucketKey);
      const variationKey = variationForBucket(rule.serve.rollout, bucket);
      if (variationKey === undefined) {
        return {
          value: fallback,
          variationKey: '',
          reason: { kind: 'error', message: `malformed rollout in rule "${rule.id}"` },
        };
      }
      return resultFor(flag, variationKey, { kind: 'ruleMatch', ruleId: rule.id }, fallback, bucket);
    }

    return resultFor(flag, flag.defaultVariationKey, { kind: 'default' }, fallback);
  } finally {
    seenFlags.delete(flagKey);
  }
}

/**
 * Evaluates a flag. Never throws — a malformed ruleset yields an `error` reason
 * and the caller's fallback.
 */
export function evaluateFlag<T>(
  flagKey: string,
  context: EvaluationContext,
  env: EvaluationEnvironment,
  fallback: T,
): EvaluationResult<T> {
  try {
    return evaluateInternal(flagKey, context, env, fallback, new Set());
  } catch (error) {
    return {
      value: fallback,
      variationKey: '',
      reason: {
        kind: 'error',
        message: error instanceof Error ? error.message : 'evaluation failed',
      },
    };
  }
}
