/**
 * Every string the app shows about a managed HTTPS preview's state (#586), in one place so a
 * wording change is a one-file edit per locale. The eight non-English locales are
 * machine-written translations, not yet reviewed by native speakers; retranslate the affected
 * lines whenever the English wording changes.
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
    // The broker's own link checks (#616), so no time: its check time marks a visit, not a pass.
    checksDelayed: "Running. Its checks are delayed. The link stays up.",
    checksWithdrawn:
      "Link withdrawn because its checks could not finish. It comes back by itself when one does. If it stays down, restart the preview.",
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
    // The script's live lifecycle and an old broker report disagree: state both knowns.
    linkWithdrawn: {
      today: "Server is running. Link last known withdrawn, checked at {{time}}.",
      yesterday: "Server is running. Link last known withdrawn, checked yesterday at {{time}}.",
      weekday: "Server is running. Link last known withdrawn, checked on {{day}} at {{time}}.",
      date: "Server is running. Link last known withdrawn, checked on {{date}} at {{time}}.",
    },
    linkWithdrawnUnchecked: "Server is running. Link last known withdrawn.",
    running: {
      today: "Last known: running, checked at {{time}}. Not checked since.",
      yesterday: "Last known: running, checked yesterday at {{time}}. Not checked since.",
      weekday: "Last known: running, checked on {{day}} at {{time}}. Not checked since.",
      date: "Last known: running, checked on {{date}} at {{time}}. Not checked since.",
    },
    checksDelayed: {
      today: "Last known: running with delayed checks, checked at {{time}}. Not checked since.",
      yesterday:
        "Last known: running with delayed checks, checked yesterday at {{time}}. Not checked since.",
      weekday:
        "Last known: running with delayed checks, checked on {{day}} at {{time}}. Not checked since.",
      date: "Last known: running with delayed checks, checked on {{date}} at {{time}}. Not checked since.",
    },
    checksWithdrawn: {
      today: "Last known: link withdrawn, checked at {{time}}. Not checked since.",
      yesterday: "Last known: link withdrawn, checked yesterday at {{time}}. Not checked since.",
      weekday: "Last known: link withdrawn, checked on {{day}} at {{time}}. Not checked since.",
      date: "Last known: link withdrawn, checked on {{date}} at {{time}}. Not checked since.",
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
    checksDelayed: "Unconfirmed",
    checksWithdrawn: "Link withdrawn",
    notResponding: "Not responding",
  },
  // One or two words over a Previews gallery tile, at most 14 characters. The tile's full
  // sentence is the badge's accessibility label.
  badge: {
    starting: "Starting",
    stopping: "Stopping",
    notResponding: "Not responding",
    stopped: "Stopped",
    unavailable: "Unavailable",
    needsRepair: "Needs repair",
    didntStart: "Didn't start",
    didntStop: "Didn't stop",
    linkWithdrawn: "Link withdrawn",
    unconfirmed: "Unconfirmed",
    // An old broker report: the state is in the opened tile's "Last known" line.
    lastKnown: "Last known",
  },
  actions: {
    start: "Start",
    restart: "Restart",
    retry: "Try again",
    stop: "Stop",
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

/** The same keys as English, with any text, so a locale can never miss or add a string. */
type WidenStrings<T> = { [K in keyof T]: T[K] extends string ? string : WidenStrings<T[K]> };
type PreviewStatusStrings = WidenStrings<typeof en>;

const es: PreviewStatusStrings = {
  line: {
    checksDelayed: "En ejecución. Sus comprobaciones van con retraso. El enlace sigue activo.",
    checksWithdrawn:
      "Enlace retirado porque sus comprobaciones no pudieron terminar. Volverá por sí solo cuando una termine. Si no vuelve, reinicia la vista previa.",
    ready: "La vista previa está en ejecución.",
    starting: "Iniciando la vista previa.",
    stopping: "Deteniendo la vista previa.",
    notResponding: {
      today: "En ejecución, pero no responde. Última comprobación a las {{time}}.",
      yesterday: "En ejecución, pero no responde. Última comprobación ayer a las {{time}}.",
      weekday: "En ejecución, pero no responde. Última comprobación el {{day}} a las {{time}}.",
      date: "En ejecución, pero no responde. Última comprobación el {{date}} a las {{time}}.",
    },
    notRespondingUnchecked: "En ejecución, pero no responde.",
    stoppedByRestart: {
      today: "Se detuvo cuando Vorteo se reinició a las {{time}}.",
      yesterday: "Se detuvo cuando Vorteo se reinició ayer a las {{time}}.",
      weekday: "Se detuvo cuando Vorteo se reinició el {{day}} a las {{time}}.",
      date: "Se detuvo cuando Vorteo se reinició el {{date}} a las {{time}}.",
    },
    stopped: {
      today: "Se detuvo a las {{time}}.",
      yesterday: "Se detuvo ayer a las {{time}}.",
      weekday: "Se detuvo el {{day}} a las {{time}}.",
      date: "Se detuvo el {{date}} a las {{time}}.",
    },
    stoppedNoTime: "Detenida.",
    stoppedConfigChanged: {
      today: "Se detuvo a las {{time}} porque cambió su configuración.",
      yesterday: "Se detuvo ayer a las {{time}} porque cambió su configuración.",
      weekday: "Se detuvo el {{day}} a las {{time}} porque cambió su configuración.",
      date: "Se detuvo el {{date}} a las {{time}} porque cambió su configuración.",
    },
    stoppedProcessChanged: {
      today: "Se detuvo a las {{time}} porque cambió su proceso.",
      yesterday: "Se detuvo ayer a las {{time}} porque cambió su proceso.",
      weekday: "Se detuvo el {{day}} a las {{time}} porque cambió su proceso.",
      date: "Se detuvo el {{date}} a las {{time}} porque cambió su proceso.",
    },
    unavailable: "No se puede iniciar: este espacio de trabajo está archivado o no existe.",
    needsReview:
      "Su enlace se cambió fuera de Vorteo, así que no puede iniciarse. Pide al hilo Builds que repare el enlace de esta vista previa.",
    restartFailed: "No se pudo iniciar: {{error}}",
    restartFailedNoDetail: "No se pudo iniciar la vista previa.",
    unconfirmed: "Aún no se pudo confirmar el inicio. Inténtalo de nuevo si no aparece.",
    stopFailed: "No se pudo detener: {{error}}",
    stopFailedNoDetail: "No se pudo detener la vista previa.",
    stopUnconfirmed:
      "Aún no se pudo confirmar la detención. Inténtalo de nuevo si sigue en ejecución.",
    linkWithdrawn: "Enlace retirado, pero el servidor sigue en ejecución.",
  },
  stale: {
    linkWithdrawn: {
      today:
        "El servidor está en ejecución. Último estado conocido del enlace: retirado, comprobado a las {{time}}.",
      yesterday:
        "El servidor está en ejecución. Último estado conocido del enlace: retirado, comprobado ayer a las {{time}}.",
      weekday:
        "El servidor está en ejecución. Último estado conocido del enlace: retirado, comprobado el {{day}} a las {{time}}.",
      date: "El servidor está en ejecución. Último estado conocido del enlace: retirado, comprobado el {{date}} a las {{time}}.",
    },
    linkWithdrawnUnchecked:
      "El servidor está en ejecución. Último estado conocido del enlace: retirado.",
    running: {
      today:
        "Último estado conocido: en ejecución, comprobado a las {{time}}. Sin comprobar desde entonces.",
      yesterday:
        "Último estado conocido: en ejecución, comprobado ayer a las {{time}}. Sin comprobar desde entonces.",
      weekday:
        "Último estado conocido: en ejecución, comprobado el {{day}} a las {{time}}. Sin comprobar desde entonces.",
      date: "Último estado conocido: en ejecución, comprobado el {{date}} a las {{time}}. Sin comprobar desde entonces.",
    },
    checksDelayed: {
      today:
        "Último estado conocido: en ejecución con comprobaciones retrasadas, comprobado a las {{time}}. Sin comprobar desde entonces.",
      yesterday:
        "Último estado conocido: en ejecución con comprobaciones retrasadas, comprobado ayer a las {{time}}. Sin comprobar desde entonces.",
      weekday:
        "Último estado conocido: en ejecución con comprobaciones retrasadas, comprobado el {{day}} a las {{time}}. Sin comprobar desde entonces.",
      date: "Último estado conocido: en ejecución con comprobaciones retrasadas, comprobado el {{date}} a las {{time}}. Sin comprobar desde entonces.",
    },
    checksWithdrawn: {
      today:
        "Último estado conocido: enlace retirado, comprobado a las {{time}}. Sin comprobar desde entonces.",
      yesterday:
        "Último estado conocido: enlace retirado, comprobado ayer a las {{time}}. Sin comprobar desde entonces.",
      weekday:
        "Último estado conocido: enlace retirado, comprobado el {{day}} a las {{time}}. Sin comprobar desde entonces.",
      date: "Último estado conocido: enlace retirado, comprobado el {{date}} a las {{time}}. Sin comprobar desde entonces.",
    },
    starting: {
      today:
        "Último estado conocido: iniciándose, comprobado a las {{time}}. Sin comprobar desde entonces.",
      yesterday:
        "Último estado conocido: iniciándose, comprobado ayer a las {{time}}. Sin comprobar desde entonces.",
      weekday:
        "Último estado conocido: iniciándose, comprobado el {{day}} a las {{time}}. Sin comprobar desde entonces.",
      date: "Último estado conocido: iniciándose, comprobado el {{date}} a las {{time}}. Sin comprobar desde entonces.",
    },
    notResponding: {
      today:
        "Último estado conocido: no responde, comprobado a las {{time}}. Sin comprobar desde entonces.",
      yesterday:
        "Último estado conocido: no responde, comprobado ayer a las {{time}}. Sin comprobar desde entonces.",
      weekday:
        "Último estado conocido: no responde, comprobado el {{day}} a las {{time}}. Sin comprobar desde entonces.",
      date: "Último estado conocido: no responde, comprobado el {{date}} a las {{time}}. Sin comprobar desde entonces.",
    },
    stopped: {
      today: "Último estado conocido: detenida a las {{time}}. Sin comprobar desde entonces.",
      yesterday:
        "Último estado conocido: detenida ayer a las {{time}}. Sin comprobar desde entonces.",
      weekday:
        "Último estado conocido: detenida el {{day}} a las {{time}}. Sin comprobar desde entonces.",
      date: "Último estado conocido: detenida el {{date}} a las {{time}}. Sin comprobar desde entonces.",
    },
    unchecked: "El último estado conocido no está actualizado.",
  },
  short: {
    checksDelayed: "Sin confirmar",
    checksWithdrawn: "Enlace retirado",
    notResponding: "No responde",
  },
  badge: {
    starting: "Iniciando",
    stopping: "Deteniendo",
    notResponding: "No responde",
    stopped: "Detenida",
    unavailable: "No disponible",
    needsRepair: "Por reparar",
    didntStart: "No se inició",
    didntStop: "No se detuvo",
    linkWithdrawn: "Enlace retirado",
    unconfirmed: "Sin confirmar",
    lastKnown: "Desactualizado",
  },
  actions: {
    start: "Iniciar",
    restart: "Reiniciar",
    retry: "Reintentar",
    stop: "Detener",
  },
  confirmRestart: {
    title: "¿Reiniciar esta vista previa?",
    message: "Sigue en ejecución, así que se detendrá y volverá a iniciarse. El enlace no cambia.",
    confirm: "Reiniciar",
    cancel: "Cancelar",
  },
  refusals: {
    busy: "Esta vista previa ya se está iniciando o deteniendo. Inténtalo de nuevo en un minuto.",
    capacity:
      "Varias vistas previas se están iniciando o deteniendo. Inténtalo de nuevo en un minuto.",
    archived: "No se puede iniciar: este espacio de trabajo está archivado.",
    needsReview:
      "No se puede iniciar hasta que el hilo Builds repare el enlace de esta vista previa.",
    ownerAppOnly:
      "Para iniciar vistas previas se necesita la contraseña de Vorteo de {{host}}. Vuelve a conectarte con la contraseña o pide a un agente que la inicie.",
    ownerAppOnlyUnnamed:
      "Para iniciar vistas previas se necesita la contraseña de Vorteo de este host. Vuelve a conectarte con la contraseña o pide a un agente que la inicie.",
    unavailable: "Las vistas previas no están disponibles en este host ahora mismo.",
    failed: "No se pudo iniciar la vista previa.",
  },
};

const fr: PreviewStatusStrings = {
  line: {
    checksDelayed: "En cours d’exécution. Ses vérifications sont retardées. Le lien reste actif.",
    checksWithdrawn:
      "Lien retiré, car ses vérifications n’ont pas pu aboutir. Il revient de lui-même dès qu’une vérification aboutit. S’il ne revient pas, redémarrez l’aperçu.",
    ready: "L’aperçu est en cours d’exécution.",
    starting: "Démarrage de l’aperçu.",
    stopping: "Arrêt de l’aperçu.",
    notResponding: {
      today: "En cours d’exécution, mais ne répond pas. Dernière vérification à {{time}}.",
      yesterday: "En cours d’exécution, mais ne répond pas. Dernière vérification hier à {{time}}.",
      weekday:
        "En cours d’exécution, mais ne répond pas. Dernière vérification {{day}} à {{time}}.",
      date: "En cours d’exécution, mais ne répond pas. Dernière vérification le {{date}} à {{time}}.",
    },
    notRespondingUnchecked: "En cours d’exécution, mais ne répond pas.",
    stoppedByRestart: {
      today: "Arrêté au redémarrage de Vorteo à {{time}}.",
      yesterday: "Arrêté au redémarrage de Vorteo hier à {{time}}.",
      weekday: "Arrêté au redémarrage de Vorteo {{day}} à {{time}}.",
      date: "Arrêté au redémarrage de Vorteo le {{date}} à {{time}}.",
    },
    stopped: {
      today: "Arrêté à {{time}}.",
      yesterday: "Arrêté hier à {{time}}.",
      weekday: "Arrêté {{day}} à {{time}}.",
      date: "Arrêté le {{date}} à {{time}}.",
    },
    stoppedNoTime: "Arrêté.",
    stoppedConfigChanged: {
      today: "Arrêté à {{time}} car ses paramètres ont changé.",
      yesterday: "Arrêté hier à {{time}} car ses paramètres ont changé.",
      weekday: "Arrêté {{day}} à {{time}} car ses paramètres ont changé.",
      date: "Arrêté le {{date}} à {{time}} car ses paramètres ont changé.",
    },
    stoppedProcessChanged: {
      today: "Arrêté à {{time}} car son processus a changé.",
      yesterday: "Arrêté hier à {{time}} car son processus a changé.",
      weekday: "Arrêté {{day}} à {{time}} car son processus a changé.",
      date: "Arrêté le {{date}} à {{time}} car son processus a changé.",
    },
    unavailable: "Impossible de démarrer : cet espace de travail est archivé ou introuvable.",
    needsReview:
      "Son lien a été modifié en dehors de Vorteo, il ne peut donc pas démarrer. Demandez au fil Builds de réparer le lien de cet aperçu.",
    restartFailed: "Impossible de démarrer : {{error}}",
    restartFailedNoDetail: "Impossible de démarrer l’aperçu.",
    unconfirmed: "Démarrage pas encore confirmé. Réessayez s’il n’apparaît pas.",
    stopFailed: "Impossible d’arrêter : {{error}}",
    stopFailedNoDetail: "Impossible d’arrêter l’aperçu.",
    stopUnconfirmed: "Arrêt pas encore confirmé. Réessayez s’il continue de s’exécuter.",
    linkWithdrawn: "Lien retiré, mais le serveur est toujours en cours d’exécution.",
  },
  stale: {
    linkWithdrawn: {
      today:
        "Le serveur est en cours d’exécution. Dernier état connu du lien : retiré, vérifié à {{time}}.",
      yesterday:
        "Le serveur est en cours d’exécution. Dernier état connu du lien : retiré, vérifié hier à {{time}}.",
      weekday:
        "Le serveur est en cours d’exécution. Dernier état connu du lien : retiré, vérifié {{day}} à {{time}}.",
      date: "Le serveur est en cours d’exécution. Dernier état connu du lien : retiré, vérifié le {{date}} à {{time}}.",
    },
    linkWithdrawnUnchecked:
      "Le serveur est en cours d’exécution. Dernier état connu du lien : retiré.",
    running: {
      today: "Dernier état connu : en cours d’exécution, vérifié à {{time}}. Pas vérifié depuis.",
      yesterday:
        "Dernier état connu : en cours d’exécution, vérifié hier à {{time}}. Pas vérifié depuis.",
      weekday:
        "Dernier état connu : en cours d’exécution, vérifié {{day}} à {{time}}. Pas vérifié depuis.",
      date: "Dernier état connu : en cours d’exécution, vérifié le {{date}} à {{time}}. Pas vérifié depuis.",
    },
    checksDelayed: {
      today:
        "Dernier état connu : en cours d’exécution avec vérifications retardées, vérifié à {{time}}. Pas vérifié depuis.",
      yesterday:
        "Dernier état connu : en cours d’exécution avec vérifications retardées, vérifié hier à {{time}}. Pas vérifié depuis.",
      weekday:
        "Dernier état connu : en cours d’exécution avec vérifications retardées, vérifié {{day}} à {{time}}. Pas vérifié depuis.",
      date: "Dernier état connu : en cours d’exécution avec vérifications retardées, vérifié le {{date}} à {{time}}. Pas vérifié depuis.",
    },
    checksWithdrawn: {
      today: "Dernier état connu : lien retiré, vérifié à {{time}}. Pas vérifié depuis.",
      yesterday: "Dernier état connu : lien retiré, vérifié hier à {{time}}. Pas vérifié depuis.",
      weekday: "Dernier état connu : lien retiré, vérifié {{day}} à {{time}}. Pas vérifié depuis.",
      date: "Dernier état connu : lien retiré, vérifié le {{date}} à {{time}}. Pas vérifié depuis.",
    },
    starting: {
      today: "Dernier état connu : en démarrage, vérifié à {{time}}. Pas vérifié depuis.",
      yesterday: "Dernier état connu : en démarrage, vérifié hier à {{time}}. Pas vérifié depuis.",
      weekday: "Dernier état connu : en démarrage, vérifié {{day}} à {{time}}. Pas vérifié depuis.",
      date: "Dernier état connu : en démarrage, vérifié le {{date}} à {{time}}. Pas vérifié depuis.",
    },
    notResponding: {
      today: "Dernier état connu : ne répond pas, vérifié à {{time}}. Pas vérifié depuis.",
      yesterday: "Dernier état connu : ne répond pas, vérifié hier à {{time}}. Pas vérifié depuis.",
      weekday:
        "Dernier état connu : ne répond pas, vérifié {{day}} à {{time}}. Pas vérifié depuis.",
      date: "Dernier état connu : ne répond pas, vérifié le {{date}} à {{time}}. Pas vérifié depuis.",
    },
    stopped: {
      today: "Dernier état connu : arrêté à {{time}}. Pas vérifié depuis.",
      yesterday: "Dernier état connu : arrêté hier à {{time}}. Pas vérifié depuis.",
      weekday: "Dernier état connu : arrêté {{day}} à {{time}}. Pas vérifié depuis.",
      date: "Dernier état connu : arrêté le {{date}} à {{time}}. Pas vérifié depuis.",
    },
    unchecked: "Le dernier état connu n’est pas à jour.",
  },
  short: {
    checksDelayed: "Non confirmé",
    checksWithdrawn: "Lien retiré",
    notResponding: "Ne répond pas",
  },
  badge: {
    starting: "Démarrage",
    stopping: "Arrêt en cours",
    notResponding: "Ne répond pas",
    stopped: "Arrêté",
    unavailable: "Indisponible",
    needsRepair: "À réparer",
    didntStart: "Non démarré",
    didntStop: "Non arrêté",
    linkWithdrawn: "Lien retiré",
    unconfirmed: "Non confirmé",
    lastKnown: "Pas à jour",
  },
  actions: {
    start: "Démarrer",
    restart: "Redémarrer",
    retry: "Réessayer",
    stop: "Arrêter",
  },
  confirmRestart: {
    title: "Redémarrer cet aperçu ?",
    message:
      "Il est toujours en cours d’exécution : il va s’arrêter puis redémarrer. Le lien reste le même.",
    confirm: "Redémarrer",
    cancel: "Annuler",
  },
  refusals: {
    busy: "Cet aperçu est déjà en train de démarrer ou de s’arrêter. Réessayez dans une minute.",
    capacity:
      "Plusieurs aperçus sont en train de démarrer ou de s’arrêter. Réessayez dans une minute.",
    archived: "Impossible de démarrer : cet espace de travail est archivé.",
    needsReview:
      "Impossible de démarrer tant que le fil Builds n’a pas réparé le lien de cet aperçu.",
    ownerAppOnly:
      "Pour démarrer des aperçus, il faut le mot de passe Vorteo de {{host}}. Reconnectez-vous avec le mot de passe ou demandez à un agent de le démarrer.",
    ownerAppOnlyUnnamed:
      "Pour démarrer des aperçus, il faut le mot de passe Vorteo de cet hôte. Reconnectez-vous avec le mot de passe ou demandez à un agent de le démarrer.",
    unavailable: "Les aperçus ne sont pas disponibles sur cet hôte pour le moment.",
    failed: "Impossible de démarrer l’aperçu.",
  },
};

const ja: PreviewStatusStrings = {
  line: {
    checksDelayed: "実行中です。確認が遅れています。リンクは有効なままです。",
    checksWithdrawn:
      "確認を完了できなかったため、リンクを取り下げました。確認が完了すると自動的に戻ります。戻らない場合は、プレビューを再起動してください。",
    ready: "プレビューは実行中です。",
    starting: "プレビューを起動しています。",
    stopping: "プレビューを停止しています。",
    notResponding: {
      today: "実行中ですが応答がありません。最終確認は {{time}} です。",
      yesterday: "実行中ですが応答がありません。最終確認は昨日の {{time}} です。",
      weekday: "実行中ですが応答がありません。最終確認は{{day}}の {{time}} です。",
      date: "実行中ですが応答がありません。最終確認は{{date}}の {{time}} です。",
    },
    notRespondingUnchecked: "実行中ですが応答がありません。",
    stoppedByRestart: {
      today: "Vorteo の再起動により {{time}} に停止しました。",
      yesterday: "Vorteo の再起動により昨日の {{time}} に停止しました。",
      weekday: "Vorteo の再起動により{{day}}の {{time}} に停止しました。",
      date: "Vorteo の再起動により{{date}}の {{time}} に停止しました。",
    },
    stopped: {
      today: "{{time}} に停止しました。",
      yesterday: "昨日の {{time}} に停止しました。",
      weekday: "{{day}}の {{time}} に停止しました。",
      date: "{{date}}の {{time}} に停止しました。",
    },
    stoppedNoTime: "停止しました。",
    stoppedConfigChanged: {
      today: "設定が変更されたため、{{time}} に停止しました。",
      yesterday: "設定が変更されたため、昨日の {{time}} に停止しました。",
      weekday: "設定が変更されたため、{{day}}の {{time}} に停止しました。",
      date: "設定が変更されたため、{{date}}の {{time}} に停止しました。",
    },
    stoppedProcessChanged: {
      today: "プロセスが変わったため、{{time}} に停止しました。",
      yesterday: "プロセスが変わったため、昨日の {{time}} に停止しました。",
      weekday: "プロセスが変わったため、{{day}}の {{time}} に停止しました。",
      date: "プロセスが変わったため、{{date}}の {{time}} に停止しました。",
    },
    unavailable: "開始できません: このワークスペースはアーカイブ済みか、見つかりません。",
    needsReview:
      "リンクが Vorteo の外で変更されたため、開始できません。Builds スレッドにこのプレビューのリンクの修復を依頼してください。",
    restartFailed: "開始できませんでした: {{error}}",
    restartFailedNoDetail: "プレビューを開始できませんでした。",
    unconfirmed: "開始をまだ確認できていません。表示されない場合はもう一度お試しください。",
    stopFailed: "停止できませんでした: {{error}}",
    stopFailedNoDetail: "プレビューを停止できませんでした。",
    stopUnconfirmed: "停止をまだ確認できていません。実行が続く場合はもう一度お試しください。",
    linkWithdrawn: "リンクは取り下げられましたが、サーバーはまだ実行中です。",
  },
  stale: {
    linkWithdrawn: {
      today:
        "サーバーは実行中です。リンクの最後の既知の状態は取り下げ済みです（{{time}} に確認）。",
      yesterday:
        "サーバーは実行中です。リンクの最後の既知の状態は取り下げ済みです（昨日の {{time}} に確認）。",
      weekday:
        "サーバーは実行中です。リンクの最後の既知の状態は取り下げ済みです（{{day}}の {{time}} に確認）。",
      date: "サーバーは実行中です。リンクの最後の既知の状態は取り下げ済みです（{{date}}の {{time}} に確認）。",
    },
    linkWithdrawnUnchecked: "サーバーは実行中です。リンクの最後の既知の状態は取り下げ済みです。",
    running: {
      today: "最後の既知の状態: 実行中（{{time}} に確認）。以降は確認されていません。",
      yesterday: "最後の既知の状態: 実行中（昨日の {{time}} に確認）。以降は確認されていません。",
      weekday: "最後の既知の状態: 実行中（{{day}}の {{time}} に確認）。以降は確認されていません。",
      date: "最後の既知の状態: 実行中（{{date}}の {{time}} に確認）。以降は確認されていません。",
    },
    checksDelayed: {
      today: "最後の既知の状態: 実行中・確認遅延（{{time}} に確認）。以降は確認されていません。",
      yesterday:
        "最後の既知の状態: 実行中・確認遅延（昨日の {{time}} に確認）。以降は確認されていません。",
      weekday:
        "最後の既知の状態: 実行中・確認遅延（{{day}}の {{time}} に確認）。以降は確認されていません。",
      date: "最後の既知の状態: 実行中・確認遅延（{{date}}の {{time}} に確認）。以降は確認されていません。",
    },
    checksWithdrawn: {
      today: "最後の既知の状態: リンク取り下げ済み（{{time}} に確認）。以降は確認されていません。",
      yesterday:
        "最後の既知の状態: リンク取り下げ済み（昨日の {{time}} に確認）。以降は確認されていません。",
      weekday:
        "最後の既知の状態: リンク取り下げ済み（{{day}}の {{time}} に確認）。以降は確認されていません。",
      date: "最後の既知の状態: リンク取り下げ済み（{{date}}の {{time}} に確認）。以降は確認されていません。",
    },
    starting: {
      today: "最後の既知の状態: 起動中（{{time}} に確認）。以降は確認されていません。",
      yesterday: "最後の既知の状態: 起動中（昨日の {{time}} に確認）。以降は確認されていません。",
      weekday: "最後の既知の状態: 起動中（{{day}}の {{time}} に確認）。以降は確認されていません。",
      date: "最後の既知の状態: 起動中（{{date}}の {{time}} に確認）。以降は確認されていません。",
    },
    notResponding: {
      today: "最後の既知の状態: 応答なし（{{time}} に確認）。以降は確認されていません。",
      yesterday: "最後の既知の状態: 応答なし（昨日の {{time}} に確認）。以降は確認されていません。",
      weekday:
        "最後の既知の状態: 応答なし（{{day}}の {{time}} に確認）。以降は確認されていません。",
      date: "最後の既知の状態: 応答なし（{{date}}の {{time}} に確認）。以降は確認されていません。",
    },
    stopped: {
      today: "最後の既知の状態: {{time}} に停止。以降は確認されていません。",
      yesterday: "最後の既知の状態: 昨日の {{time}} に停止。以降は確認されていません。",
      weekday: "最後の既知の状態: {{day}}の {{time}} に停止。以降は確認されていません。",
      date: "最後の既知の状態: {{date}}の {{time}} に停止。以降は確認されていません。",
    },
    unchecked: "最後の既知の状態は最新ではありません。",
  },
  short: {
    checksDelayed: "未確認",
    checksWithdrawn: "リンク取り下げ",
    notResponding: "応答なし",
  },
  badge: {
    starting: "起動中",
    stopping: "停止中",
    notResponding: "応答なし",
    stopped: "停止",
    unavailable: "利用不可",
    needsRepair: "要修復",
    didntStart: "開始失敗",
    didntStop: "停止失敗",
    linkWithdrawn: "リンク取り下げ",
    unconfirmed: "未確認",
    lastKnown: "最新ではない",
  },
  actions: {
    start: "開始",
    restart: "再起動",
    retry: "再試行",
    stop: "停止",
  },
  confirmRestart: {
    title: "このプレビューを再起動しますか？",
    message: "まだ実行中のため、停止してから再び開始します。リンクは変わりません。",
    confirm: "再起動",
    cancel: "キャンセル",
  },
  refusals: {
    busy: "このプレビューはすでに開始中または停止中です。1 分後にもう一度お試しください。",
    capacity: "複数のプレビューが開始中または停止中です。1 分後にもう一度お試しください。",
    archived: "開始できません: このワークスペースはアーカイブ済みです。",
    needsReview: "Builds スレッドがこのプレビューのリンクを修復するまで開始できません。",
    ownerAppOnly:
      "プレビューを開始するには {{host}} の Vorteo パスワードが必要です。パスワードで再接続するか、エージェントに開始を依頼してください。",
    ownerAppOnlyUnnamed:
      "プレビューを開始するにはこのホストの Vorteo パスワードが必要です。パスワードで再接続するか、エージェントに開始を依頼してください。",
    unavailable: "現在、このホストではプレビューを利用できません。",
    failed: "プレビューを開始できませんでした。",
  },
};

const ko: PreviewStatusStrings = {
  line: {
    checksDelayed: "실행 중입니다. 확인이 지연되고 있습니다. 링크는 계속 유지됩니다.",
    checksWithdrawn:
      "확인을 완료하지 못해 링크를 회수했습니다. 확인이 완료되면 자동으로 돌아옵니다. 돌아오지 않으면 미리보기를 다시 시작하세요.",
    ready: "미리보기가 실행 중입니다.",
    starting: "미리보기를 시작하는 중입니다.",
    stopping: "미리보기를 중지하는 중입니다.",
    notResponding: {
      today: "실행 중이지만 응답하지 않습니다. 마지막 확인: {{time}}.",
      yesterday: "실행 중이지만 응답하지 않습니다. 마지막 확인: 어제 {{time}}.",
      weekday: "실행 중이지만 응답하지 않습니다. 마지막 확인: {{day}} {{time}}.",
      date: "실행 중이지만 응답하지 않습니다. 마지막 확인: {{date}} {{time}}.",
    },
    notRespondingUnchecked: "실행 중이지만 응답하지 않습니다.",
    stoppedByRestart: {
      today: "Vorteo가 {{time}}에 다시 시작되면서 중지되었습니다.",
      yesterday: "Vorteo가 어제 {{time}}에 다시 시작되면서 중지되었습니다.",
      weekday: "Vorteo가 {{day}} {{time}}에 다시 시작되면서 중지되었습니다.",
      date: "Vorteo가 {{date}} {{time}}에 다시 시작되면서 중지되었습니다.",
    },
    stopped: {
      today: "{{time}}에 중지되었습니다.",
      yesterday: "어제 {{time}}에 중지되었습니다.",
      weekday: "{{day}} {{time}}에 중지되었습니다.",
      date: "{{date}} {{time}}에 중지되었습니다.",
    },
    stoppedNoTime: "중지되었습니다.",
    stoppedConfigChanged: {
      today: "설정이 변경되어 {{time}}에 중지되었습니다.",
      yesterday: "설정이 변경되어 어제 {{time}}에 중지되었습니다.",
      weekday: "설정이 변경되어 {{day}} {{time}}에 중지되었습니다.",
      date: "설정이 변경되어 {{date}} {{time}}에 중지되었습니다.",
    },
    stoppedProcessChanged: {
      today: "프로세스가 바뀌어 {{time}}에 중지되었습니다.",
      yesterday: "프로세스가 바뀌어 어제 {{time}}에 중지되었습니다.",
      weekday: "프로세스가 바뀌어 {{day}} {{time}}에 중지되었습니다.",
      date: "프로세스가 바뀌어 {{date}} {{time}}에 중지되었습니다.",
    },
    unavailable: "시작할 수 없습니다: 이 워크스페이스가 보관되었거나 없습니다.",
    needsReview:
      "링크가 Vorteo 밖에서 변경되어 시작할 수 없습니다. Builds 스레드에 이 미리보기의 링크를 복구해 달라고 요청하세요.",
    restartFailed: "시작하지 못했습니다: {{error}}",
    restartFailedNoDetail: "미리보기를 시작하지 못했습니다.",
    unconfirmed: "아직 시작을 확인하지 못했습니다. 나타나지 않으면 다시 시도하세요.",
    stopFailed: "중지하지 못했습니다: {{error}}",
    stopFailedNoDetail: "미리보기를 중지하지 못했습니다.",
    stopUnconfirmed: "아직 중지를 확인하지 못했습니다. 계속 실행 중이면 다시 시도하세요.",
    linkWithdrawn: "링크가 회수되었지만 서버는 아직 실행 중입니다.",
  },
  stale: {
    linkWithdrawn: {
      today:
        "서버가 실행 중입니다. 마지막으로 확인된 링크 상태는 회수됨이며 {{time}}에 확인했습니다.",
      yesterday:
        "서버가 실행 중입니다. 마지막으로 확인된 링크 상태는 회수됨이며 어제 {{time}}에 확인했습니다.",
      weekday:
        "서버가 실행 중입니다. 마지막으로 확인된 링크 상태는 회수됨이며 {{day}} {{time}}에 확인했습니다.",
      date: "서버가 실행 중입니다. 마지막으로 확인된 링크 상태는 회수됨이며 {{date}} {{time}}에 확인했습니다.",
    },
    linkWithdrawnUnchecked: "서버가 실행 중입니다. 마지막으로 확인된 링크 상태는 회수됨입니다.",
    running: {
      today: "마지막으로 확인된 상태: 실행 중, {{time}}에 확인. 이후 확인되지 않았습니다.",
      yesterday: "마지막으로 확인된 상태: 실행 중, 어제 {{time}}에 확인. 이후 확인되지 않았습니다.",
      weekday:
        "마지막으로 확인된 상태: 실행 중, {{day}} {{time}}에 확인. 이후 확인되지 않았습니다.",
      date: "마지막으로 확인된 상태: 실행 중, {{date}} {{time}}에 확인. 이후 확인되지 않았습니다.",
    },
    checksDelayed: {
      today:
        "마지막으로 확인된 상태: 실행 중(확인 지연), {{time}}에 확인. 이후 확인되지 않았습니다.",
      yesterday:
        "마지막으로 확인된 상태: 실행 중(확인 지연), 어제 {{time}}에 확인. 이후 확인되지 않았습니다.",
      weekday:
        "마지막으로 확인된 상태: 실행 중(확인 지연), {{day}} {{time}}에 확인. 이후 확인되지 않았습니다.",
      date: "마지막으로 확인된 상태: 실행 중(확인 지연), {{date}} {{time}}에 확인. 이후 확인되지 않았습니다.",
    },
    checksWithdrawn: {
      today: "마지막으로 확인된 상태: 링크 회수됨, {{time}}에 확인. 이후 확인되지 않았습니다.",
      yesterday:
        "마지막으로 확인된 상태: 링크 회수됨, 어제 {{time}}에 확인. 이후 확인되지 않았습니다.",
      weekday:
        "마지막으로 확인된 상태: 링크 회수됨, {{day}} {{time}}에 확인. 이후 확인되지 않았습니다.",
      date: "마지막으로 확인된 상태: 링크 회수됨, {{date}} {{time}}에 확인. 이후 확인되지 않았습니다.",
    },
    starting: {
      today: "마지막으로 확인된 상태: 시작 중, {{time}}에 확인. 이후 확인되지 않았습니다.",
      yesterday: "마지막으로 확인된 상태: 시작 중, 어제 {{time}}에 확인. 이후 확인되지 않았습니다.",
      weekday:
        "마지막으로 확인된 상태: 시작 중, {{day}} {{time}}에 확인. 이후 확인되지 않았습니다.",
      date: "마지막으로 확인된 상태: 시작 중, {{date}} {{time}}에 확인. 이후 확인되지 않았습니다.",
    },
    notResponding: {
      today: "마지막으로 확인된 상태: 응답 없음, {{time}}에 확인. 이후 확인되지 않았습니다.",
      yesterday:
        "마지막으로 확인된 상태: 응답 없음, 어제 {{time}}에 확인. 이후 확인되지 않았습니다.",
      weekday:
        "마지막으로 확인된 상태: 응답 없음, {{day}} {{time}}에 확인. 이후 확인되지 않았습니다.",
      date: "마지막으로 확인된 상태: 응답 없음, {{date}} {{time}}에 확인. 이후 확인되지 않았습니다.",
    },
    stopped: {
      today: "마지막으로 확인된 상태: {{time}}에 중지됨. 이후 확인되지 않았습니다.",
      yesterday: "마지막으로 확인된 상태: 어제 {{time}}에 중지됨. 이후 확인되지 않았습니다.",
      weekday: "마지막으로 확인된 상태: {{day}} {{time}}에 중지됨. 이후 확인되지 않았습니다.",
      date: "마지막으로 확인된 상태: {{date}} {{time}}에 중지됨. 이후 확인되지 않았습니다.",
    },
    unchecked: "마지막으로 확인된 상태는 최신이 아닙니다.",
  },
  short: {
    checksDelayed: "확인 안 됨",
    checksWithdrawn: "링크 회수됨",
    notResponding: "응답 없음",
  },
  badge: {
    starting: "시작 중",
    stopping: "중지 중",
    notResponding: "응답 없음",
    stopped: "중지됨",
    unavailable: "사용 불가",
    needsRepair: "복구 필요",
    didntStart: "시작 실패",
    didntStop: "중지 실패",
    linkWithdrawn: "링크 회수됨",
    unconfirmed: "확인 안 됨",
    lastKnown: "최신 아님",
  },
  actions: {
    start: "시작",
    restart: "다시 시작",
    retry: "다시 시도",
    stop: "중지",
  },
  confirmRestart: {
    title: "이 미리보기를 다시 시작할까요?",
    message: "아직 실행 중이므로 중지한 다음 다시 시작합니다. 링크는 그대로입니다.",
    confirm: "다시 시작",
    cancel: "취소",
  },
  refusals: {
    busy: "이 미리보기는 이미 시작하거나 중지하는 중입니다. 1분 후에 다시 시도하세요.",
    capacity: "여러 미리보기가 시작하거나 중지하는 중입니다. 1분 후에 다시 시도하세요.",
    archived: "시작할 수 없습니다: 이 워크스페이스가 보관되었습니다.",
    needsReview: "Builds 스레드가 이 미리보기의 링크를 복구할 때까지 시작할 수 없습니다.",
    ownerAppOnly:
      "미리보기를 시작하려면 {{host}}의 Vorteo 비밀번호가 필요합니다. 비밀번호로 다시 연결하거나 에이전트에게 시작을 요청하세요.",
    ownerAppOnlyUnnamed:
      "미리보기를 시작하려면 이 호스트의 Vorteo 비밀번호가 필요합니다. 비밀번호로 다시 연결하거나 에이전트에게 시작을 요청하세요.",
    unavailable: "지금은 이 호스트에서 미리보기를 사용할 수 없습니다.",
    failed: "미리보기를 시작하지 못했습니다.",
  },
};

const ptBR: PreviewStatusStrings = {
  line: {
    checksDelayed: "Em execução. As verificações estão atrasadas. O link continua ativo.",
    checksWithdrawn:
      "Link retirado porque as verificações não puderam terminar. Ele volta sozinho quando uma terminar. Se não voltar, reinicie a prévia.",
    ready: "A prévia está em execução.",
    starting: "Iniciando a prévia.",
    stopping: "Parando a prévia.",
    notResponding: {
      today: "Em execução, mas sem resposta. Última verificação às {{time}}.",
      yesterday: "Em execução, mas sem resposta. Última verificação ontem às {{time}}.",
      weekday: "Em execução, mas sem resposta. Última verificação: {{day}}, às {{time}}.",
      date: "Em execução, mas sem resposta. Última verificação em {{date}}, às {{time}}.",
    },
    notRespondingUnchecked: "Em execução, mas sem resposta.",
    stoppedByRestart: {
      today: "Parou quando o Vorteo reiniciou às {{time}}.",
      yesterday: "Parou quando o Vorteo reiniciou ontem às {{time}}.",
      weekday: "Parou quando o Vorteo reiniciou: {{day}}, às {{time}}.",
      date: "Parou quando o Vorteo reiniciou em {{date}}, às {{time}}.",
    },
    stopped: {
      today: "Parou às {{time}}.",
      yesterday: "Parou ontem às {{time}}.",
      weekday: "Parou: {{day}}, às {{time}}.",
      date: "Parou em {{date}}, às {{time}}.",
    },
    stoppedNoTime: "Parada.",
    stoppedConfigChanged: {
      today: "Parou às {{time}} porque as configurações mudaram.",
      yesterday: "Parou ontem às {{time}} porque as configurações mudaram.",
      weekday: "Parou {{day}}, às {{time}}, porque as configurações mudaram.",
      date: "Parou em {{date}}, às {{time}}, porque as configurações mudaram.",
    },
    stoppedProcessChanged: {
      today: "Parou às {{time}} porque o processo mudou.",
      yesterday: "Parou ontem às {{time}} porque o processo mudou.",
      weekday: "Parou {{day}}, às {{time}}, porque o processo mudou.",
      date: "Parou em {{date}}, às {{time}}, porque o processo mudou.",
    },
    unavailable: "Não é possível iniciar: este espaço de trabalho está arquivado ou não existe.",
    needsReview:
      "O link foi alterado fora do Vorteo, então a prévia não pode iniciar. Peça ao thread Builds para reparar o link desta prévia.",
    restartFailed: "Não foi possível iniciar: {{error}}",
    restartFailedNoDetail: "Não foi possível iniciar a prévia.",
    unconfirmed: "Ainda não foi possível confirmar o início. Tente novamente se ela não aparecer.",
    stopFailed: "Não foi possível parar: {{error}}",
    stopFailedNoDetail: "Não foi possível parar a prévia.",
    stopUnconfirmed:
      "Ainda não foi possível confirmar a parada. Tente novamente se ela continuar em execução.",
    linkWithdrawn: "Link retirado, mas o servidor ainda está em execução.",
  },
  stale: {
    linkWithdrawn: {
      today:
        "O servidor está em execução. Último estado conhecido do link: retirado, verificado às {{time}}.",
      yesterday:
        "O servidor está em execução. Último estado conhecido do link: retirado, verificado ontem às {{time}}.",
      weekday:
        "O servidor está em execução. Último estado conhecido do link: retirado, verificado {{day}}, às {{time}}.",
      date: "O servidor está em execução. Último estado conhecido do link: retirado, verificado em {{date}}, às {{time}}.",
    },
    linkWithdrawnUnchecked:
      "O servidor está em execução. Último estado conhecido do link: retirado.",
    running: {
      today:
        "Último estado conhecido: em execução, verificado às {{time}}. Não verificado desde então.",
      yesterday:
        "Último estado conhecido: em execução, verificado ontem às {{time}}. Não verificado desde então.",
      weekday:
        "Último estado conhecido: em execução, verificado {{day}}, às {{time}}. Não verificado desde então.",
      date: "Último estado conhecido: em execução, verificado em {{date}}, às {{time}}. Não verificado desde então.",
    },
    checksDelayed: {
      today:
        "Último estado conhecido: em execução com verificações atrasadas, verificado às {{time}}. Não verificado desde então.",
      yesterday:
        "Último estado conhecido: em execução com verificações atrasadas, verificado ontem às {{time}}. Não verificado desde então.",
      weekday:
        "Último estado conhecido: em execução com verificações atrasadas, verificado {{day}}, às {{time}}. Não verificado desde então.",
      date: "Último estado conhecido: em execução com verificações atrasadas, verificado em {{date}}, às {{time}}. Não verificado desde então.",
    },
    checksWithdrawn: {
      today:
        "Último estado conhecido: link retirado, verificado às {{time}}. Não verificado desde então.",
      yesterday:
        "Último estado conhecido: link retirado, verificado ontem às {{time}}. Não verificado desde então.",
      weekday:
        "Último estado conhecido: link retirado, verificado {{day}}, às {{time}}. Não verificado desde então.",
      date: "Último estado conhecido: link retirado, verificado em {{date}}, às {{time}}. Não verificado desde então.",
    },
    starting: {
      today:
        "Último estado conhecido: iniciando, verificado às {{time}}. Não verificado desde então.",
      yesterday:
        "Último estado conhecido: iniciando, verificado ontem às {{time}}. Não verificado desde então.",
      weekday:
        "Último estado conhecido: iniciando, verificado {{day}}, às {{time}}. Não verificado desde então.",
      date: "Último estado conhecido: iniciando, verificado em {{date}}, às {{time}}. Não verificado desde então.",
    },
    notResponding: {
      today:
        "Último estado conhecido: sem resposta, verificado às {{time}}. Não verificado desde então.",
      yesterday:
        "Último estado conhecido: sem resposta, verificado ontem às {{time}}. Não verificado desde então.",
      weekday:
        "Último estado conhecido: sem resposta, verificado {{day}}, às {{time}}. Não verificado desde então.",
      date: "Último estado conhecido: sem resposta, verificado em {{date}}, às {{time}}. Não verificado desde então.",
    },
    stopped: {
      today: "Último estado conhecido: parada às {{time}}. Não verificado desde então.",
      yesterday: "Último estado conhecido: parada ontem às {{time}}. Não verificado desde então.",
      weekday: "Último estado conhecido: parada {{day}}, às {{time}}. Não verificado desde então.",
      date: "Último estado conhecido: parada em {{date}}, às {{time}}. Não verificado desde então.",
    },
    unchecked: "O último estado conhecido não está atualizado.",
  },
  short: {
    checksDelayed: "Não confirmado",
    checksWithdrawn: "Link retirado",
    notResponding: "Sem resposta",
  },
  badge: {
    starting: "Iniciando",
    stopping: "Parando",
    notResponding: "Sem resposta",
    stopped: "Parada",
    unavailable: "Indisponível",
    needsRepair: "Precisa reparo",
    didntStart: "Não iniciou",
    didntStop: "Não parou",
    linkWithdrawn: "Link retirado",
    unconfirmed: "Não confirmado",
    lastKnown: "Desatualizado",
  },
  actions: {
    start: "Iniciar",
    restart: "Reiniciar",
    retry: "Tentar de novo",
    stop: "Parar",
  },
  confirmRestart: {
    title: "Reiniciar esta prévia?",
    message:
      "Ela ainda está em execução, então vai parar e iniciar de novo. O link continua o mesmo.",
    confirm: "Reiniciar",
    cancel: "Cancelar",
  },
  refusals: {
    busy: "Esta prévia já está iniciando ou parando. Tente novamente em um minuto.",
    capacity: "Várias prévias estão iniciando ou parando. Tente novamente em um minuto.",
    archived: "Não é possível iniciar: este espaço de trabalho está arquivado.",
    needsReview: "Não é possível iniciar até que o thread Builds repare o link desta prévia.",
    ownerAppOnly:
      "Iniciar prévias exige a senha do Vorteo de {{host}}. Reconecte-se com a senha ou peça a um agente para iniciá-la.",
    ownerAppOnlyUnnamed:
      "Iniciar prévias exige a senha do Vorteo deste host. Reconecte-se com a senha ou peça a um agente para iniciá-la.",
    unavailable: "As prévias não estão disponíveis neste host no momento.",
    failed: "Não foi possível iniciar a prévia.",
  },
};

const ru: PreviewStatusStrings = {
  line: {
    checksDelayed: "Работает. Проверки задерживаются. Ссылка остаётся доступной.",
    checksWithdrawn:
      "Ссылка отозвана, потому что проверки не удалось завершить. Она вернётся сама, когда проверка пройдёт. Если этого не случится, перезапустите предпросмотр.",
    ready: "Предпросмотр запущен.",
    starting: "Предпросмотр запускается.",
    stopping: "Предпросмотр останавливается.",
    notResponding: {
      today: "Запущен, но не отвечает. Последняя проверка в {{time}}.",
      yesterday: "Запущен, но не отвечает. Последняя проверка вчера в {{time}}.",
      weekday: "Запущен, но не отвечает. Последняя проверка: {{day}}, {{time}}.",
      date: "Запущен, но не отвечает. Последняя проверка: {{date}}, {{time}}.",
    },
    notRespondingUnchecked: "Запущен, но не отвечает.",
    stoppedByRestart: {
      today: "Остановлен при перезапуске Vorteo в {{time}}.",
      yesterday: "Остановлен при перезапуске Vorteo вчера в {{time}}.",
      weekday: "Остановлен при перезапуске Vorteo: {{day}}, {{time}}.",
      date: "Остановлен при перезапуске Vorteo: {{date}}, {{time}}.",
    },
    stopped: {
      today: "Остановлен в {{time}}.",
      yesterday: "Остановлен вчера в {{time}}.",
      weekday: "Остановлен: {{day}}, {{time}}.",
      date: "Остановлен: {{date}}, {{time}}.",
    },
    stoppedNoTime: "Остановлен.",
    stoppedConfigChanged: {
      today: "Остановлен в {{time}}, потому что изменились его настройки.",
      yesterday: "Остановлен вчера в {{time}}, потому что изменились его настройки.",
      weekday: "Остановлен: {{day}}, {{time}}, потому что изменились его настройки.",
      date: "Остановлен: {{date}}, {{time}}, потому что изменились его настройки.",
    },
    stoppedProcessChanged: {
      today: "Остановлен в {{time}}, потому что изменился его процесс.",
      yesterday: "Остановлен вчера в {{time}}, потому что изменился его процесс.",
      weekday: "Остановлен: {{day}}, {{time}}, потому что изменился его процесс.",
      date: "Остановлен: {{date}}, {{time}}, потому что изменился его процесс.",
    },
    unavailable: "Не удаётся запустить: это рабочее пространство архивировано или отсутствует.",
    needsReview:
      "Его ссылка изменена вне Vorteo, поэтому он не может запуститься. Попросите тред Builds восстановить ссылку этого предпросмотра.",
    restartFailed: "Не удалось запустить: {{error}}",
    restartFailedNoDetail: "Не удалось запустить предпросмотр.",
    unconfirmed: "Запуск пока не подтверждён. Попробуйте ещё раз, если он не появится.",
    stopFailed: "Не удалось остановить: {{error}}",
    stopFailedNoDetail: "Не удалось остановить предпросмотр.",
    stopUnconfirmed:
      "Остановка пока не подтверждена. Попробуйте ещё раз, если он продолжит работать.",
    linkWithdrawn: "Ссылка отозвана, но сервер всё ещё работает.",
  },
  stale: {
    linkWithdrawn: {
      today:
        "Сервер работает. Последнее известное состояние ссылки: отозвана, проверено в {{time}}.",
      yesterday:
        "Сервер работает. Последнее известное состояние ссылки: отозвана, проверено вчера в {{time}}.",
      weekday:
        "Сервер работает. Последнее известное состояние ссылки: отозвана, проверено: {{day}}, {{time}}.",
      date: "Сервер работает. Последнее известное состояние ссылки: отозвана, проверено: {{date}}, {{time}}.",
    },
    linkWithdrawnUnchecked: "Сервер работает. Последнее известное состояние ссылки: отозвана.",
    running: {
      today:
        "Последнее известное состояние: запущен, проверено в {{time}}. С тех пор не проверялось.",
      yesterday:
        "Последнее известное состояние: запущен, проверено вчера в {{time}}. С тех пор не проверялось.",
      weekday:
        "Последнее известное состояние: запущен, проверено: {{day}}, {{time}}. С тех пор не проверялось.",
      date: "Последнее известное состояние: запущен, проверено: {{date}}, {{time}}. С тех пор не проверялось.",
    },
    checksDelayed: {
      today:
        "Последнее известное состояние: запущен с задержкой проверок, проверено в {{time}}. С тех пор не проверялось.",
      yesterday:
        "Последнее известное состояние: запущен с задержкой проверок, проверено вчера в {{time}}. С тех пор не проверялось.",
      weekday:
        "Последнее известное состояние: запущен с задержкой проверок, проверено: {{day}}, {{time}}. С тех пор не проверялось.",
      date: "Последнее известное состояние: запущен с задержкой проверок, проверено: {{date}}, {{time}}. С тех пор не проверялось.",
    },
    checksWithdrawn: {
      today:
        "Последнее известное состояние: ссылка отозвана, проверено в {{time}}. С тех пор не проверялось.",
      yesterday:
        "Последнее известное состояние: ссылка отозвана, проверено вчера в {{time}}. С тех пор не проверялось.",
      weekday:
        "Последнее известное состояние: ссылка отозвана, проверено: {{day}}, {{time}}. С тех пор не проверялось.",
      date: "Последнее известное состояние: ссылка отозвана, проверено: {{date}}, {{time}}. С тех пор не проверялось.",
    },
    starting: {
      today:
        "Последнее известное состояние: запускается, проверено в {{time}}. С тех пор не проверялось.",
      yesterday:
        "Последнее известное состояние: запускается, проверено вчера в {{time}}. С тех пор не проверялось.",
      weekday:
        "Последнее известное состояние: запускается, проверено: {{day}}, {{time}}. С тех пор не проверялось.",
      date: "Последнее известное состояние: запускается, проверено: {{date}}, {{time}}. С тех пор не проверялось.",
    },
    notResponding: {
      today:
        "Последнее известное состояние: не отвечает, проверено в {{time}}. С тех пор не проверялось.",
      yesterday:
        "Последнее известное состояние: не отвечает, проверено вчера в {{time}}. С тех пор не проверялось.",
      weekday:
        "Последнее известное состояние: не отвечает, проверено: {{day}}, {{time}}. С тех пор не проверялось.",
      date: "Последнее известное состояние: не отвечает, проверено: {{date}}, {{time}}. С тех пор не проверялось.",
    },
    stopped: {
      today: "Последнее известное состояние: остановлен в {{time}}. С тех пор не проверялось.",
      yesterday:
        "Последнее известное состояние: остановлен вчера в {{time}}. С тех пор не проверялось.",
      weekday:
        "Последнее известное состояние: остановлен: {{day}}, {{time}}. С тех пор не проверялось.",
      date: "Последнее известное состояние: остановлен: {{date}}, {{time}}. С тех пор не проверялось.",
    },
    unchecked: "Последнее известное состояние устарело.",
  },
  short: {
    checksDelayed: "Не подтверждено",
    checksWithdrawn: "Ссылка отозвана",
    notResponding: "Не отвечает",
  },
  badge: {
    starting: "Запускается",
    stopping: "Останавливается",
    notResponding: "Не отвечает",
    stopped: "Остановлен",
    unavailable: "Недоступен",
    needsRepair: "Нужен ремонт",
    didntStart: "Не запустился",
    didntStop: "Не остановлен",
    linkWithdrawn: "Ссылка отозвана",
    unconfirmed: "Не подтверждено",
    lastKnown: "Устарело",
  },
  actions: {
    start: "Запустить",
    restart: "Перезапустить",
    retry: "Повторить",
    stop: "Остановить",
  },
  confirmRestart: {
    title: "Перезапустить предпросмотр?",
    message: "Он ещё работает, поэтому остановится и запустится снова. Ссылка останется прежней.",
    confirm: "Перезапустить",
    cancel: "Отмена",
  },
  refusals: {
    busy: "Этот предпросмотр уже запускается или останавливается. Попробуйте ещё раз через минуту.",
    capacity:
      "Несколько предпросмотров запускаются или останавливаются. Попробуйте ещё раз через минуту.",
    archived: "Не удаётся запустить: это рабочее пространство архивировано.",
    needsReview: "Запуск невозможен, пока тред Builds не восстановит ссылку этого предпросмотра.",
    ownerAppOnly:
      "Для запуска предпросмотров нужен пароль Vorteo для {{host}}. Переподключитесь с паролем или попросите агента запустить его.",
    ownerAppOnlyUnnamed:
      "Для запуска предпросмотров нужен пароль Vorteo этого хоста. Переподключитесь с паролем или попросите агента запустить его.",
    unavailable: "Предпросмотры сейчас недоступны на этом хосте.",
    failed: "Не удалось запустить предпросмотр.",
  },
};

const zhCN: PreviewStatusStrings = {
  line: {
    checksDelayed: "正在运行。检查有所延迟。链接保持可用。",
    checksWithdrawn:
      "由于检查无法完成，链接已撤回。检查完成后会自动恢复。如果没有恢复，请重启预览。",
    ready: "预览正在运行。",
    starting: "正在启动预览。",
    stopping: "正在停止预览。",
    notResponding: {
      today: "正在运行，但没有响应。最后检查于 {{time}}。",
      yesterday: "正在运行，但没有响应。最后检查于昨天 {{time}}。",
      weekday: "正在运行，但没有响应。最后检查于{{day}} {{time}}。",
      date: "正在运行，但没有响应。最后检查于 {{date}} {{time}}。",
    },
    notRespondingUnchecked: "正在运行，但没有响应。",
    stoppedByRestart: {
      today: "Vorteo 于 {{time}} 重启时停止。",
      yesterday: "Vorteo 于昨天 {{time}} 重启时停止。",
      weekday: "Vorteo 于{{day}} {{time}} 重启时停止。",
      date: "Vorteo 于 {{date}} {{time}} 重启时停止。",
    },
    stopped: {
      today: "已于 {{time}} 停止。",
      yesterday: "已于昨天 {{time}} 停止。",
      weekday: "已于{{day}} {{time}} 停止。",
      date: "已于 {{date}} {{time}} 停止。",
    },
    stoppedNoTime: "已停止。",
    stoppedConfigChanged: {
      today: "因设置更改，已于 {{time}} 停止。",
      yesterday: "因设置更改，已于昨天 {{time}} 停止。",
      weekday: "因设置更改，已于{{day}} {{time}} 停止。",
      date: "因设置更改，已于 {{date}} {{time}} 停止。",
    },
    stoppedProcessChanged: {
      today: "因进程变化，已于 {{time}} 停止。",
      yesterday: "因进程变化，已于昨天 {{time}} 停止。",
      weekday: "因进程变化，已于{{day}} {{time}} 停止。",
      date: "因进程变化，已于 {{date}} {{time}} 停止。",
    },
    unavailable: "无法启动：此工作区已归档或不存在。",
    needsReview: "它的链接在 Vorteo 之外被修改，因此无法启动。请让 Builds 线程修复此预览的链接。",
    restartFailed: "无法启动：{{error}}",
    restartFailedNoDetail: "无法启动预览。",
    unconfirmed: "尚未确认已启动。如果它没有出现，请重试。",
    stopFailed: "无法停止：{{error}}",
    stopFailedNoDetail: "无法停止预览。",
    stopUnconfirmed: "尚未确认已停止。如果它仍在运行，请重试。",
    linkWithdrawn: "链接已撤回，但服务器仍在运行。",
  },
  stale: {
    linkWithdrawn: {
      today: "服务器正在运行。链接最后已知状态为已撤回，检查于 {{time}}。",
      yesterday: "服务器正在运行。链接最后已知状态为已撤回，检查于昨天 {{time}}。",
      weekday: "服务器正在运行。链接最后已知状态为已撤回，检查于{{day}} {{time}}。",
      date: "服务器正在运行。链接最后已知状态为已撤回，检查于 {{date}} {{time}}。",
    },
    linkWithdrawnUnchecked: "服务器正在运行。链接最后已知状态为已撤回。",
    running: {
      today: "最后已知状态：运行中，检查于 {{time}}。此后未再检查。",
      yesterday: "最后已知状态：运行中，检查于昨天 {{time}}。此后未再检查。",
      weekday: "最后已知状态：运行中，检查于{{day}} {{time}}。此后未再检查。",
      date: "最后已知状态：运行中，检查于 {{date}} {{time}}。此后未再检查。",
    },
    checksDelayed: {
      today: "最后已知状态：运行中（检查延迟），检查于 {{time}}。此后未再检查。",
      yesterday: "最后已知状态：运行中（检查延迟），检查于昨天 {{time}}。此后未再检查。",
      weekday: "最后已知状态：运行中（检查延迟），检查于{{day}} {{time}}。此后未再检查。",
      date: "最后已知状态：运行中（检查延迟），检查于 {{date}} {{time}}。此后未再检查。",
    },
    checksWithdrawn: {
      today: "最后已知状态：链接已撤回，检查于 {{time}}。此后未再检查。",
      yesterday: "最后已知状态：链接已撤回，检查于昨天 {{time}}。此后未再检查。",
      weekday: "最后已知状态：链接已撤回，检查于{{day}} {{time}}。此后未再检查。",
      date: "最后已知状态：链接已撤回，检查于 {{date}} {{time}}。此后未再检查。",
    },
    starting: {
      today: "最后已知状态：启动中，检查于 {{time}}。此后未再检查。",
      yesterday: "最后已知状态：启动中，检查于昨天 {{time}}。此后未再检查。",
      weekday: "最后已知状态：启动中，检查于{{day}} {{time}}。此后未再检查。",
      date: "最后已知状态：启动中，检查于 {{date}} {{time}}。此后未再检查。",
    },
    notResponding: {
      today: "最后已知状态：无响应，检查于 {{time}}。此后未再检查。",
      yesterday: "最后已知状态：无响应，检查于昨天 {{time}}。此后未再检查。",
      weekday: "最后已知状态：无响应，检查于{{day}} {{time}}。此后未再检查。",
      date: "最后已知状态：无响应，检查于 {{date}} {{time}}。此后未再检查。",
    },
    stopped: {
      today: "最后已知状态：于 {{time}} 停止。此后未再检查。",
      yesterday: "最后已知状态：于昨天 {{time}} 停止。此后未再检查。",
      weekday: "最后已知状态：于{{day}} {{time}} 停止。此后未再检查。",
      date: "最后已知状态：于 {{date}} {{time}} 停止。此后未再检查。",
    },
    unchecked: "最后已知状态不是最新的。",
  },
  short: {
    checksDelayed: "未确认",
    checksWithdrawn: "链接已撤回",
    notResponding: "无响应",
  },
  badge: {
    starting: "启动中",
    stopping: "停止中",
    notResponding: "无响应",
    stopped: "已停止",
    unavailable: "不可用",
    needsRepair: "需要修复",
    didntStart: "未能启动",
    didntStop: "未能停止",
    linkWithdrawn: "链接已撤回",
    unconfirmed: "未确认",
    lastKnown: "最后已知",
  },
  actions: {
    start: "启动",
    restart: "重启",
    retry: "重试",
    stop: "停止",
  },
  confirmRestart: {
    title: "重启此预览？",
    message: "它仍在运行，因此会先停止再重新启动。链接保持不变。",
    confirm: "重启",
    cancel: "取消",
  },
  refusals: {
    busy: "此预览已在启动或停止中。请一分钟后重试。",
    capacity: "多个预览正在启动或停止。请一分钟后重试。",
    archived: "无法启动：此工作区已归档。",
    needsReview: "在 Builds 线程修复此预览的链接之前无法启动。",
    ownerAppOnly: "启动预览需要 {{host}} 的 Vorteo 密码。请使用密码重新连接，或让 Agent 来启动。",
    ownerAppOnlyUnnamed:
      "启动预览需要此 Host 的 Vorteo 密码。请使用密码重新连接，或让 Agent 来启动。",
    unavailable: "此 Host 上目前无法使用预览。",
    failed: "无法启动预览。",
  },
};

const ar: PreviewStatusStrings = {
  line: {
    checksDelayed: "قيد التشغيل. عمليات التحقق متأخرة. يبقى الرابط متاحًا.",
    checksWithdrawn:
      "سُحب الرابط لأن عمليات التحقق لم تكتمل. سيعود تلقائيًا عند اكتمال إحداها. إذا لم يعد، فأعد تشغيل المعاينة.",
    ready: "المعاينة قيد التشغيل.",
    starting: "جارٍ بدء المعاينة.",
    stopping: "جارٍ إيقاف المعاينة.",
    notResponding: {
      today: "قيد التشغيل لكنها لا تستجيب. آخر فحص الساعة {{time}}.",
      yesterday: "قيد التشغيل لكنها لا تستجيب. آخر فحص أمس الساعة {{time}}.",
      weekday: "قيد التشغيل لكنها لا تستجيب. آخر فحص يوم {{day}} الساعة {{time}}.",
      date: "قيد التشغيل لكنها لا تستجيب. آخر فحص في {{date}} الساعة {{time}}.",
    },
    notRespondingUnchecked: "قيد التشغيل لكنها لا تستجيب.",
    stoppedByRestart: {
      today: "توقفت عند إعادة تشغيل Vorteo الساعة {{time}}.",
      yesterday: "توقفت عند إعادة تشغيل Vorteo أمس الساعة {{time}}.",
      weekday: "توقفت عند إعادة تشغيل Vorteo يوم {{day}} الساعة {{time}}.",
      date: "توقفت عند إعادة تشغيل Vorteo في {{date}} الساعة {{time}}.",
    },
    stopped: {
      today: "توقفت الساعة {{time}}.",
      yesterday: "توقفت أمس الساعة {{time}}.",
      weekday: "توقفت يوم {{day}} الساعة {{time}}.",
      date: "توقفت في {{date}} الساعة {{time}}.",
    },
    stoppedNoTime: "متوقفة.",
    stoppedConfigChanged: {
      today: "توقفت الساعة {{time}} لأن إعداداتها تغيّرت.",
      yesterday: "توقفت أمس الساعة {{time}} لأن إعداداتها تغيّرت.",
      weekday: "توقفت يوم {{day}} الساعة {{time}} لأن إعداداتها تغيّرت.",
      date: "توقفت في {{date}} الساعة {{time}} لأن إعداداتها تغيّرت.",
    },
    stoppedProcessChanged: {
      today: "توقفت الساعة {{time}} لأن عمليتها تغيّرت.",
      yesterday: "توقفت أمس الساعة {{time}} لأن عمليتها تغيّرت.",
      weekday: "توقفت يوم {{day}} الساعة {{time}} لأن عمليتها تغيّرت.",
      date: "توقفت في {{date}} الساعة {{time}} لأن عمليتها تغيّرت.",
    },
    unavailable: "لا يمكن البدء: مساحة العمل هذه مؤرشفة أو غير موجودة.",
    needsReview:
      "تم تغيير رابطها خارج Vorteo، لذا لا يمكنها البدء. اطلب من سلسلة Builds إصلاح رابط هذه المعاينة.",
    restartFailed: "تعذّر البدء: {{error}}",
    restartFailedNoDetail: "تعذّر بدء المعاينة.",
    unconfirmed: "لم يتم تأكيد البدء بعد. حاول مرة أخرى إذا لم تظهر.",
    stopFailed: "تعذّر الإيقاف: {{error}}",
    stopFailedNoDetail: "تعذّر إيقاف المعاينة.",
    stopUnconfirmed: "لم يتم تأكيد الإيقاف بعد. حاول مرة أخرى إذا استمرت في التشغيل.",
    linkWithdrawn: "تم سحب الرابط، لكن الخادم لا يزال قيد التشغيل.",
  },
  stale: {
    linkWithdrawn: {
      today: "الخادم قيد التشغيل. آخر حالة معروفة للرابط: مسحوب، وفُحص الساعة {{time}}.",
      yesterday: "الخادم قيد التشغيل. آخر حالة معروفة للرابط: مسحوب، وفُحص أمس الساعة {{time}}.",
      weekday:
        "الخادم قيد التشغيل. آخر حالة معروفة للرابط: مسحوب، وفُحص يوم {{day}} الساعة {{time}}.",
      date: "الخادم قيد التشغيل. آخر حالة معروفة للرابط: مسحوب، وفُحص في {{date}} الساعة {{time}}.",
    },
    linkWithdrawnUnchecked: "الخادم قيد التشغيل. آخر حالة معروفة للرابط: مسحوب.",
    running: {
      today: "آخر حالة معروفة: قيد التشغيل، وفُحصت الساعة {{time}}. لم تُفحص منذ ذلك الحين.",
      yesterday: "آخر حالة معروفة: قيد التشغيل، وفُحصت أمس الساعة {{time}}. لم تُفحص منذ ذلك الحين.",
      weekday:
        "آخر حالة معروفة: قيد التشغيل، وفُحصت يوم {{day}} الساعة {{time}}. لم تُفحص منذ ذلك الحين.",
      date: "آخر حالة معروفة: قيد التشغيل، وفُحصت في {{date}} الساعة {{time}}. لم تُفحص منذ ذلك الحين.",
    },
    checksDelayed: {
      today:
        "آخر حالة معروفة: قيد التشغيل مع تأخر عمليات التحقق، وفُحصت الساعة {{time}}. لم تُفحص منذ ذلك الحين.",
      yesterday:
        "آخر حالة معروفة: قيد التشغيل مع تأخر عمليات التحقق، وفُحصت أمس الساعة {{time}}. لم تُفحص منذ ذلك الحين.",
      weekday:
        "آخر حالة معروفة: قيد التشغيل مع تأخر عمليات التحقق، وفُحصت يوم {{day}} الساعة {{time}}. لم تُفحص منذ ذلك الحين.",
      date: "آخر حالة معروفة: قيد التشغيل مع تأخر عمليات التحقق، وفُحصت في {{date}} الساعة {{time}}. لم تُفحص منذ ذلك الحين.",
    },
    checksWithdrawn: {
      today: "آخر حالة معروفة: الرابط مسحوب، وفُحصت الساعة {{time}}. لم تُفحص منذ ذلك الحين.",
      yesterday: "آخر حالة معروفة: الرابط مسحوب، وفُحصت أمس الساعة {{time}}. لم تُفحص منذ ذلك الحين.",
      weekday:
        "آخر حالة معروفة: الرابط مسحوب، وفُحصت يوم {{day}} الساعة {{time}}. لم تُفحص منذ ذلك الحين.",
      date: "آخر حالة معروفة: الرابط مسحوب، وفُحصت في {{date}} الساعة {{time}}. لم تُفحص منذ ذلك الحين.",
    },
    starting: {
      today: "آخر حالة معروفة: قيد البدء، وفُحصت الساعة {{time}}. لم تُفحص منذ ذلك الحين.",
      yesterday: "آخر حالة معروفة: قيد البدء، وفُحصت أمس الساعة {{time}}. لم تُفحص منذ ذلك الحين.",
      weekday:
        "آخر حالة معروفة: قيد البدء، وفُحصت يوم {{day}} الساعة {{time}}. لم تُفحص منذ ذلك الحين.",
      date: "آخر حالة معروفة: قيد البدء، وفُحصت في {{date}} الساعة {{time}}. لم تُفحص منذ ذلك الحين.",
    },
    notResponding: {
      today: "آخر حالة معروفة: لا تستجيب، وفُحصت الساعة {{time}}. لم تُفحص منذ ذلك الحين.",
      yesterday: "آخر حالة معروفة: لا تستجيب، وفُحصت أمس الساعة {{time}}. لم تُفحص منذ ذلك الحين.",
      weekday:
        "آخر حالة معروفة: لا تستجيب، وفُحصت يوم {{day}} الساعة {{time}}. لم تُفحص منذ ذلك الحين.",
      date: "آخر حالة معروفة: لا تستجيب، وفُحصت في {{date}} الساعة {{time}}. لم تُفحص منذ ذلك الحين.",
    },
    stopped: {
      today: "آخر حالة معروفة: توقفت الساعة {{time}}. لم تُفحص منذ ذلك الحين.",
      yesterday: "آخر حالة معروفة: توقفت أمس الساعة {{time}}. لم تُفحص منذ ذلك الحين.",
      weekday: "آخر حالة معروفة: توقفت يوم {{day}} الساعة {{time}}. لم تُفحص منذ ذلك الحين.",
      date: "آخر حالة معروفة: توقفت في {{date}} الساعة {{time}}. لم تُفحص منذ ذلك الحين.",
    },
    unchecked: "آخر حالة معروفة ليست محدّثة.",
  },
  short: {
    checksDelayed: "غير مؤكد",
    checksWithdrawn: "الرابط مسحوب",
    notResponding: "لا تستجيب",
  },
  badge: {
    starting: "قيد البدء",
    stopping: "قيد الإيقاف",
    notResponding: "لا تستجيب",
    stopped: "متوقفة",
    unavailable: "غير متاحة",
    needsRepair: "تحتاج إصلاحًا",
    didntStart: "لم تبدأ",
    didntStop: "لم تتوقف",
    linkWithdrawn: "الرابط مسحوب",
    unconfirmed: "غير مؤكد",
    lastKnown: "غير محدّث",
  },
  actions: {
    start: "بدء",
    restart: "إعادة التشغيل",
    retry: "إعادة المحاولة",
    stop: "إيقاف",
  },
  confirmRestart: {
    title: "إعادة تشغيل هذه المعاينة؟",
    message: "لا تزال قيد التشغيل، لذا ستتوقف ثم تبدأ من جديد. يبقى الرابط كما هو.",
    confirm: "إعادة التشغيل",
    cancel: "إلغاء",
  },
  refusals: {
    busy: "هذه المعاينة قيد البدء أو الإيقاف بالفعل. حاول مرة أخرى بعد دقيقة.",
    capacity: "عدة معاينات قيد البدء أو الإيقاف. حاول مرة أخرى بعد دقيقة.",
    archived: "لا يمكن البدء: مساحة العمل هذه مؤرشفة.",
    needsReview: "لا يمكن البدء حتى تصلح سلسلة Builds رابط هذه المعاينة.",
    ownerAppOnly:
      "يتطلب بدء المعاينات كلمة مرور Vorteo الخاصة بـ {{host}}. أعد الاتصال باستخدام كلمة المرور، أو اطلب من وكيل بدءها.",
    ownerAppOnlyUnnamed:
      "يتطلب بدء المعاينات كلمة مرور Vorteo الخاصة بهذا المضيف. أعد الاتصال باستخدام كلمة المرور، أو اطلب من وكيل بدءها.",
    unavailable: "المعاينات غير متاحة على هذا المضيف حاليًا.",
    failed: "تعذّر بدء المعاينة.",
  },
};

export const previewStatus = {
  en,
  ar,
  es,
  fr,
  ja,
  ko,
  "pt-BR": ptBR,
  ru,
  "zh-CN": zhCN,
} as const;
