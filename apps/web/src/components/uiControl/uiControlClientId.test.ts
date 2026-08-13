import { describe, expect, it } from "vite-plus/test";

import { createUiControlClientId } from "./uiControlClientId";

describe("createUiControlClientId", () => {
  it("creates a bounded random identity for each host lifetime", () => {
    const clientIds = Array.from({ length: 32 }, createUiControlClientId);

    expect(new Set(clientIds).size).toBe(clientIds.length);
    expect(clientIds.every((clientId) => clientId.startsWith("ui-host-"))).toBe(true);
    expect(clientIds.every((clientId) => clientId.length <= 128)).toBe(true);
  });
});
