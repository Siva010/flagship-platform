import type { Flag, RuleNode, RulesetSnapshot, Segment, TargetingRule } from './types.ts';

/**
 * Payload filtering by SDK key type.
 *
 * Client-side keys are public by definition — they ship inside browser bundles,
 * so anyone can read the payload the data plane sends them. A rule like
 * `email endsWith "@competitor.com"` leaks a business fact to the whole
 * internet if it reaches a client SDK.
 *
 * One rule tree, two serialization paths. Server keys get everything; client
 * keys get a payload with every server-only node removed.
 *
 * The filtering rule that matters: removing a node from a boolean tree changes
 * what that tree means. Dropping a server-only condition out of an AND makes
 * the AND *more* permissive, which would enable the flag for users the author
 * excluded. So a rule containing any server-only node is dropped in full rather
 * than partially rewritten. Failing closed is the only safe direction here.
 */

export type KeyKind = 'client' | 'server';

/** True when any node anywhere in the tree is server-only. */
export function containsServerOnly(node: RuleNode): boolean {
  switch (node.kind) {
    case 'condition':
      return node.visibility === 'server';
    case 'and':
    case 'or':
    case 'not':
      return node.children.some(containsServerOnly);
    case 'segment':
      // Resolved separately: a segment reference is opaque here, and whether it
      // is safe depends on the segment's own tree.
      return false;
    default: {
      const _exhaustive: never = node;
      void _exhaustive;
      return true; // Unknown node kind: treat as unsafe.
    }
  }
}

/** Segment keys referenced anywhere in a tree. */
export function referencedSegments(node: RuleNode, into = new Set<string>()): Set<string> {
  switch (node.kind) {
    case 'segment':
      into.add(node.segmentKey);
      break;
    case 'and':
    case 'or':
    case 'not':
      for (const child of node.children) referencedSegments(child, into);
      break;
    case 'condition':
      break;
  }
  return into;
}

/**
 * Segments whose trees are safe to expose to a client key.
 *
 * A segment referencing another segment is only safe if that one is too, so
 * this iterates to a fixed point. Any segment in a reference cycle never
 * becomes safe, which is the correct conservative answer.
 */
function clientSafeSegments(segments: readonly Segment[]): Set<string> {
  const safe = new Set<string>();
  let changed = true;

  while (changed) {
    changed = false;
    for (const segment of segments) {
      if (safe.has(segment.key)) continue;
      if (containsServerOnly(segment.when)) continue;

      const dependencies = referencedSegments(segment.when);
      let dependenciesSafe = true;
      for (const dependency of dependencies) {
        if (!safe.has(dependency)) {
          dependenciesSafe = false;
          break;
        }
      }
      if (dependenciesSafe) {
        safe.add(segment.key);
        changed = true;
      }
    }
  }

  return safe;
}

/** A rule is client-safe when its tree has no server-only node and every segment it uses is safe. */
function isRuleClientSafe(rule: TargetingRule, safeSegments: ReadonlySet<string>): boolean {
  if (containsServerOnly(rule.when)) return false;
  for (const segmentKey of referencedSegments(rule.when)) {
    if (!safeSegments.has(segmentKey)) return false;
  }
  return true;
}

function filterFlag(flag: Flag, safeSegments: ReadonlySet<string>): Flag {
  return {
    ...flag,
    // Dropping a rule means traffic that would have matched it now falls
    // through to the next rule or the default. That is the intended
    // conservative behaviour: a client must never be *more* included than the
    // author specified.
    rules: flag.rules.filter((rule) => isRuleClientSafe(rule, safeSegments)),
  };
}

/**
 * Produces the payload for a given key kind.
 *
 * Server keys receive the snapshot unchanged. Client keys receive a copy with
 * every server-only rule and segment removed.
 */
export function filterSnapshotForKey(snapshot: RulesetSnapshot, kind: KeyKind): RulesetSnapshot {
  if (kind === 'server') return snapshot;

  const safeSegments = clientSafeSegments(snapshot.segments);

  return {
    ...snapshot,
    flags: snapshot.flags.map((flag) => filterFlag(flag, safeSegments)),
    segments: snapshot.segments.filter((segment) => safeSegments.has(segment.key)),
  };
}

/**
 * Asserts that a payload carries no server-only material.
 *
 * Used as a defence-in-depth check before serving a client payload: a filter
 * bug should surface as a failed invariant on our side, not as a leak on the
 * client's. Returns the offending locations rather than throwing.
 */
export function findServerOnlyLeaks(snapshot: RulesetSnapshot): string[] {
  const leaks: string[] = [];
  const segmentKeys = new Set(snapshot.segments.map((segment) => segment.key));

  for (const segment of snapshot.segments) {
    if (containsServerOnly(segment.when)) leaks.push(`segment "${segment.key}"`);
  }

  for (const flag of snapshot.flags) {
    for (const rule of flag.rules) {
      if (containsServerOnly(rule.when)) {
        leaks.push(`flag "${flag.key}" rule "${rule.id}"`);
      }
      for (const segmentKey of referencedSegments(rule.when)) {
        if (!segmentKeys.has(segmentKey)) {
          // A dangling reference is not a leak, but it means the rule can never
          // match on the client while it does match on the server — a silent
          // behaviour divergence worth surfacing.
          leaks.push(`flag "${flag.key}" rule "${rule.id}" references missing segment "${segmentKey}"`);
        }
      }
    }
  }

  return leaks;
}
