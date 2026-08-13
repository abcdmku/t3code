import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { SidebarProjectSurfaces } from "./SidebarProjectSurfaces";

const surfaces = [
  { name: "Board", url: "http://127.0.0.1:4000/" },
  { name: "Board", url: "http://127.0.0.1:5000/", icon: "test" },
];

describe("SidebarProjectSurfaces", () => {
  it("renders duplicate names as keyboard buttons", () => {
    const html = renderToStaticMarkup(
      <SidebarProjectSurfaces surfaces={surfaces} browserAvailable onOpenSurface={vi.fn()} />,
    );

    expect(html.match(/<button/g)).toHaveLength(2);
    expect(html.match(/Open custom project surface Board/g)).toHaveLength(2);
  });

  it("keeps unavailable entries focusable and marks them disabled", () => {
    const html = renderToStaticMarkup(
      <SidebarProjectSurfaces
        surfaces={[surfaces[0]!]}
        browserAvailable={false}
        onOpenSurface={vi.fn()}
      />,
    );

    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toContain(" disabled=");
  });
});
