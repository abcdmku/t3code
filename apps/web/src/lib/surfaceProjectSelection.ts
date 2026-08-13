export function selectSurfaceProjectMember<
  TMember extends { readonly environmentId: string; readonly id: string },
>(
  members: readonly TMember[],
  representative: { readonly environmentId: string; readonly projectId: string },
  activeThread: { readonly environmentId: string; readonly projectId: string } | null,
): TMember | null {
  if (activeThread) {
    const activeMember = members.find(
      (member) =>
        member.environmentId === activeThread.environmentId && member.id === activeThread.projectId,
    );
    if (activeMember) return activeMember;
  }
  return (
    members.find(
      (member) =>
        member.environmentId === representative.environmentId &&
        member.id === representative.projectId,
    ) ??
    members[0] ??
    null
  );
}

export function selectActiveSurfaceProjectMember<
  TMember extends { readonly environmentId: string; readonly id: string },
  TThread extends { readonly environmentId: string; readonly projectId: string },
>(
  members: readonly TMember[],
  threads: readonly TThread[],
  activeThreadKey: string | null,
  threadKey: (thread: TThread) => string,
): TMember | null {
  if (activeThreadKey === null) return null;
  const activeThread = threads.find((thread) => threadKey(thread) === activeThreadKey);
  if (!activeThread) return null;
  return (
    members.find(
      (member) =>
        member.environmentId === activeThread.environmentId && member.id === activeThread.projectId,
    ) ?? null
  );
}
