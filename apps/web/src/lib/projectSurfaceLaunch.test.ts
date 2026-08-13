import { describe, expect, it, vi } from "vite-plus/test";

import { openSurfaceBeforeNavigate } from "./projectSurfaceLaunch";

describe("openSurfaceBeforeNavigate", () => {
  it("navigates only after the surface opens", async () => {
    const events: string[] = [];

    const result = await openSurfaceBeforeNavigate(
      async () => {
        events.push("open");
        return { _tag: "Success" } as const;
      },
      () => events.push("navigate"),
    );

    expect(result._tag).toBe("Success");
    expect(events).toEqual(["open", "navigate"]);
  });

  it("preserves the route when opening fails", async () => {
    const navigate = vi.fn();

    const result = await openSurfaceBeforeNavigate(
      async () => ({ _tag: "Failure" }) as const,
      navigate,
    );

    expect(result._tag).toBe("Failure");
    expect(navigate).not.toHaveBeenCalled();
  });
});
