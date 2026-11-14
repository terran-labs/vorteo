/**
 * Element fullscreen for the zoom stage. iOS Safari only fullscreens video, so it reports
 * unsupported and the zoom view expands the modal to the window instead.
 */
export function canFullscreen(): boolean {
  return typeof document !== "undefined" && document.fullscreenEnabled === true;
}

export async function enterFullscreen(element: unknown): Promise<boolean> {
  if (!canFullscreen() || !(element instanceof HTMLElement)) return false;
  await element.requestFullscreen();
  return true;
}
