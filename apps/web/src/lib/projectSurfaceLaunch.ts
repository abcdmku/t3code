export async function openSurfaceBeforeNavigate<T extends { readonly _tag: string }>(
  openSurface: () => Promise<T>,
  navigate: () => void,
): Promise<T> {
  const result = await openSurface();
  if (result._tag === "Success") navigate();
  return result;
}
