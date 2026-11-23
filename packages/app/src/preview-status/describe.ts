import type { TFunction } from "i18next";
import type { WorkspaceScriptPreview } from "@getpaseo/protocol/messages";

/** What the owner can do about a preview from the app, if anything. */
export type PreviewAction = "start" | "restart" | "retry";

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
  | "stale.stopped";

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
 */
function currentRestart(
  preview: WorkspaceScriptPreview,
): NonNullable<WorkspaceScriptPreview["restart"]> | null {
  const restart = preview.restart;
  if (!restart || preview.state === "ready") return null;
  if (restart.status === "starting") return restart;
  const checked = preview.checkedAt ? Date.parse(preview.checkedAt) : Number.NaN;
  const at = Date.parse(restart.at);
  if (!Number.isNaN(checked) && !Number.isNaN(at) && checked > at) return null;
  return restart;
}

function restartDescription(
  restart: NonNullable<WorkspaceScriptPreview["restart"]>,
  t: TFunction,
): PreviewDescription | null {
  if (restart.status === "starting") {
    return { line: t("previewStatus.line.starting"), action: null, confirm: false };
  }
  if (restart.status === "failed") {
    // Receipts are agent-writable in Dev: show only short plain text from them.
    if (restart.error && PLAIN_TEXT.test(restart.error)) {
      return {
        line: t("previewStatus.line.restartFailed", { error: restart.error }),
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
): string {
  if (preview.state === "stopped") {
    return stoppedAt ? timed(t, "stale.stopped", stoppedAt) : t("previewStatus.stale.unchecked");
  }
  if (!checked) return t("previewStatus.stale.unchecked");
  if (preview.state === "ready") return timed(t, "stale.running", checked);
  if (preview.state === "starting") return timed(t, "stale.starting", checked);
  return timed(t, "stale.notResponding", checked);
}

function describeState(
  preview: WorkspaceScriptPreview,
  checked: PreviewTime | null,
  stoppedAt: PreviewTime | null,
  restartedAt: PreviewTime | null,
  t: TFunction,
): PreviewDescription | null {
  switch (preview.state) {
    case "ready":
      return { line: t("previewStatus.line.ready"), action: null, confirm: false };
    case "starting":
      return { line: t("previewStatus.line.starting"), action: null, confirm: false };
    case "not_responding":
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
): PreviewDescription | null {
  const restart = currentRestart(preview);
  const fromRestart = restart ? restartDescription(restart, t) : null;
  if (fromRestart) return fromRestart;
  if (preview.needsReview) {
    return { line: t("previewStatus.line.needsReview"), action: null, confirm: false };
  }
  const checked = formatPreviewTime(preview.checkedAt, now, locale);
  const stoppedAt = formatPreviewTime(preview.stoppedAt, now, locale);
  const restartedAt = formatPreviewTime(preview.restartedAt, now, locale);
  const described = describeState(preview, checked, stoppedAt, restartedAt, t);
  // Why a preview cannot start does not go stale: an archived workspace stays archived.
  const unavailable = preview.state === "stopped" && preview.stopReason === "workspace_unavailable";
  if (!described || !preview.stale || unavailable) return described;
  return { ...described, line: staleLine(preview, checked, stoppedAt, t) };
}
