import { describe, expect, it } from "@effect/vitest";

import { uiControlHostFocusConcurrencyKey, uiControlRespondConcurrencyKey } from "./uiControl.ts";

describe("UI control state commands", () => {
  it("separates matching request ids from replacement connections", () => {
    const first = uiControlRespondConcurrencyKey({
      environmentId: "environment-1",
      input: { connectionId: "connection-1", requestId: "request-1" },
    });
    const replacement = uiControlRespondConcurrencyKey({
      environmentId: "environment-1",
      input: { connectionId: "connection-2", requestId: "request-1" },
    });

    expect(first).not.toBe(replacement);
  });

  it("separates focus updates from replacement connections", () => {
    const first = uiControlHostFocusConcurrencyKey({
      environmentId: "environment-1",
      input: { clientId: "client-1", connectionId: "connection-1" },
    });
    const replacement = uiControlHostFocusConcurrencyKey({
      environmentId: "environment-1",
      input: { clientId: "client-1", connectionId: "connection-2" },
    });

    expect(first).not.toBe(replacement);
  });
});
