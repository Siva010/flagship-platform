/**
 * Runs the shared conformance fixture against the TypeScript SDK.
 *
 * Imports @flagship/core through its package entry point rather than its source,
 * so this exercises the artifact consumers actually install. Requires a build.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUCKET_SPACE, bucketFor, bucketingInput, murmurHash3x86_32String } from '@flagship/core';

interface ConformanceCase {
  flagKey: string;
  salt: string;
  bucketKey: string;
  input: string;
  hash: number;
  expectedBucket: number;
}

interface ConformanceFixture {
  version: number;
  bucketSpace: number;
  cases: ConformanceCase[];
}

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, '..', '..', '..', 'spec', 'conformance', 'bucketing.json');

const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as ConformanceFixture;

if (!fixture.cases?.length) {
  console.error('Fixture contains no cases. Regenerate with `npm run fixture:generate`.');
  process.exit(1);
}

if (fixture.bucketSpace !== BUCKET_SPACE) {
  console.error(`Bucket space mismatch: fixture=${fixture.bucketSpace} sdk=${BUCKET_SPACE}`);
  process.exit(1);
}

const failures: string[] = [];

for (const testCase of fixture.cases) {
  const { flagKey, salt, bucketKey } = testCase;

  const input = bucketingInput(flagKey, salt, bucketKey);
  if (input !== testCase.input) {
    failures.push(`input: got ${JSON.stringify(input)}, want ${JSON.stringify(testCase.input)}`);
    continue;
  }

  const hash = murmurHash3x86_32String(testCase.input, 0);
  if (hash !== testCase.hash) {
    failures.push(`hash for ${JSON.stringify(input)}: got ${hash}, want ${testCase.hash}`);
    continue;
  }

  const bucket = bucketFor(flagKey, salt, bucketKey);
  if (bucket !== testCase.expectedBucket) {
    failures.push(
      `bucket for ${JSON.stringify(input)}: got ${bucket}, want ${testCase.expectedBucket}`,
    );
  }
}

if (failures.length > 0) {
  console.error(`Conformance FAILED: ${failures.length} of ${fixture.cases.length} cases\n`);
  for (const failure of failures.slice(0, 20)) console.error(`  ${failure}`);
  if (failures.length > 20) console.error(`  ... and ${failures.length - 20} more`);
  process.exit(1);
}

console.log(`Conformance OK: ${fixture.cases.length} cases verified against @flagship/core`);
