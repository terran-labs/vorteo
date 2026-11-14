/** Native has no element fullscreen; the zoom view expands the modal instead. */
export function canFullscreen(): boolean {
  return false;
}

export async function enterFullscreen(_element: unknown): Promise<boolean> {
  return false;
}
