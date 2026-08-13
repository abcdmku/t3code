import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  UiRevealThreadInput,
  type EnvironmentId,
  type ScopedThreadRef,
  type UiControlRequest,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeRevealThreadInput = Schema.decodeUnknownSync(UiRevealThreadInput);

export interface UiControlOperationContext {
  readonly environmentId: EnvironmentId;
  readonly revealThread: (threadRef: ScopedThreadRef, signal: AbortSignal) => Promise<void>;
}

export async function executeUiControlOperation(
  request: UiControlRequest,
  context: UiControlOperationContext,
  signal: AbortSignal,
): Promise<void> {
  switch (request.operation) {
    case "ui.revealThread": {
      const input = decodeRevealThreadInput(request.input);
      await context.revealThread(scopeThreadRef(context.environmentId, input.threadId), signal);
      return;
    }
    default:
      throw new Error(`This UI control host does not support ${String(request.operation)}.`);
  }
}
