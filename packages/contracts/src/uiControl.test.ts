import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";

import {
  UiControlHost,
  UiControlInvocation,
  UiControlInvokeResult,
  UiControlResponse,
  UiControlStreamEvent,
  UiRevealThreadInput,
} from "./uiControl.ts";

describe("UI control contracts", () => {
  it("drops unknown host operations", () => {
    const host = Schema.decodeUnknownSync(UiControlHost)({
      clientId: "web-window-1",
      environmentId: "environment-1",
      supportedOperations: ["ui.futureOperation", "ui.revealThread", 42],
    });

    expect(host.supportedOperations).toEqual(["ui.revealThread"]);
  });

  it("keeps request input opaque until the host decodes it", () => {
    const event = Schema.decodeUnknownSync(UiControlStreamEvent)({
      type: "request",
      connectionId: "connection-1",
      request: {
        requestId: "ui-1",
        operation: "ui.revealThread",
        input: { threadId: "thread-1", futureField: true },
      },
    });

    expect(event.type).toBe("request");
    if (event.type === "request") {
      expect(event.request.input).toEqual({ threadId: "thread-1", futureField: true });
    }
  });

  it("decodes request cancellation", () => {
    expect(
      Schema.decodeUnknownSync(UiControlStreamEvent)({
        type: "cancel",
        connectionId: "connection-1",
        requestId: "ui-1",
      }),
    ).toEqual({ type: "cancel", connectionId: "connection-1", requestId: "ui-1" });
  });

  it("validates reveal thread input at the host", () => {
    expect(Schema.decodeUnknownSync(UiRevealThreadInput)({ threadId: "thread-1" })).toEqual({
      threadId: "thread-1",
    });
    expect(() => Schema.decodeUnknownSync(UiRevealThreadInput)({ threadId: "" })).toThrow();
  });

  it("rejects unknown invocation operations", () => {
    expect(() =>
      Schema.decodeUnknownSync(UiControlInvocation)({
        operation: "ui.futureOperation",
        input: {},
      }),
    ).toThrow();
  });

  it("requires host identity on responses", () => {
    expect(() =>
      Schema.decodeUnknownSync(UiControlResponse)({ requestId: "ui-1", ok: true }),
    ).toThrow();
  });

  it("uses delivered as the invoke result discriminator", () => {
    expect(Schema.decodeUnknownSync(UiControlInvokeResult)({ delivered: true })).toEqual({
      delivered: true,
    });
    expect(
      Schema.decodeUnknownSync(UiControlInvokeResult)({ delivered: false, error: "No host." }),
    ).toEqual({ delivered: false, error: "No host." });
    expect(() => Schema.decodeUnknownSync(UiControlInvokeResult)({ delivered: false })).toThrow();
    expect(
      Schema.decodeUnknownSync(UiControlInvokeResult)({ delivered: true, error: "Ignored." }),
    ).toEqual({ delivered: true });
  });
});
