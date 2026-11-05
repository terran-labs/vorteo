/**
 * The Live dev status indicator: a small circle at lower right on every owner page while the
 * installation is in Live dev mode, whether the page came from the live checkout or the static
 * interface. Pressing it opens a panel that explains the state and offers the relevant actions.
 *
 * It is plain HTML and CSS injected by the coordinator, outside the app bundle, so it still
 * works when live code fails to compile and on the static fallback. It uses `<details>` rather
 * than script, so it needs no script permission. Colors come from CSS variables the app
 * publishes for its floating panels, with system colors before the app loads.
 */

export type LiveDevIndicatorState =
  /** The page came from the live checkout. */
  | "live"
  /** The owner chose the static interface for this browser. */
  | "safe"
  /** The dev server is ready but did not answer in time, so this page is static. */
  | "slow"
  /** The dev server or live checkout is still starting. */
  | "starting"
  /** The dev server is stopped or failed. */
  | "down";

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => ESCAPES[char]!);

const ICONS = {
  // Lightning bolt: serving live code.
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  // Shield: the owner's chosen static interface.
  shield: '<path d="M12 3 5 6v6c0 4.4 3 7.6 7 9 4-1.4 7-4.6 7-9V6z"/>',
  // Clock: a slow or starting dev server.
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  // Exclamation: the dev server is not running.
  alert: '<circle cx="12" cy="12" r="8"/><path d="M12 8v5M12 16h.01"/>',
} as const;

interface StateCopy {
  icon: keyof typeof ICONS;
  tone: "success" | "neutral" | "warning" | "danger";
  title: string;
  body: string;
  actions: { label: string; href: string }[];
}

const SETTINGS = { label: "Installation settings", href: "/settings/maintenance" };
const RETRY = { label: "Retry Live dev", href: "/?interface=live" };

const COPY: Record<LiveDevIndicatorState, StateCopy> = {
  live: {
    icon: "bolt",
    tone: "success",
    title: "Live dev",
    body: "This page runs the Host's live checkout. Edits appear within seconds through Fast Refresh.",
    actions: [{ label: "Use the static interface", href: "/?interface=safe" }, SETTINGS],
  },
  safe: {
    icon: "shield",
    tone: "neutral",
    title: "Static interface",
    body: "You chose the static interface for this browser. It is the last installed release, which live edits never touch.",
    actions: [{ label: "Return to Live dev", href: "/?interface=live" }, SETTINGS],
  },
  slow: {
    icon: "clock",
    tone: "warning",
    title: "Live dev is slow to answer",
    body: "The live dev server did not answer in time, so this page is the static interface. Live edits are not shown here.",
    actions: [RETRY, SETTINGS],
  },
  starting: {
    icon: "clock",
    tone: "warning",
    title: "Live dev is starting",
    body: "The live dev server is not ready yet, so this page is the static interface. Retry in a moment.",
    actions: [RETRY, SETTINGS],
  },
  down: {
    icon: "alert",
    tone: "danger",
    title: "Live dev is not running",
    body: "The live dev server is stopped, so this page is the static interface. Switch to Reliable in Installation settings if it stays down.",
    actions: [RETRY, SETTINGS],
  },
};

const TONES = {
  success: "var(--vorteo-status-success,#22c55e)",
  neutral: "var(--vorteo-floating-muted,GrayText)",
  warning: "var(--vorteo-status-warning,#f59e0b)",
  danger: "var(--vorteo-status-danger,#ef4444)",
} as const;

const STYLE = `<style>
#vorteo-live-dev-marker{position:fixed;right:12px;bottom:12px;z-index:2147483647;font:400 13px/1.45 var(--paseo-ui-font,system-ui),system-ui,sans-serif;color:var(--vorteo-floating-foreground,CanvasText)}
#vorteo-live-dev-marker>summary{list-style:none;cursor:pointer;width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:var(--vorteo-floating-background,Canvas);border:1px solid var(--vorteo-floating-border,GrayText);box-shadow:0 4px 8px rgba(0,0,0,.2)}
#vorteo-live-dev-marker>summary::-webkit-details-marker{display:none}
#vorteo-live-dev-marker>summary:focus-visible{outline:2px solid var(--vorteo-floating-accent,Highlight);outline-offset:2px}
#vorteo-live-dev-marker svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
#vorteo-live-dev-marker .vldm-panel{position:absolute;right:0;bottom:40px;width:280px;padding:12px 14px;border-radius:16px;background:var(--vorteo-floating-background,Canvas);border:1px solid var(--vorteo-floating-border,GrayText);box-shadow:0 4px 8px rgba(0,0,0,.2)}
#vorteo-live-dev-marker .vldm-title{font-weight:600;margin:0 0 4px}
#vorteo-live-dev-marker .vldm-body,#vorteo-live-dev-marker .vldm-detail{margin:0 0 8px;color:var(--vorteo-floating-muted,inherit)}
#vorteo-live-dev-marker .vldm-actions{display:flex;flex-wrap:wrap;gap:4px 12px}
#vorteo-live-dev-marker .vldm-actions a{color:var(--vorteo-floating-accent,LinkText);text-decoration:none}
#vorteo-live-dev-marker .vldm-actions a:hover{text-decoration:underline}
</style>`;

/** The indicator markup for `state`, with an optional server detail line. */
export function liveDevIndicatorHtml(state: LiveDevIndicatorState, detail?: string | null): string {
  const copy = COPY[state];
  const actions = copy.actions
    .map((action) => `<a href="${action.href}">${escapeHtml(action.label)}</a>`)
    .join("");
  const detailLine = detail ? `<p class="vldm-detail">${escapeHtml(detail)}</p>` : "";
  return (
    `${STYLE}<details id="vorteo-live-dev-marker" data-state="${state}">` +
    `<summary role="button" aria-label="${escapeHtml(copy.title)}. Show details." title="${escapeHtml(copy.title)}" style="color:${TONES[copy.tone]}">` +
    `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[copy.icon]}</svg></summary>` +
    `<div class="vldm-panel" role="status"><p class="vldm-title">${escapeHtml(copy.title)}</p>` +
    `<p class="vldm-body">${escapeHtml(copy.body)}</p>${detailLine}` +
    `<div class="vldm-actions">${actions}</div></div></details>`
  );
}

/** Inserts `fragment` before `</body>`, or appends it when the page has none. */
export function injectBeforeBodyEnd(html: string, fragment: string): string {
  const index = html.lastIndexOf("</body>");
  return index === -1
    ? `${html}${fragment}`
    : `${html.slice(0, index)}${fragment}${html.slice(index)}`;
}
