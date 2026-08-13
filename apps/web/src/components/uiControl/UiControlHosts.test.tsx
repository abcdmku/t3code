import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createUiControlHostRegistration,
  environmentSupportsUiControl,
  subscribeUiControlFocusEvents,
} from "./UiControlHosts";

describe("UI control host registration", () => {
  it.each([
    ["missing", {}, false],
    ["false", { uiControl: false }, false],
    ["true", { uiControl: true }, true],
  ] as const)("treats the %s capability as supported: %s", (_label, capabilities, expected) => {
    expect(
      environmentSupportsUiControl({
        serverConfig: {
          environment: { capabilities },
        },
      }),
    ).toBe(expected);
  });

  it("does not register before a server descriptor is available", () => {
    expect(environmentSupportsUiControl({ serverConfig: null })).toBe(false);
  });

  it("advertises the supported operation and environment", () => {
    expect(
      createUiControlHostRegistration(EnvironmentId.make("environment-1"), "ui-host-1"),
    ).toEqual({
      clientId: "ui-host-1",
      environmentId: "environment-1",
      supportedOperations: ["ui.revealThread"],
    });
  });
});

describe("UI control host focus events", () => {
  it("reports the initial state and removes both listeners", () => {
    const target = new EventTarget();
    const report = vi.fn();
    const unsubscribe = subscribeUiControlFocusEvents(target, report);

    target.dispatchEvent(new Event("focus"));
    target.dispatchEvent(new Event("blur"));
    expect(report).toHaveBeenCalledTimes(3);

    unsubscribe();
    target.dispatchEvent(new Event("focus"));
    target.dispatchEvent(new Event("blur"));
    expect(report).toHaveBeenCalledTimes(3);
  });
});
