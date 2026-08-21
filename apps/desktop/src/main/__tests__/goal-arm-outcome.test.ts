import assert from 'node:assert/strict';
import test from 'node:test';
import type { GoalArmOutcome } from '../../shared/goal-arm.js';
import { interpretGoalArmOutcome } from '../../renderer/goal-arm-outcome.js';
import { getShellCopy } from '../../renderer/locales/shell-copy.js';

test('successful Goal arming closes while every reconciliation result locks the form', () => {
  const goal = {
    id: 'goal-1',
    revision: 1,
    sessionId: 'session-1',
    condition: 'All tests pass',
    status: 'active' as const,
    setAt: 1,
    iterations: 0,
    maxIterations: 50,
    consecutiveNoProgress: 0,
    blockCap: 8,
    tokensAtStart: 0,
    tokensNow: 0,
    tokensBaselinePending: false,
  };
  const cases: Array<{
    outcome: GoalArmOutcome;
    expected: ReturnType<typeof interpretGoalArmOutcome>;
  }> = [
    {
      outcome: { kind: 'armed', goal },
      expected: { action: 'close' },
    },
    {
      outcome: {
        kind: 'reconciled',
        currentGoal: goal,
        matchesRequestedState: true,
      },
      expected: { action: 'lock', notice: { kind: 'matching_goal', goal } },
    },
    {
      outcome: {
        kind: 'reconciled',
        currentGoal: goal,
        matchesRequestedState: false,
      },
      expected: { action: 'lock', notice: { kind: 'different_goal', goal } },
    },
    {
      outcome: {
        kind: 'reconciled',
        currentGoal: null,
        matchesRequestedState: false,
      },
      expected: { action: 'lock', notice: { kind: 'no_goal' } },
    },
    {
      outcome: { kind: 'reconciliation_unavailable' },
      expected: { action: 'lock', notice: { kind: 'unavailable' } },
    },
  ];

  for (const { outcome, expected } of cases) {
    assert.deepEqual(interpretGoalArmOutcome(outcome), expected);
  }
});

test('Goal reconciliation copy explains authoritative state in Chinese and English', () => {
  const zh = getShellCopy('zh').goalDialog;
  assert.match(
    zh.reconciledMatching('所有测试通过', zh.statusLabels.active),
    /所有测试通过.*进行中.*无法确认.*提交/,
  );
  assert.match(zh.reconciledNoGoal, /未读到 Goal/);
  assert.match(zh.reconciliationUnavailable, /不会重复提交/);

  const en = getShellCopy('en').goalDialog;
  assert.match(
    en.reconciledDifferent('All tests pass', en.statusLabels.paused),
    /All tests pass.*Paused.*differs/,
  );
  assert.match(en.reconciliationUnavailable, /will not submit twice/);
});
