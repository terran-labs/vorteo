// All panes observe one settings query. Share the error episode rather than toast per pane.
const episodes = new Map<string, { timer: ReturnType<typeof setTimeout> | null }>();
export function reportSyncError(key: string, error: unknown, notify: () => void) {
  const previous = episodes.get(key);
  if (!error) {
    if (previous?.timer) clearTimeout(previous.timer);
    episodes.delete(key);
    return;
  }
  if (previous) return;
  const episode = { timer: null as ReturnType<typeof setTimeout> | null };
  episode.timer = setTimeout(() => {
    episode.timer = null;
    notify();
  }, 1200);
  episodes.set(key, episode);
}
