import { describe, expect, it } from "vite-plus/test";

import {
  selectActiveSurfaceProjectMember,
  selectSurfaceProjectMember,
} from "./surfaceProjectSelection";

const members = [
  { environmentId: "local", id: "project-local", workspaceRoot: "/local" },
  { environmentId: "remote", id: "project-remote", workspaceRoot: "/remote" },
];

describe("selectSurfaceProjectMember", () => {
  it("uses the active thread's exact physical project", () => {
    expect(
      selectSurfaceProjectMember(
        members,
        { environmentId: "local", projectId: "project-local" },
        { environmentId: "remote", projectId: "project-remote" },
      ),
    ).toEqual(members[1]);
  });

  it("uses the representative when the active thread is outside the group", () => {
    expect(
      selectSurfaceProjectMember(
        members,
        { environmentId: "remote", projectId: "project-remote" },
        { environmentId: "other", projectId: "other-project" },
      ),
    ).toEqual(members[1]);
  });

  it("returns null for an empty group", () => {
    expect(
      selectSurfaceProjectMember([], { environmentId: "local", projectId: "project-local" }, null),
    ).toBeNull();
  });
});

describe("selectActiveSurfaceProjectMember", () => {
  it("enables at most the group that owns the active thread", () => {
    const groups = [
      {
        members: [members[0]!],
        threads: [{ key: "local:thread-1", environmentId: "local", projectId: "project-local" }],
      },
      {
        members: [members[1]!],
        threads: [{ key: "remote:thread-2", environmentId: "remote", projectId: "project-remote" }],
      },
    ];

    const selected = groups.map((group) =>
      selectActiveSurfaceProjectMember(
        group.members,
        group.threads,
        "remote:thread-2",
        (thread) => thread.key,
      ),
    );

    expect(selected.filter(Boolean)).toEqual([members[1]]);
  });
});
