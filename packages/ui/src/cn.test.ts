import { describe, expect, it } from "vite-plus/test";

import { cn } from "./cn";

describe("cn", () => {
  it("merges conflicting tailwind utilities with the last one winning", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
  });

  it("flattens conditional and array inputs", () => {
    expect(cn("text-sm", false, ["font-semibold", undefined], { hidden: false })).toBe(
      "text-sm font-semibold",
    );
  });
});
