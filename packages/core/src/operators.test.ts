import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyOperator, compareSemVer, parseSemVer } from './operators.ts';

describe('applyOperator', () => {
  it('never matches when the attribute is absent', () => {
    // Including the negative operators: "not equal to X" must not silently
    // include every context that lacks the attribute entirely.
    for (const op of ['eq', 'neq', 'in', 'notIn', 'contains', 'gt', 'lt'] as const) {
      assert.equal(applyOperator(op, undefined, ['x']), false, `${op} matched an absent attribute`);
    }
  });

  it('compares equality strictly, without type coercion', () => {
    assert.equal(applyOperator('eq', 1, [1]), true);
    assert.equal(applyOperator('eq', 1, ['1']), false, '1 must not equal "1"');
    assert.equal(applyOperator('eq', true, ['true']), false);
    assert.equal(applyOperator('neq', 'a', ['b']), true);
  });

  it('treats values as a set for in/notIn', () => {
    assert.equal(applyOperator('in', 'eu', ['us', 'eu']), true);
    assert.equal(applyOperator('notIn', 'apac', ['us', 'eu']), true);
    assert.equal(applyOperator('notIn', 'eu', ['us', 'eu']), false);
  });

  it('applies string operators only to strings', () => {
    assert.equal(applyOperator('contains', 'abcdef', ['cde']), true);
    assert.equal(applyOperator('startsWith', 'abcdef', ['abc']), true);
    assert.equal(applyOperator('endsWith', 'a@corp.com', ['@corp.com']), true);
    // A numeric attribute against a string operator is false, not a crash.
    assert.equal(applyOperator('contains', 42, ['4']), false);
  });

  it('matches regexes and treats an invalid pattern as non-matching', () => {
    assert.equal(applyOperator('matches', 'user-42', ['^user-\\d+$']), true);
    assert.equal(applyOperator('matches', 'nope', ['^user-\\d+$']), false);
    assert.equal(applyOperator('matches', 'anything', ['([']), false, 'invalid regex must not throw');
  });

  it('applies numeric operators only to finite numbers', () => {
    assert.equal(applyOperator('gt', 10, [5]), true);
    assert.equal(applyOperator('gte', 5, [5]), true);
    assert.equal(applyOperator('lt', 3, [5]), true);
    assert.equal(applyOperator('lte', 5, [5]), true);
    assert.equal(applyOperator('gt', '10', [5]), false, 'string attribute must not compare');
    assert.equal(applyOperator('gt', Number.NaN, [5]), false);
  });

  it('compares semantic versions', () => {
    assert.equal(applyOperator('semverGt', '2.0.0', ['1.9.9']), true);
    assert.equal(applyOperator('semverGt', '1.10.0', ['1.9.0']), true, '10 > 9, not lexicographic');
    assert.equal(applyOperator('semverLt', '1.0.0', ['1.0.1']), true);
    assert.equal(applyOperator('semverGt', 'not-a-version', ['1.0.0']), false);
  });
});

describe('semver', () => {
  it('parses and rejects', () => {
    assert.deepEqual(parseSemVer('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: '' });
    assert.deepEqual(parseSemVer('1.2.3-beta.1'), {
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: 'beta.1',
    });
    assert.equal(parseSemVer('1.2'), undefined);
    assert.equal(parseSemVer('v1.2.3'), undefined);
    assert.equal(parseSemVer(42), undefined);
  });

  it('sorts a prerelease before its release', () => {
    const beta = parseSemVer('1.0.0-beta')!;
    const release = parseSemVer('1.0.0')!;
    assert.ok(compareSemVer(beta, release) < 0);
    assert.ok(compareSemVer(release, beta) > 0);
    assert.equal(compareSemVer(release, release), 0);
  });

  it('ignores build metadata', () => {
    assert.equal(compareSemVer(parseSemVer('1.0.0+abc')!, parseSemVer('1.0.0+xyz')!), 0);
  });
});
