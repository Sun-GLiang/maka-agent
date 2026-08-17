import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { SESSION_STATUSES, isSessionStatus } from '../session.js';

describe('session status contract', () => {
  it('accepts only the current ordered session status collection', () => {
    assert.deepEqual(SESSION_STATUSES, [
      'active',
      'running',
      'waiting_for_user',
      'blocked',
      'archived',
      'aborted',
    ]);
    assert.equal(isSessionStatus('review'), false);
    assert.equal(isSessionStatus('done'), false);
  });
});
