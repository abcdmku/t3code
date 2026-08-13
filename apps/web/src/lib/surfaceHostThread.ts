/** Pick a host thread from the exact physical project that supplied `t3.json`. */
export function pickSurfaceHostThread<
  T extends {
    readonly environmentId: string;
    readonly projectId: string;
    readonly updatedAt: string;
    readonly archivedAt: string | null;
  },
>(
  threads: readonly T[],
  project: { readonly environmentId: string; readonly projectId: string },
  isActiveThread: (thread: T) => boolean,
): T | null {
  const candidates = threads.filter(
    (thread) =>
      thread.archivedAt === null &&
      thread.environmentId === project.environmentId &&
      thread.projectId === project.projectId,
  );
  return (
    candidates.find(isActiveThread) ??
    candidates.reduce<T | null>(
      (freshest, thread) =>
        freshest === null || thread.updatedAt > freshest.updatedAt ? thread : freshest,
      null,
    )
  );
}
