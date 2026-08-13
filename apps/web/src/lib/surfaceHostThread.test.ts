import { describe, expect, it } from "vite-plus/test";

import { pickSurfaceHostThread } from "./surfaceHostThread";

interface TestThread {
  readonly id: string;
  readonly environmentId: string;
  readonly projectId: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

const thread = (
  id: string,
  updatedAt: string,
  projectId = "project-a",
  environmentId = "environment-a",
  archivedAt: string | null = null,
): TestThread => ({ id, environmentId, projectId, updatedAt, archivedAt });

const project = { environmentId: "environment-a", projectId: "project-a" };
const activeIs =
  (id: string) =>
  (candidate: TestThread): boolean =>
    candidate.id === id;

describe("pickSurfaceHostThread", () => {
  it("prefers the active thread from the exact project", () => {
    const threads = [
      thread("older", "2026-06-18T10:00:00.000Z"),
      thread("active", "2026-06-18T11:00:00.000Z"),
      thread("newer", "2026-06-18T12:00:00.000Z"),
    ];

    expect(pickSurfaceHostThread(threads, project, activeIs("active"))?.id).toBe("active");
  });

  it("falls back to the newest live thread from the exact project", () => {
    const threads = [
      thread("older", "2026-06-18T10:00:00.000Z"),
      thread("newest", "2026-06-18T12:00:00.000Z"),
      thread("middle", "2026-06-18T11:00:00.000Z"),
    ];

    expect(pickSurfaceHostThread(threads, project, () => false)?.id).toBe("newest");
  });

  it("does not cross physical project boundaries", () => {
    const threads = [
      thread("other-environment", "2026-06-18T14:00:00.000Z", "project-a", "environment-b"),
      thread("other-project", "2026-06-18T13:00:00.000Z", "project-b"),
      thread("exact", "2026-06-18T10:00:00.000Z"),
    ];

    expect(pickSurfaceHostThread(threads, project, activeIs("other-environment"))?.id).toBe(
      "exact",
    );
  });

  it("ignores archived threads", () => {
    const threads = [
      thread(
        "archived",
        "2026-06-18T14:00:00.000Z",
        "project-a",
        "environment-a",
        "2026-06-18T15:00:00.000Z",
      ),
      thread("live", "2026-06-18T10:00:00.000Z"),
    ];

    expect(pickSurfaceHostThread(threads, project, activeIs("archived"))?.id).toBe("live");
  });

  it("returns null without a live exact match", () => {
    expect(
      pickSurfaceHostThread(
        [thread("other", "2026-06-18T10:00:00.000Z", "project-b")],
        project,
        () => false,
      ),
    ).toBeNull();
  });
});
