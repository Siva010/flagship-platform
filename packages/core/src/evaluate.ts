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

/** A flag with its per-evaluation lookups precomputed. */
interface CompiledFlag {
  readonly flag: Flag;
  readonly variations: ReadonlyMap<string, Variation>;
}

export interface EvaluationEnvironment {
  readonly flags: ReadonlyMap<string, CompiledFlag>;
  readonly segments: ReadonlyMap<string, Segment>;
}

/**
 * Compiles a snapshot into evaluation-ready form.
 *
 * Every cost that can be paid once per ruleset apply is paid here rather than
 * per evaluation — flag lookup and variation lookup both become map hits
 * instead of array scans. This is the difference between compiling the ruleset
 * and interpreting the JSON on every flag check.
 */
export function indexSnapshot(snapshot: RulesetSnapshot): EvaluationEnvironment {
  const flags = new Map<string, CompiledFlag>();
  for (const flag of snapshot.flags) {
    const variations = new Map<string, Variation>();
    for (const variation of flag.variations) variations.set(variation.key, variation);
    flags.set(flag.key, { flag, variations });
  }

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
  // Allocated lazily: most rule trees contain no segment reference at all, and
  // allocating a Set per rule showed up clearly in the evaluation benchmark.
  seenSegments: Set<string> | undefined,
): boolean {
  switch (node.kind) {
    case 'condition':
      return applyOperator(node.operator, resolveAttribute(context, node.attribute), node.values);

    // Plain loops rather than every/some: the callback allocates a closure per
    // node per evaluation, which is measurable on the hot path.
    case 'and': {
      // Vacuous truth: an empty AND matches, matching boolean-algebra convention.
      const children = node.children;
      for (let i = 0; i < children.length; i++) {
        if (!matchNode(children[i]!, context, env, seenSegments)) return false;
      }
      return true;
    }

    case 'or': {
      const children = node.children;
      for (let i = 0; i < children.length; i++) {
        if (matchNode(children[i]!, context, env, seenSegments)) return true;
      }
      return false;
    }

    case 'not': {
      // NOT negates the conjunction of its children, so a single child behaves
      // as expected and an empty NOT is false.
      const children = node.children;
      for (let i = 0; i < children.length; i++) {
        if (!matchNode(children[i]!, context, env, seenSegments)) return true;
      }
      return false;
    }

    case 'segment': {
      const seen = seenSegments ?? new Set<string>();
      if (seen.has(node.segmentKey)) return false; // Cycle: fail closed.
      const segment = env.segments.get(node.segmentKey);
      if (segment === undefined) return false; // Unknown segment: fail closed.

      seen.add(node.segmentKey);
      try {
        const matched = matchNode(segment.when, context, env, seen);
        return node.negate ? !matched : matched;
      } finally {
        seen.delete(node.segmentKey);
      }
    }

    default: {
      const _exhaustive: never = node;
      void _exhaustive;
      return false;
    }
  }
}


/** The value used for bucketing. Absent means the flag cannot roll out to this context. */
function resolveBucketKey(flag: Flag, context: EvaluationContext): string | undefined {
  const raw = resolveAttribute(context, flag.bucketBy);
  if (raw === undefined || raw === null) return undefined;
  return String(raw);
}

function resultFor<T>(
  compiled: CompiledFlag,
  variationKey: string,
  reason: EvaluationResult<T>['reason'],
  fallback: T,
  bucket?: number,
): EvaluationResult<T> {
  const variation = compiled.variations.get(variationKey);
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
  const compiled = env.flags.get(flagKey);
  if (compiled === undefined) {
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
  const flag = compiled.flag;

  try {
    // A disabled flag short-circuits everything, including prerequisites.
    if (!flag.enabled) {
      return resultFor(compiled, flag.offVariationKey, { kind: 'off' }, fallback);
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
          compiled,
          flag.offVariationKey,
          { kind: 'prerequisiteFailed', flagKey: prerequisite.flagKey },
          fallback,
        );
      }
    }

    // Targeting rules, in declaration order. First match wins.
    for (const rule of flag.rules) {
      if (!matchNode(rule.when, context, env, undefined)) continue;

      if ('variationKey' in rule.serve) {
        return resultFor(compiled, rule.serve.variationKey, { kind: 'ruleMatch', ruleId: rule.id }, fallback);
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
      return resultFor(compiled, variationKey, { kind: 'ruleMatch', ruleId: rule.id }, fallback, bucket);
    }

    return resultFor(compiled, flag.defaultVariationKey, { kind: 'default' }, fallback);
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
