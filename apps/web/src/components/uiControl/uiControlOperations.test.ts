import {
  EnvironmentId,
  ThreadId,
  UiControlRequestId,
  type ScopedThreadRef,
  type UiControlRequest,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { executeUiControlOperation } from "./uiControlOperations";

const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");
const signal = new AbortController().signal;

const request = (overrides: Partial<UiControlRequest> = {}): UiControlRequest => ({
  requestId: UiControlRequestId.make("request-1"),
  operation: "ui.revealThread",
  input: { threadId },
  ...overrides,
});

describe("executeUiControlOperation", () => {
  it("decodes reveal input and scopes the thread to the host environment", async () => {
    const revealed: ScopedThreadRef[] = [];

    await executeUiControlOperation(
      request(),
      {
        environmentId,
        revealThread: async (threadRef, receivedSignal) => {
          expect(receivedSignal).toBe(signal);
          revealed.push(threadRef);
        },
      },
      signal,
    );

    expect(revealed).toEqual([{ environmentId, threadId }]);
  });

  it("rejects bad input without calling the operation", async () => {
    const revealThread = vi.fn(async () => undefined);

    await expect(
      executeUiControlOperation(
        request({ input: { threadId: 42 } }),
        { environmentId, revealThread },
        signal,
      ),
    ).rejects.toThrow();
    expect(revealThread).not.toHaveBeenCalled();
  });

  it("rejects an operation the host does not implement", async () => {
    const revealThread = vi.fn(async () => undefined);

    await expect(
      executeUiControlOperation(
        request({ operation: "ui.unknownOperation" as UiControlRequest["operation"] }),
        { environmentId, revealThread },
        signal,
      ),
    ).rejects.toThrow("This UI control host does not support ui.unknownOperation.");
    expect(revealThread).not.toHaveBeenCalled();
  });
});
