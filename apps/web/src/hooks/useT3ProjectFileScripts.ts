import {
  EnvironmentId,
  T3_PROJECT_FILE_NAME,
  type T3ProjectFile,
  type T3ProjectFileScript,
  type T3ProjectFileSurface,
} from "@t3tools/contracts";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import { useMemo } from "react";

import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";

const NO_SCRIPTS: ReadonlyArray<T3ProjectFileScript> = [];
const NO_SURFACES: ReadonlyArray<T3ProjectFileSurface> = [];
const DISABLED_ENVIRONMENT_ID = EnvironmentId.make("environment-disabled");

export interface T3ProjectFileState {
  /**
   * - `valid`: t3.json exists and decoded.
   * - `invalid`: t3.json exists but fails to decode (the server then ignores
   *   the whole file, including `iconPath` and every script).
   * - `missing`: no readable t3.json at the workspace root.
   * - `loading`: the file query has not settled yet.
   */
  status: "loading" | "missing" | "invalid" | "valid";
  /** The decoded file when status is `valid`, null otherwise. */
  file: T3ProjectFile | null;
  scripts: ReadonlyArray<T3ProjectFileScript>;
  surfaces: ReadonlyArray<T3ProjectFileSurface>;
}

/**
 * Decoded state of the project's checked-in `t3.json`, including whether the
 * file exists but is broken. The runtime otherwise ignores that error.
 */
export function useT3ProjectFileState(
  environmentId: EnvironmentId | null,
  cwd: string | null,
  enabled = true,
): T3ProjectFileState {
  const query = useProjectFileQuery(
    environmentId ?? DISABLED_ENVIRONMENT_ID,
    cwd ?? "",
    T3_PROJECT_FILE_NAME,
    enabled && environmentId !== null && cwd !== null,
  );
  const contents = query.data && !query.data.truncated ? query.data.contents : null;
  const isPending = query.isPending;
  return useMemo(() => {
    if (contents === null) {
      return {
        status: isPending ? "loading" : "missing",
        file: null,
        scripts: NO_SCRIPTS,
        surfaces: NO_SURFACES,
      } as const;
    }
    const file = parseT3ProjectFile(contents);
    if (file === null) {
      return {
        status: "invalid",
        file: null,
        scripts: NO_SCRIPTS,
        surfaces: NO_SURFACES,
      } as const;
    }
    return {
      status: "valid",
      file,
      scripts: file.scripts ?? NO_SCRIPTS,
      surfaces: file.surfaces ?? NO_SURFACES,
    } as const;
  }, [contents, isPending]);
}

/**
 * Scripts declared in the project's checked-in `t3.json`, offered in the
 * scripts menu for import. Missing, truncated, or invalid files resolve to
 * an empty list.
 */
export function useT3ProjectFileScripts(
  environmentId: EnvironmentId,
  cwd: string | null,
): ReadonlyArray<T3ProjectFileScript> {
  return useT3ProjectFileState(environmentId, cwd).scripts;
}

export function useT3ProjectFileSurfaces(
  environmentId: EnvironmentId | null,
  cwd: string | null,
  enabled = true,
): ReadonlyArray<T3ProjectFileSurface> {
  return useT3ProjectFileState(environmentId, cwd, enabled).surfaces;
}
