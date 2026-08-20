import type { AttributeValue, Operator } from './types.ts';

/**
 * Operator implementations.
 *
 * Every operator is total: it returns false rather than throwing on a type
 * mismatch. A rule authored against a string attribute must not crash the host
 * application when some user happens to have a number there.
 */

function asString(value: AttributeValue): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: AttributeValue): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Compares two values only when both sides are the same primitive type. */
function looseEquals(a: AttributeValue, b: AttributeValue): boolean {
  return a === b;
}

interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string;
}

const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseSemVer(input: AttributeValue): SemVer | undefined {
  const raw = asString(input);
  if (raw === undefined) return undefined;
  const match = SEMVER_PATTERN.exec(raw);
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? '',
  };
}

/** Returns <0, 0, or >0. A version with a prerelease sorts before its release. */
export function compareSemVer(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === '') return 1;
  if (b.prerelease === '') return -1;
  return a.prerelease < b.prerelease ? -1 : 1;
}

/**
 * Regex cache for the `matches` operator.
 *
 * Patterns come from the rule tree, which is authored by tenant admins — not
 * end users — so this is not an untrusted-input path. It is still a ReDoS
 * surface: a catastrophic pattern would block the host application's thread,
 * violating the SDK's hard requirement never to slow its host. Rule validation
 * in the control plane is the right place to reject those; see
 * spec/BUCKETING.md's sibling work in the targeting validator.
 */
const regexCache = new Map<string, RegExp | null>();

function compileRegex(pattern: string): RegExp | null {
  const cached = regexCache.get(pattern);
  if (cached !== undefined) return cached;
  let compiled: RegExp | null;
  try {
    compiled = new RegExp(pattern);
  } catch {
    compiled = null; // Invalid pattern never matches.
  }
  regexCache.set(pattern, compiled);
  return compiled;
}

function compareNumeric(
  attribute: AttributeValue,
  values: readonly AttributeValue[],
  predicate: (a: number, b: number) => boolean,
): boolean {
  const left = asNumber(attribute);
  if (left === undefined) return false;
  return values.some((value) => {
    const right = asNumber(value);
    return right !== undefined && predicate(left, right);
  });
}

function compareSemantic(
  attribute: AttributeValue,
  values: readonly AttributeValue[],
  predicate: (ordering: number) => boolean,
): boolean {
  const left = parseSemVer(attribute);
  if (left === undefined) return false;
  return values.some((value) => {
    const right = parseSemVer(value);
    return right !== undefined && predicate(compareSemVer(left, right));
  });
}

function compareString(
  attribute: AttributeValue,
  values: readonly AttributeValue[],
  predicate: (a: string, b: string) => boolean,
): boolean {
  const left = asString(attribute);
  if (left === undefined) return false;
  return values.some((value) => {
    const right = asString(value);
    return right !== undefined && predicate(left, right);
  });
}

/**
 * Applies an operator. `attribute` is undefined when the context does not carry
 * the attribute at all, which never matches — including for `neq`/`notIn`,
 * because "not equal to X" should not silently include everyone missing the
 * attribute entirely.
 */
export function applyOperator(
  operator: Operator,
  attribute: AttributeValue | undefined,
  values: readonly AttributeValue[],
): boolean {
  if (attribute === undefined) return false;

  switch (operator) {
    case 'eq':
      return values.some((value) => looseEquals(attribute, value));
    case 'neq':
      return !values.some((value) => looseEquals(attribute, value));
    case 'in':
      return values.some((value) => looseEquals(attribute, value));
    case 'notIn':
      return !values.some((value) => looseEquals(attribute, value));
    case 'contains':
      return compareString(attribute, values, (a, b) => a.includes(b));
    case 'startsWith':
      return compareString(attribute, values, (a, b) => a.startsWith(b));
    case 'endsWith':
      return compareString(attribute, values, (a, b) => a.endsWith(b));
    case 'matches':
      return compareString(attribute, values, (a, b) => {
        const regex = compileRegex(b);
        return regex !== null && regex.test(a);
      });
    case 'gt':
      return compareNumeric(attribute, values, (a, b) => a > b);
    case 'gte':
      return compareNumeric(attribute, values, (a, b) => a >= b);
    case 'lt':
      return compareNumeric(attribute, values, (a, b) => a < b);
    case 'lte':
      return compareNumeric(attribute, values, (a, b) => a <= b);
    case 'semverGt':
      return compareSemantic(attribute, values, (ordering) => ordering > 0);
    case 'semverLt':
      return compareSemantic(attribute, values, (ordering) => ordering < 0);
    default: {
      // Unknown operator from a newer control plane: fail closed rather than
      // throwing. Forward compatibility matters when the SDK is a dependency.
      const _exhaustive: never = operator;
      void _exhaustive;
      return false;
    }
  }
}
