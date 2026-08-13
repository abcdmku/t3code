import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentThreadShells } from "~/state/threads";

export interface UiControlThreadShellStore {
  readonly getThreadShell: (ref: ScopedThreadRef) => EnvironmentThreadShell | null;
  readonly subscribeThreadShell: (
    ref: ScopedThreadRef,
    listener: (shell: EnvironmentThreadShell | null) => void,
  ) => () => void;
}

export const appUiControlThreadShellStore: UiControlThreadShellStore = {
  getThreadShell: (ref) => appAtomRegistry.get(environmentThreadShells.threadShellAtom(ref)),
  subscribeThreadShell: (ref, listener) =>
    appAtomRegistry.subscribe(environmentThreadShells.threadShellAtom(ref), listener),
};

export const UI_CONTROL_REVEAL_THREAD_WAIT_TIMEOUT_MS = 10_000;

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

export async function waitForKnownThread(
  threadRef: ScopedThreadRef,
  store: UiControlThreadShellStore,
  timeoutMs = UI_CONTROL_REVEAL_THREAD_WAIT_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  if (store.getThreadShell(threadRef) !== null) {
    return true;
  }

  return await new Promise<boolean>((resolve, reject) => {
    let settled = false;
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;

    const cleanup = () => {
      if (timeoutId !== null) {
        globalThis.clearTimeout(timeoutId);
        timeoutId = null;
      }
      unsubscribe?.();
      unsubscribe = null;
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal === undefined ? undefined : abortReason(signal));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) {
      onAbort();
      return;
    }

    unsubscribe = store.subscribeThreadShell(threadRef, (shell) => {
      if (shell !== null) finish(true);
    });
    if (settled) {
      unsubscribe();
      unsubscribe = null;
      return;
    }

    // A shell can land after the first read but before the subscription starts.
    if (store.getThreadShell(threadRef) !== null) {
      finish(true);
      return;
    }

    timeoutId = globalThis.setTimeout(() => finish(false), timeoutMs);
  });
}

export async function revealThreadWhenKnown(options: {
  readonly threadRef: ScopedThreadRef;
  readonly store: UiControlThreadShellStore;
  readonly navigate: (threadRef: ScopedThreadRef) => Promise<void>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const known = await waitForKnownThread(
    options.threadRef,
    options.store,
    options.timeoutMs,
    options.signal,
  );
  options.signal?.throwIfAborted();
  if (!known) {
    throw new Error(
      `Thread ${options.threadRef.threadId} was not found in environment ${options.threadRef.environmentId}.`,
    );
  }

  await options.navigate(options.threadRef);
}
