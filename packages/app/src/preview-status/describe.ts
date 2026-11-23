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
}

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * A broker time as a phrase that fits after "Stopped", to the minute and never to the second:
 * the broker can name a restart up to one check cycle (30 seconds) late. Local time, in the
 * device's 12- or 24-hour format.
 */
export function formatPreviewTime(
  iso: string | null | undefined,
  now: Date,
  locale: string,
  t: TFunction,
): string | null {
  if (!iso) return null;
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return null;
  const time = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(when);
  const days = Math.round((startOfDay(now) - startOfDay(when)) / DAY_MS);
  if (days <= 0) return t("previewStatus.time.today", { time });
  if (days === 1) return t("previewStatus.time.yesterday", { time });
  if (days < 7) {
    const day = new Intl.DateTimeFormat(locale, { weekday: "long" }).format(when);
    return t("previewStatus.time.weekday", { day, time });
  }
  const date = new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    ...(when.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  }).format(when);
  return t("previewStatus.time.date", { date, time });
}

function stoppedLine(
  preview: WorkspaceScriptPreview,
  time: string | null,
  restartTime: string | null,
  t: TFunction,
): string {
  // A restart is named only with the restart's own recorded time, never a guessed one.
  if (preview.stopReason === "daemon_restart" && restartTime) {
    return t("previewStatus.line.stoppedByRestart", { time: restartTime });
  }
  if (!time) return t("previewStatus.line.stoppedNoTime");
  switch (preview.stopReason) {
    case "config_changed":
      return t("previewStatus.line.stoppedConfigChanged", { time });
    case "process_changed":
      return t("previewStatus.line.stoppedProcessChanged", { time });
    default:
      // Includes "exited" and "stopped": the broker cannot yet tell a crash from the owner's
      // own Stop, so the wording stays neutral.
      return t("previewStatus.line.stopped", { time });
  }
}

function staleLine(
  preview: WorkspaceScriptPreview,
  checked: string | null,
  stoppedAt: string | null,
  t: TFunction,
): string {
  if (preview.state === "stopped" && stoppedAt) {
    return t("previewStatus.stale.stopped", { time: stoppedAt });
  }
  if (!checked) return t("previewStatus.stale.unchecked");
  if (preview.state === "ready") return t("previewStatus.stale.running", { checked });
  if (preview.state === "starting") return t("previewStatus.stale.starting", { checked });
  if (preview.state === "not_responding") {
    return t("previewStatus.stale.notResponding", { checked });
  }
  return t("previewStatus.stale.unchecked");
}

function restartDescription(
  restart: NonNullable<WorkspaceScriptPreview["restart"]>,
  t: TFunction,
): PreviewDescription | null {
  if (restart.status === "starting") {
    return { line: t("previewStatus.line.starting"), action: null, confirm: false };
  }
  if (restart.status === "failed") {
    const line = restart.error
      ? t("previewStatus.line.restartFailed", { error: restart.error })
      : t("previewStatus.line.restartFailedNoDetail");
    return { line, action: "retry", confirm: false };
  }
  if (restart.status === "unconfirmed") {
    return { line: t("previewStatus.line.unconfirmed"), action: null, confirm: false };
  }
  return null;
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
  const restart = preview.restart ? restartDescription(preview.restart, t) : null;
  if (restart) return restart;
  if (preview.needsReview) {
    return { line: t("previewStatus.line.needsReview"), action: null, confirm: false };
  }
  const checked = formatPreviewTime(preview.checkedAt, now, locale, t);
  const stoppedAt = formatPreviewTime(preview.stoppedAt, now, locale, t);
  const restartTime = formatPreviewTime(preview.restartedAt, now, locale, t);
  const described = describeState(preview, checked, stoppedAt, restartTime, t);
  if (!described || !preview.stale) return described;
  return { ...described, line: staleLine(preview, checked, stoppedAt, t) };
}

function describeState(
  preview: WorkspaceScriptPreview,
  checked: string | null,
  stoppedAt: string | null,
  restartTime: string | null,
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
          ? t("previewStatus.line.notResponding", { checked })
          : t("previewStatus.line.notRespondingUnchecked"),
        action: "restart",
        confirm: true,
      };
    case "stopped":
      if (preview.stopReason === "workspace_unavailable") {
        return { line: t("previewStatus.line.unavailable"), action: null, confirm: false };
      }
      return {
        line: stoppedLine(preview, stoppedAt, restartTime, t),
        action: "start",
        confirm: false,
      };
    default:
      return null;
  }
}
