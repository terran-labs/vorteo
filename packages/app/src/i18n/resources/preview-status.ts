/**
 * Every string the app shows about a managed HTTPS preview's state (#586), in one place so a
 * wording change is a one-file edit. Provisional until the owner approves the wording; every
 * locale uses the English text until then, as other Vorteo-only sections do.
 *
 * Times are formatted to the minute by preview-status/describe.ts and chosen by form there.
 * A cause the broker did not record is never worded as a crash or an exit, and nothing names
 * a reason the app cannot know.
 */
const en = {
  // Each timed sentence has one whole-sentence form per kind of time, so a translation can
  // order it freely: today, yesterday, a weekday this week, or a date. A time in the future
  // (clock skew) uses the date form, never "today".
  line: {
    ready: "Preview is running.",
    starting: "Starting the preview.",
    stopping: "Stopping the preview.",
    notResponding: {
      today: "Running, but not responding. Last checked at {{time}}.",
      yesterday: "Running, but not responding. Last checked yesterday at {{time}}.",
      weekday: "Running, but not responding. Last checked on {{day}} at {{time}}.",
      date: "Running, but not responding. Last checked on {{date}} at {{time}}.",
    },
    notRespondingUnchecked: "Running, but not responding.",
    stoppedByRestart: {
      today: "Stopped when Vorteo restarted at {{time}}.",
      yesterday: "Stopped when Vorteo restarted yesterday at {{time}}.",
      weekday: "Stopped when Vorteo restarted on {{day}} at {{time}}.",
      date: "Stopped when Vorteo restarted on {{date}} at {{time}}.",
    },
    stopped: {
      today: "Stopped at {{time}}.",
      yesterday: "Stopped yesterday at {{time}}.",
      weekday: "Stopped on {{day}} at {{time}}.",
      date: "Stopped on {{date}} at {{time}}.",
    },
    stoppedNoTime: "Stopped.",
    stoppedConfigChanged: {
      today: "Stopped at {{time}} because its settings changed.",
      yesterday: "Stopped yesterday at {{time}} because its settings changed.",
      weekday: "Stopped on {{day}} at {{time}} because its settings changed.",
      date: "Stopped on {{date}} at {{time}} because its settings changed.",
    },
    stoppedProcessChanged: {
      today: "Stopped at {{time}} because its process changed.",
      yesterday: "Stopped yesterday at {{time}} because its process changed.",
      weekday: "Stopped on {{day}} at {{time}} because its process changed.",
      date: "Stopped on {{date}} at {{time}} because its process changed.",
    },
    unavailable: "Can't start: this workspace is archived or missing.",
    needsReview:
      "Its link was changed outside Vorteo, so it can't start. Ask the Builds thread to repair this preview's link.",
    restartFailed: "Couldn't start: {{error}}",
    restartFailedNoDetail: "Couldn't start the preview.",
    unconfirmed: "Couldn't confirm the start yet. Try again if it doesn't come up.",
    stopFailed: "Couldn't stop: {{error}}",
    stopFailedNoDetail: "Couldn't stop the preview.",
    stopUnconfirmed: "Couldn't confirm the stop yet. Try again if it keeps running.",
    linkWithdrawn: "Link withdrawn, but the server is still running.",
  },
  // Stale states say only what is known: the last state and when it was checked.
  stale: {
    running: {
      today: "Last known: running, checked at {{time}}. Not checked since.",
      yesterday: "Last known: running, checked yesterday at {{time}}. Not checked since.",
      weekday: "Last known: running, checked on {{day}} at {{time}}. Not checked since.",
      date: "Last known: running, checked on {{date}} at {{time}}. Not checked since.",
    },
    starting: {
      today: "Last known: starting, checked at {{time}}. Not checked since.",
      yesterday: "Last known: starting, checked yesterday at {{time}}. Not checked since.",
      weekday: "Last known: starting, checked on {{day}} at {{time}}. Not checked since.",
      date: "Last known: starting, checked on {{date}} at {{time}}. Not checked since.",
    },
    notResponding: {
      today: "Last known: not responding, checked at {{time}}. Not checked since.",
      yesterday: "Last known: not responding, checked yesterday at {{time}}. Not checked since.",
      weekday: "Last known: not responding, checked on {{day}} at {{time}}. Not checked since.",
      date: "Last known: not responding, checked on {{date}} at {{time}}. Not checked since.",
    },
    stopped: {
      today: "Last known: stopped at {{time}}. Not checked since.",
      yesterday: "Last known: stopped yesterday at {{time}}. Not checked since.",
      weekday: "Last known: stopped on {{day}} at {{time}}. Not checked since.",
      date: "Last known: stopped on {{date}} at {{time}}. Not checked since.",
    },
    unchecked: "Last known state is not current.",
  },
  /** The short state a compact list shows beside a running preview's name. */
  short: {
    notResponding: "Not responding",
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
    busy: "This preview is already starting or stopping. Try again in a minute.",
    capacity: "Several previews are starting or stopping. Try again in a minute.",
    archived: "Can't start: this workspace is archived.",
    needsReview: "Can't start until the Builds thread repairs this preview's link.",
    ownerAppOnly:
      "Starting previews needs the Vorteo password for {{host}}. Reconnect with the password, or ask an agent to start it.",
    ownerAppOnlyUnnamed:
      "Starting previews needs this host's Vorteo password. Reconnect with the password, or ask an agent to start it.",
    unavailable: "Previews aren't available on this host right now.",
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
