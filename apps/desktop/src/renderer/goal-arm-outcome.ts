import type { GoalState } from '@maka/runtime/goal-state';
import type { GoalArmOutcome } from '../shared/goal-arm.js';

export type GoalArmReconciliationNotice =
  | { readonly kind: 'matching_goal'; readonly goal: GoalState }
  | { readonly kind: 'different_goal'; readonly goal: GoalState }
  | { readonly kind: 'no_goal' }
  | { readonly kind: 'unavailable' };

export type GoalArmOutcomeAction =
  | { readonly action: 'close' }
  | { readonly action: 'lock'; readonly notice: GoalArmReconciliationNotice };

export function interpretGoalArmOutcome(
  outcome: GoalArmOutcome,
): GoalArmOutcomeAction {
  if (outcome.kind === 'armed') return { action: 'close' };
  if (outcome.kind === 'reconciliation_unavailable') {
    return { action: 'lock', notice: { kind: 'unavailable' } };
  }
  if (outcome.currentGoal === null) {
    return { action: 'lock', notice: { kind: 'no_goal' } };
  }
  return {
    action: 'lock',
    notice: {
      kind: outcome.matchesRequestedState ? 'matching_goal' : 'different_goal',
      goal: outcome.currentGoal,
    },
  };
}
