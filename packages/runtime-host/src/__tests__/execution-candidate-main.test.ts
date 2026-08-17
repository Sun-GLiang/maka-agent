import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const CANDIDATE_ENTRYPOINT = fileURLToPath(
  new URL('../execution-candidate-main.js', import.meta.url),
);
const ROOT_ID = 'a'.repeat(64);

test('classifies invalid candidate arguments as an internal startup failure', () => {
  const result = spawnSync(
    process.execPath,
    [
      CANDIDATE_ENTRYPOINT,
      '--root',
      '/tmp/workspace',
      '--expected-root-id',
      ROOT_ID,
      '--desktop-e2e',
      'true',
    ],
    { encoding: 'utf8', timeout: 10_000 },
  );

  assert.equal(result.status, 70, result.stderr);
  assert.match(result.stderr, /\[runtime-host\] startup failed:/);
  assert.match(result.stderr, /Invalid --desktop-e2e/);
});
