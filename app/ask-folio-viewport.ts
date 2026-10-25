export type AskFolioViewport = Pick<VisualViewport, "height" | "offsetTop"> | null | undefined;

export function askFolioViewportRect(viewport: AskFolioViewport, innerHeight: number, layoutHeight: number) {
  const height = Math.round(viewport?.height ?? innerHeight);
  const top = Math.max(0, Math.round(viewport?.offsetTop ?? 0));
  return { height, top, keyboardOpen: Boolean(viewport && layoutHeight - height > 120) };
}
