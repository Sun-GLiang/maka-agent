# Task 1 report: Preserve Session revisions across Desktop projections

## Result

Implemented Desktop projection/type plumbing for the Runtime Host Session revision. Owner catalog rows, Shared Host rows, configuration mutation summaries, and preload projections now expose a required `revision: number` (with `0` retained as the compatibility value when projecting legacy core `SessionSummary` inputs that omit it).

## TDD evidence

RED:

```text
npm exec -- tsx --test apps/desktop/src/main/__tests__/runtime-host-session-catalog-ipc-main.test.ts
✖ preserves the Session revision in Owner and Shared Desktop Host summaries
  AssertionError: undefined !== 7
```

GREEN:

```text
npm exec -- tsx --test apps/desktop/src/main/__tests__/runtime-host-session-catalog-ipc-main.test.ts apps/desktop/src/main/__tests__/desktop-session-projection.test.ts apps/desktop/src/main/__tests__/external-session-catalog-projection.test.ts
ℹ tests 10
ℹ pass 10
ℹ fail 0
```

Additional verification:

```text
npm run build:main --workspace @maka/desktop       # passed
npm run typecheck --workspace @maka/desktop        # passed
npm run build --workspace @maka/runtime-host       # passed
```

## Files

- `apps/desktop/src/main/runtime-host-session-catalog-ipc-main.ts`
- `apps/desktop/src/shared/desktop-session-projection.ts`
- `packages/runtime-host/src/client/session-catalog-summary.ts`
- Focused Desktop projection/catalog tests and affected Storybook/onboarding fixtures.

## Commit

To be filled after commit.

## Concerns

- Core `SessionSummary` remains unchanged. The shared Desktop projector accepts legacy summaries and uses revision `0` when no revision is present; authoritative Host catalog and mutation responses carry the Runtime Host revision directly.
