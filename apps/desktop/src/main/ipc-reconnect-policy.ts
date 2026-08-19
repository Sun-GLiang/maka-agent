import type { IpcMain } from "electron";
import type { Result } from "@maka/core/result";
import {
  RuntimeHostOperationError,
  RuntimeHostRequestInterruptedError,
} from "@maka/runtime-host/client";
import { HOST_OPERATION_SPECS } from "@maka/runtime-host/protocol";

export type IpcHandler = Parameters<IpcMain["handle"]>[1];

export type ReconciledControlStep<Context, Result> =
  | { readonly kind: "completed"; readonly value: Result }
  | { readonly kind: "reconcile"; readonly context: Context };

export interface ReconciledControlHandlers<Context, Result> {
  dispatch(
    event: Parameters<IpcHandler>[0],
    ...args: unknown[]
  ): Promise<ReconciledControlStep<Context, Result>>;
  reconcile(
    context: Context,
    event: Parameters<IpcHandler>[0],
    ...args: unknown[]
  ): Promise<Result>;
}

export interface ReconnectableReadIpcMain extends Pick<IpcMain, "handle"> {
  handleReconnectableRead?(channel: string, listener: IpcHandler): void;
  handleReconciledControl?<Context, Result>(
    channel: string,
    handlers: ReconciledControlHandlers<Context, Result>,
  ): void;
}

export function handleReconnectableRead(
  ipcMain: ReconnectableReadIpcMain,
  channel: string,
  listener: IpcHandler,
): void {
  if (ipcMain.handleReconnectableRead) {
    ipcMain.handleReconnectableRead(channel, listener);
  } else {
    ipcMain.handle(channel, listener);
  }
}

export function handleReconciledControl<Context, Result>(
  ipcMain: ReconnectableReadIpcMain,
  channel: string,
  handlers: ReconciledControlHandlers<Context, Result>,
): void {
  if (ipcMain.handleReconciledControl) {
    ipcMain.handleReconciledControl(channel, handlers);
    return;
  }
  ipcMain.handle(channel, async (event, ...args) => {
    const step = await handlers.dispatch(event, ...args);
    return step.kind === "completed"
      ? step.value
      : handlers.reconcile(step.context, event, ...args);
  });
}

export function isReconnectableReadFailure(error: unknown): boolean {
  return (
    (error instanceof RuntimeHostOperationError &&
      error.code === "host_draining" &&
      HOST_OPERATION_SPECS[error.operation].mode === "query") ||
    (error instanceof RuntimeHostRequestInterruptedError &&
      error.retryable &&
      error.reason === "connection_lost")
  );
}

export function isDispatchedControlConnectionLoss(error: unknown): boolean {
  return (
    error instanceof RuntimeHostRequestInterruptedError &&
    error.mode === "control" &&
    error.dispatch === "dispatched" &&
    error.reason === "connection_lost"
  );
}

export function rethrowReconnectableReadFailure(error: unknown): void {
  if (isReconnectableReadFailure(error)) throw error;
}

export async function readWithFallback<T>(
  read: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    rethrowReconnectableReadFailure(error);
    return fallback;
  }
}

export async function tryReconnectableReadResult<T>(
  read: () => Promise<T>,
  errorCode: string,
): Promise<Result<T>> {
  try {
    return { ok: true, data: await read() };
  } catch (error) {
    rethrowReconnectableReadFailure(error);
    return {
      ok: false,
      error: {
        code: errorCode,
        message: error instanceof Error ? error.message : String(error),
        details: error,
      },
    };
  }
}
