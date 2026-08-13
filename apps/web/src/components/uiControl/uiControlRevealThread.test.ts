import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  UI_CONTROL_REVEAL_THREAD_WAIT_TIMEOUT_MS,
  revealThreadWhenKnown,
  type UiControlThreadShellStore,
} from "./uiControlRevealThread";

const threadRef: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};
const shell = { id: threadRef.threadId } as EnvironmentThreadShell;

function createStore(initial: EnvironmentThreadShell | null) {
  let current = initial;
  const listeners = new Set<(shell: EnvironmentThreadShell | null) => void>();
  const store: UiControlThreadShellStore = {
    getThreadShell: vi.fn(() => current),
    subscribeThreadShell: vi.fn((_ref, listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };

  return {
    store,
    listenerCount: () => listeners.size,
    emit: (next: EnvironmentThreadShell | null) => {
      current = next;
      for (const listener of listeners) listener(next);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("revealThreadWhenKnown", () => {
  it("navigates immediately when the thread is already known", async () => {
    vi.useFakeTimers();
    const { store } = createStore(shell);
    const navigate = vi.fn(async () => undefined);

    await revealThreadWhenKnown({ threadRef, store, navigate });

    expect(navigate).toHaveBeenCalledExactlyOnceWith(threadRef);
    expect(store.subscribeThreadShell).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for a delayed shell, then clears its listener and timer", async () => {
    vi.useFakeTimers();
    const { store, emit, listenerCount } = createStore(null);
    const navigate = vi.fn(async () => undefined);

    const pending = revealThreadWhenKnown({ threadRef, store, navigate });
    expect(listenerCount()).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    emit(shell);
    await pending;

    expect(navigate).toHaveBeenCalledExactlyOnceWith(threadRef);
    expect(listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes the race between the first read and subscribing", async () => {
    vi.useFakeTimers();
    const { store, listenerCount } = createStore(null);
    let current: EnvironmentThreadShell | null = null;
    const racingStore: UiControlThreadShellStore = {
      getThreadShell: () => current,
      subscribeThreadShell: (ref, listener) => {
        current = shell;
        return store.subscribeThreadShell(ref, listener);
      },
    };
    const navigate = vi.fn(async () => undefined);

    await revealThreadWhenKnown({ threadRef, store: racingStore, navigate });

    expect(navigate).toHaveBeenCalledExactlyOnceWith(threadRef);
    expect(listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out after ten seconds and cleans up without navigating", async () => {
    vi.useFakeTimers();
    const { store, listenerCount } = createStore(null);
    const navigate = vi.fn(async () => undefined);

    const pending = revealThreadWhenKnown({ threadRef, store, navigate });
    const outcome = expect(pending).rejects.toThrow(
      "Thread thread-1 was not found in environment environment-1.",
    );
    await vi.advanceTimersByTimeAsync(UI_CONTROL_REVEAL_THREAD_WAIT_TIMEOUT_MS);
    await outcome;

    expect(UI_CONTROL_REVEAL_THREAD_WAIT_TIMEOUT_MS).toBe(10_000);
    expect(navigate).not.toHaveBeenCalled();
    expect(listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts the wait, clears resources, and never navigates", async () => {
    vi.useFakeTimers();
    const { store, emit, listenerCount } = createStore(null);
    const navigate = vi.fn(async () => undefined);
    const controller = new AbortController();

    const pending = revealThreadWhenKnown({
      threadRef,
      store,
      navigate,
      signal: controller.signal,
    });
    expect(listenerCount()).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    emit(shell);

    expect(navigate).not.toHaveBeenCalled();
    expect(listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not navigate when cancellation follows the matching shell event", async () => {
    vi.useFakeTimers();
    const { store, emit, listenerCount } = createStore(null);
    const navigate = vi.fn(async () => undefined);
    const controller = new AbortController();

    const pending = revealThreadWhenKnown({
      threadRef,
      store,
      navigate,
      signal: controller.signal,
    });
    emit(shell);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });

    expect(navigate).not.toHaveBeenCalled();
    expect(listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
