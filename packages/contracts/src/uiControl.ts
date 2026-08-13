import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  ForwardCompatibleArray,
  ThreadId,
  TrimmedNonEmptyString,
  UiControlRequestId,
} from "./baseSchemas.ts";

export const UI_CONTROL_OPERATIONS = ["ui.revealThread"] as const;

export const UiControlOperation = Schema.Literals(UI_CONTROL_OPERATIONS);
export type UiControlOperation = typeof UiControlOperation.Type;

export const UiRevealThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type UiRevealThreadInput = typeof UiRevealThreadInput.Type;

export const UiControlClientId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type UiControlClientId = typeof UiControlClientId.Type;
export const UiControlConnectionId = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
export type UiControlConnectionId = typeof UiControlConnectionId.Type;

export const UiControlHost = Schema.Struct({
  clientId: UiControlClientId,
  environmentId: EnvironmentId,
  supportedOperations: ForwardCompatibleArray(UiControlOperation),
});
export type UiControlHost = typeof UiControlHost.Type;

export const UiControlHostFocus = Schema.Struct({
  clientId: UiControlClientId,
  environmentId: EnvironmentId,
  connectionId: UiControlConnectionId,
  focused: Schema.Boolean,
});
export type UiControlHostFocus = typeof UiControlHostFocus.Type;

export const UiControlRequest = Schema.Struct({
  requestId: UiControlRequestId,
  operation: UiControlOperation,
  input: Schema.Unknown,
});
export type UiControlRequest = typeof UiControlRequest.Type;

export const UiControlStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("connected"),
    connectionId: UiControlConnectionId,
  }),
  Schema.Struct({
    type: Schema.Literal("request"),
    connectionId: UiControlConnectionId,
    request: UiControlRequest,
  }),
  Schema.Struct({
    type: Schema.Literal("cancel"),
    connectionId: UiControlConnectionId,
    requestId: UiControlRequestId,
  }),
]);
export type UiControlStreamEvent = typeof UiControlStreamEvent.Type;

export const UiControlResponse = Schema.Struct({
  clientId: UiControlClientId,
  connectionId: UiControlConnectionId,
  requestId: UiControlRequestId,
  ok: Schema.Boolean,
  error: Schema.optional(TrimmedNonEmptyString),
});
export type UiControlResponse = typeof UiControlResponse.Type;

export const UiControlInvocation = Schema.Struct({
  operation: UiControlOperation,
  input: Schema.Unknown,
});
export type UiControlInvocation = typeof UiControlInvocation.Type;

export const UiControlInvokeResult = Schema.Union([
  Schema.Struct({ delivered: Schema.Literal(true) }),
  Schema.Struct({
    delivered: Schema.Literal(false),
    error: TrimmedNonEmptyString,
  }),
]);
export type UiControlInvokeResult = typeof UiControlInvokeResult.Type;
