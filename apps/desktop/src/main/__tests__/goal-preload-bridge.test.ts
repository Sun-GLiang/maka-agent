import assert from 'node:assert/strict';
import test from 'node:test';
import {
  invokeProjectedSessionRuntimeHost,
} from '../../preload/projected-session-runtime-host.js';
import { desktopSessionKey } from '../../shared/runtime-host-identity.js';

test('Goal arm preload routing preserves target scope and projects every outcome', async () => {
  const scope = { hostId: 'host-1', targetEpoch: 'epoch-2' };
  const desktopSessionId = desktopSessionKey({
    hostId: scope.hostId,
    sessionId: 'session-1',
  });
  const request = { condition: 'Finish', maxIterations: 20, tokenBudget: 1_000 };
  const scenarios = [
    {
      wire: {
        kind: 'armed',
        goal: { id: 'goal-1', sessionId: 'session-1' },
      },
      projected: {
        kind: 'armed',
        goal: { id: 'goal-1', sessionId: desktopSessionId },
      },
    },
    {
      wire: {
        kind: 'reconciled',
        currentGoal: { id: 'goal-2', sessionId: 'session-1' },
        matchesRequestedState: true,
      },
      projected: {
        kind: 'reconciled',
        currentGoal: { id: 'goal-2', sessionId: desktopSessionId },
        matchesRequestedState: true,
      },
    },
    {
      wire: { kind: 'reconciliation_unavailable' },
      projected: { kind: 'reconciliation_unavailable' },
    },
  ] as const;

  for (const scenario of scenarios) {
    const invocations: unknown[] = [];
    const result = await invokeProjectedSessionRuntimeHost(
      async (sessionId) => {
        assert.equal(sessionId, desktopSessionId);
        return { scope, sessionId: 'session-1' };
      },
      async (channel, targetScope, rawSessionId, ...args) => {
        invocations.push({ channel, targetScope, rawSessionId, args });
        return scenario.wire;
      },
      'goal:arm',
      desktopSessionId,
      request,
    );

    assert.deepEqual(invocations, [
      {
        channel: 'goal:arm',
        targetScope: scope,
        rawSessionId: 'session-1',
        args: [request],
      },
    ]);
    assert.deepEqual(result, scenario.projected);
  }
});
