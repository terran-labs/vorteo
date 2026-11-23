/**
 * Every string the app shows about a managed HTTPS preview's state (#586), in one place so a
 * wording change is a one-file edit. Provisional until the owner approves the wording; every
 * locale uses the English text until then, as other Vorteo-only sections do.
 *
 * Times are inserted already formatted to the minute by preview-status/describe.ts, as
 * "at 11:00 PM", "yesterday at 11:00 PM", "on Tuesday at 11:00 PM" or "on Nov 14 at 11:00 PM".
 * A cause the broker did not record is never worded as a crash or an exit.
 */
const en = {
  time: {
    today: "at {{time}}",
    yesterday: "yesterday at {{time}}",
    weekday: "on {{day}} at {{time}}",
    date: "on {{date}} at {{time}}",
  },
  line: {
    ready: "Preview is running.",
    starting: "Starting the preview.",
    notResponding: "Running, but not responding. Last checked {{checked}}.",
    notRespondingUnchecked: "Running, but not responding.",
    stoppedByRestart: "Stopped when Vorteo restarted {{time}}.",
    stopped: "Stopped {{time}}.",
    stoppedNoTime: "Stopped.",
    stoppedConfigChanged: "Stopped {{time}} because its settings changed.",
    stoppedProcessChanged: "Stopped {{time}} because another program took its place.",
    unavailable: "Can't start: this workspace is archived or missing.",
    needsReview:
      "Its link was changed outside Vorteo, so it can't start. Ask the Builds thread to repair this preview's link.",
    restartFailed: "Couldn't start: {{error}}",
    restartFailedNoDetail: "Couldn't start the preview.",
    unconfirmed: "Still starting. Vorteo is busy, so this can take a few minutes.",
  },
  stale: {
    running: "Last known: running, checked {{checked}}. Vorteo is busy.",
    starting: "Last known: starting, checked {{checked}}. Vorteo is busy.",
    notResponding: "Last known: not responding, checked {{checked}}. Vorteo is busy.",
    stopped: "Last known: stopped {{time}}. Vorteo is busy.",
    unchecked: "Last known state is not current. Vorteo is busy.",
  },
  actions: {
    start: "Start",
    restart: "Restart",
    retry: "Try again",
  },
  confirmRestart: {
    title: "Restart this preview?",
    message: "It is still running, so it will stop and start again. The link stays the same.",
    confirm: "Restart",
    cancel: "Cancel",
  },
  refusals: {
    busy: "This preview is already starting.",
    capacity: "Several previews are starting. Try again in a minute.",
    archived: "Can't start: this workspace is archived.",
    needsReview: "Can't start until the Builds thread repairs this preview's link.",
    ownerAppOnly:
      "Starting previews needs this Host's Vorteo password. Reconnect with the password, or ask an agent to start it.",
    unavailable: "Previews aren't available on this Host right now.",
    failed: "Couldn't start the preview.",
  },
} as const;

export const previewStatus = {
  en,
  ar: en,
  es: en,
  fr: en,
  ja: en,
  ko: en,
  "pt-BR": en,
  ru: en,
  "zh-CN": en,
} as const;
