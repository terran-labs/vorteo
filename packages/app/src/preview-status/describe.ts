import type { TFunction } from "i18next";
import type { WorkspaceScriptPreview } from "@getpaseo/protocol/messages";

/**
 * What the owner can do about a preview from the app, if anything. "stop" is the running row's
 * own Stop control, named here so the rule says which control the line points to.
 */
export type PreviewAction = "start" | "restart" | "retry" | "stop";

/** The daemon's own view of the script's server, which the broker's state can lag. */
export type PreviewServerLifecycle = "running" | "stopped";

export interface PreviewDescription {
  /** One plain sentence: what happened and, where it helps, what to do. */
  line: string;
  action: PreviewAction | null;
  /** Restarting a running preview stops it first, so it asks before doing so. */
  confirm: boolean;
  /**
   * Only a broker's own message can run long; it is cut at two lines and expands when tapped.
   * The app's fixed sentences always show in full, so an action like "Ask the Builds thread"
   * is never hidden.
   */
  truncate?: boolean;
  /** A stop in flight or its outcome, which a running row must show rather than "Running". */
  stop?: boolean;
}

/** Which whole-sentence form a time takes. A future time (clock skew) is never "today". */
export type PreviewTimeForm = "today" | "yesterday" | "weekday" | "date";

export interface PreviewTime {
  form: PreviewTimeForm;
  time: string;
  day: string;
  date: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Same rule as the daemon's status error: short plain sentences, so no link or markup. */
const PLAIN_TEXT = /^[A-Za-z0-9 ;:,.'()_-]{1,160}$/;

/** A broker message ends the owner's sentence, so it gets a full stop when it has none. */
function asSentence(message: string): string {
  return /[.!?]$/.test(message) ? message : `${message}.`;
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * A broker time to the minute and never to the second (the broker can name a restart up to one
 * check cycle late), in local time and the device's 12- or 24-hour format.
 */
export function formatPreviewTime(
  iso: string | null | undefined,
  now: Date,
  locale: string,
): PreviewTime | null {
  if (!iso) return null;
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return null;
  const time = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(when);
  const day = new Intl.DateTimeFormat(locale, { weekday: "long" }).format(when);
  const date = new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    ...(when.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  }).format(when);
  return { form: timeForm(when, now), time, day, date };
}

function timeForm(when: Date, now: Date): PreviewTimeForm {
  if (when.getTime() > now.getTime()) return "date";
  const days = Math.round((startOfDay(now) - startOfDay(when)) / DAY_MS);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days > 1 && days < 7) return "weekday";
  return "date";
}

type TimedKey =
  | "line.notResponding"
  | "line.stoppedByRestart"
  | "line.stopped"
  | "line.stoppedConfigChanged"
  | "line.stoppedProcessChanged"
  | "stale.running"
  | "stale.starting"
  | "stale.notResponding"
  | "stale.stopped"
  | "stale.linkWithdrawn"
  | "stale.checksDelayed"
  | "stale.checksWithdrawn";

/**
 * The broker's reason a running preview is not ready, when it is the link rather than the
 * server (#616): "delayed" keeps a reachable link whose checks time out, "withdrawn" pulled it
 * until a check passes. Null for a plain "not responding" and for a value this app does not know.
 */
export function previewLinkCheck(preview: WorkspaceScriptPreview): "delayed" | "withdrawn" | null {
  if (preview.state !== "not_responding") return null;
  if (preview.linkCheck === "unverified") return "delayed";
  if (preview.linkCheck === "withdrawn") return "withdrawn";
  return null;
}

function timed(t: TFunction, key: TimedKey, at: PreviewTime): string {
  return t(`previewStatus.${key}.${at.form}`, { time: at.time, day: at.day, date: at.date });
}

function stoppedLine(
  preview: WorkspaceScriptPreview,
  stoppedAt: PreviewTime | null,
  restartedAt: PreviewTime | null,
  t: TFunction,
): string {
  // A restart is named only with the restart's own recorded time, never a guessed one.
  if (preview.stopReason === "daemon_restart" && restartedAt) {
    return timed(t, "line.stoppedByRestart", restartedAt);
  }
  if (!stoppedAt) return t("previewStatus.line.stoppedNoTime");
  if (preview.stopReason === "config_changed") {
    return timed(t, "line.stoppedConfigChanged", stoppedAt);
  }
  if (preview.stopReason === "process_changed") {
    return timed(t, "line.stoppedProcessChanged", stoppedAt);
  }
  // Includes "exited" and "stopped": a crash and the owner's own Stop look alike here, so the
  // wording stays neutral.
  return timed(t, "line.stopped", stoppedAt);
}

/**
 * A restart's outcome describes the preview only until the broker reports something newer: a
 * preview that is ready, or one the broker checked after the outcome, shows the broker's state.
 * A stop's outcome instead gives way once the preview and its server have both stopped, since
 * a failed stop matters most while the preview still runs.
 */
function currentRestart(
  preview: WorkspaceScriptPreview,
  lifecycle: PreviewServerLifecycle | undefined,
): NonNullable<WorkspaceScriptPreview["restart"]> | null {
  const restart = preview.restart;
  if (!restart) return null;
  // A stop in flight shows until the broker reports the preview stopped.
  if (restart.status === "stopping") return preview.state === "stopped" ? null : restart;
  const checked = preview.checkedAt ? Date.parse(preview.checkedAt) : Number.NaN;
  const at = Date.parse(restart.at);
  const checkedSince = !Number.isNaN(checked) && !Number.isNaN(at) && checked > at;
  if (restart.mode === "stop") {
    if (checkedSince || (preview.state === "stopped" && lifecycle !== "running")) return null;
    return restart;
  }
  if (preview.state === "ready") return null;
  if (restart.status === "starting") return restart;
  return checkedSince ? null : restart;
}

function stopOutcomeDescription(
  restart: NonNullable<WorkspaceScriptPreview["restart"]>,
  t: TFunction,
): PreviewDescription | null {
  // The running row's own Stop is how the owner tries again.
  if (restart.status === "failed") {
    if (restart.error && PLAIN_TEXT.test(restart.error)) {
      return {
        line: t("previewStatus.line.stopFailed", { error: asSentence(restart.error) }),
        action: "stop",
        confirm: false,
        truncate: true,
        stop: true,
      };
    }
    return {
      line: t("previewStatus.line.stopFailedNoDetail"),
      action: "stop",
      confirm: false,
      stop: true,
    };
  }
  if (restart.status === "unconfirmed") {
    return {
      line: t("previewStatus.line.stopUnconfirmed"),
      action: "stop",
      confirm: false,
      stop: true,
    };
  }
  return null;
}

function restartDescription(
  restart: NonNullable<WorkspaceScriptPreview["restart"]>,
  t: TFunction,
): PreviewDescription | null {
  if (restart.status === "starting") {
    return { line: t("previewStatus.line.starting"), action: null, confirm: false };
  }
  if (restart.status === "stopping") {
    return { line: t("previewStatus.line.stopping"), action: null, confirm: false, stop: true };
  }
  // An older daemon names no mode; its outcomes come only from starts and restarts.
  if (restart.mode === "stop") return stopOutcomeDescription(restart, t);
  if (restart.status === "failed") {
    // Receipts are agent-writable in Dev: show only short plain text from them.
    if (restart.error && PLAIN_TEXT.test(restart.error)) {
      return {
        line: t("previewStatus.line.restartFailed", { error: asSentence(restart.error) }),
        action: "retry",
        confirm: false,
        truncate: true,
      };
    }
    return { line: t("previewStatus.line.restartFailedNoDetail"), action: "retry", confirm: false };
  }
  if (restart.status === "unconfirmed") {
    return { line: t("previewStatus.line.unconfirmed"), action: "retry", confirm: false };
  }
  return null;
}

function staleLine(
  preview: WorkspaceScriptPreview,
  checked: PreviewTime | null,
  stoppedAt: PreviewTime | null,
  t: TFunction,
  lifecycle: PreviewServerLifecycle | undefined,
): string {
  // The daemon knows the server runs now; only the broker's view of the link is old. One line
  // states both, so a stale "stopped" never sits beside a running row.
  if (preview.state === "stopped" && lifecycle === "running") {
    return checked
      ? timed(t, "stale.linkWithdrawn", checked)
      : t("previewStatus.stale.linkWithdrawnUnchecked");
  }
  if (preview.state === "stopped") {
    return stoppedAt ? timed(t, "stale.stopped", stoppedAt) : t("previewStatus.stale.unchecked");
  }
  if (!checked) return t("previewStatus.stale.unchecked");
  if (preview.state === "ready") return timed(t, "stale.running", checked);
  if (preview.state === "starting") return timed(t, "stale.starting", checked);
  const linkCheck = previewLinkCheck(preview);
  if (linkCheck === "delayed") return timed(t, "stale.checksDelayed", checked);
  if (linkCheck === "withdrawn") return timed(t, "stale.checksWithdrawn", checked);
  return timed(t, "stale.notResponding", checked);
}

function describeState(
  preview: WorkspaceScriptPreview,
  checked: PreviewTime | null,
  stoppedAt: PreviewTime | null,
  restartedAt: PreviewTime | null,
  t: TFunction,
  lifecycle: PreviewServerLifecycle | undefined,
): PreviewDescription | null {
  // The broker withdrew the link but the daemon still runs the server, for example after a
  // stop that could not find it. Saying "Stopped" would be false; Stop ends the server.
  if (preview.state === "stopped" && lifecycle === "running") {
    return { line: t("previewStatus.line.linkWithdrawn"), action: "stop", confirm: false };
  }
  switch (preview.state) {
    case "ready":
      return { line: t("previewStatus.line.ready"), action: null, confirm: false };
    case "starting":
      return { line: t("previewStatus.line.starting"), action: null, confirm: false };
    case "not_responding":
      // Reachable: offering Restart would invite stopping a working server.
      if (previewLinkCheck(preview) === "delayed") {
        return { line: t("previewStatus.line.checksDelayed"), action: null, confirm: false };
      }
      // Comes back by itself; Restart is what the owner can do if it does not.
      if (previewLinkCheck(preview) === "withdrawn") {
        return { line: t("previewStatus.line.checksWithdrawn"), action: "restart", confirm: true };
      }
      return {
        line: checked
          ? timed(t, "line.notResponding", checked)
          : t("previewStatus.line.notRespondingUnchecked"),
        action: "restart",
        confirm: true,
      };
    case "stopped":
      if (preview.stopReason === "workspace_unavailable") {
        return { line: t("previewStatus.line.unavailable"), action: null, confirm: false };
      }
      return {
        line: stoppedLine(preview, stoppedAt, restartedAt, t),
        action: "start",
        confirm: false,
      };
    default:
      return null;
  }
}

/**
 * The one rule for what the owner reads about a preview, shared by the scripts menu and the
 * Previews gallery. Returns null for a state this app does not know, so a newer daemon's state
 * shows nothing rather than something wrong.
 */
export function describePreview(
  preview: WorkspaceScriptPreview,
  now: Date,
  locale: string,
  t: TFunction,
  /** The script's own lifecycle, when known, so a withdrawn link never reads as stopped. */
  lifecycle?: PreviewServerLifecycle,
): PreviewDescription | null {
  const restart = currentRestart(preview, lifecycle);
  const fromRestart = restart ? restartDescription(restart, t) : null;
  if (fromRestart) return fromRestart;
  if (preview.needsReview) {
    return { line: t("previewStatus.line.needsReview"), action: null, confirm: false };
  }
  const checked = formatPreviewTime(preview.checkedAt, now, locale);
  const stoppedAt = formatPreviewTime(preview.stoppedAt, now, locale);
  const restartedAt = formatPreviewTime(preview.restartedAt, now, locale);
  const described = describeState(preview, checked, stoppedAt, restartedAt, t, lifecycle);
  // Why a preview cannot start does not go stale: an archived workspace stays archived.
  const unavailable = preview.state === "stopped" && preview.stopReason === "workspace_unavailable";
  if (!described || !preview.stale || unavailable) return described;
  return { ...described, line: staleLine(preview, checked, stoppedAt, t, lifecycle) };
}

/** A gallery tile's one- or two-word state; the full sentence is its accessibility label. */
export type PreviewBadgeKey =
  | "starting"
  | "stopping"
  | "notResponding"
  | "stopped"
  | "unavailable"
  | "needsRepair"
  | "didntStart"
  | "didntStop"
  | "linkWithdrawn"
  | "unconfirmed"
  | "lastKnown";

export interface PreviewBadge {
  key: PreviewBadgeKey;
}

function restartBadge(
  restart: NonNullable<WorkspaceScriptPreview["restart"]>,
): PreviewBadgeKey | null {
  const stop = restart.mode === "stop";
  if (restart.status === "starting") return "starting";
  if (restart.status === "stopping") return "stopping";
  if (restart.status === "failed") return stop ? "didntStop" : "didntStart";
  // Unknown either way: "Starting" or "Stopping" would claim what nobody confirmed.
  if (restart.status === "unconfirmed") return "unconfirmed";
  return null;
}

function stateBadge(
  preview: WorkspaceScriptPreview,
  lifecycle: PreviewServerLifecycle | undefined,
): PreviewBadgeKey | null {
  switch (preview.state) {
    case "ready":
      return null;
    case "starting":
      return "starting";
    case "not_responding": {
      const linkCheck = previewLinkCheck(preview);
      if (linkCheck === "delayed") return "unconfirmed";
      if (linkCheck === "withdrawn") return "linkWithdrawn";
      return "notResponding";
    }
    case "stopped":
      if (lifecycle === "running") return "linkWithdrawn";
      return preview.stopReason === "workspace_unavailable" ? "unavailable" : "stopped";
    default:
      return null;
  }
}

/**
 * The badge for a gallery tile, from the same rules as describePreview: the daemon's own
 * outcome first, then repair, then the broker's state. When the broker's report is old, a
 * state badge reads only "Last known", in words rather than colour, so it never passes for
 * current; the opened tile carries the last known state. An archived workspace keeps its
 * reason, which does not go stale. Null for a current ready preview or an unknown state.
 */
export function previewBadge(
  preview: WorkspaceScriptPreview,
  lifecycle?: PreviewServerLifecycle,
): PreviewBadge | null {
  const restart = currentRestart(preview, lifecycle);
  const outcome = restart ? restartBadge(restart) : null;
  if (outcome) return { key: outcome };
  if (preview.needsReview) return { key: "needsRepair" };
  const unavailable = preview.state === "stopped" && preview.stopReason === "workspace_unavailable";
  const known = preview.state === "ready" || stateBadge(preview, lifecycle) !== null;
  if (preview.stale && known && !unavailable) return { key: "lastKnown" };
  const key = stateBadge(preview, lifecycle);
  return key ? { key } : null;
}
