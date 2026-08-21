import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deriveFailedTurnRecovery } from '../../renderer/session-status-presentation.js';

const outputFreeFailure = {
  partialOutputRetained: false,
  toolActivityCount: 0,
  erroredToolCount: 0,
};

describe('failed turn recovery presentation', () => {
  it('does not recommend a byte-identical retry after context overflow', () => {
    assert.deepEqual(
      deriveFailedTurnRecovery({ ...outputFreeFailure, errorClass: 'context_overflow' }, 'zh'),
      { action: 'continue', label: '上下文仍超出限制，请减少附件或开启新任务' },
    );
    assert.deepEqual(
      deriveFailedTurnRecovery({ ...outputFreeFailure, errorClass: 'context_overflow' }, 'en'),
      {
        action: 'continue',
        label: 'Context is still too large; reduce attachments or start a new task',
      },
    );
  });

  it('keeps the generic retry fallback for an unknown output-free failure', () => {
    assert.deepEqual(
      deriveFailedTurnRecovery({ ...outputFreeFailure, errorClass: 'unknown_failure' }, 'en'),
      { action: 'retry', label: 'No tools ran; retry directly' },
    );
  });

  it('preserves higher-priority retained-output and tool guidance', () => {
    assert.deepEqual(
      deriveFailedTurnRecovery(
        { ...outputFreeFailure, errorClass: 'context_overflow', partialOutputRetained: true },
        'en',
      ),
      { action: 'continue', label: 'Partial output was retained; continue from here' },
    );
    assert.deepEqual(
      deriveFailedTurnRecovery(
        { ...outputFreeFailure, errorClass: 'context_overflow', toolActivityCount: 1 },
        'en',
      ),
      { action: 'inspect_tool', label: 'Tool history was retained; inspect it before retrying' },
    );
    assert.deepEqual(
      deriveFailedTurnRecovery(
        { ...outputFreeFailure, errorClass: 'context_overflow', erroredToolCount: 1 },
        'en',
      ),
      { action: 'inspect_tool', label: 'Inspect the tool result before retrying' },
    );
  });
});
