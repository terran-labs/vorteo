import type { FactoryEvent, LeanStateStore, PushAlerts, Router, Watchdog } from "./types.js";

type Stall = Extract<FactoryEvent, { kind: "stall" }>;
type DueDeadline = Awaited<ReturnType<Watchdog["due"]>>[number];

function alertBody(event: Stall): string {
  if (event.stage === "loop") return "Factory reconciliation stopped reporting progress.";
  if (event.stage === "escalation") return "A Factory question still needs your answer.";
  const subject = event.issue === null ? "Factory" : `Factory issue #${event.issue}`;
  return `${subject} stalled at ${event.stage}.`;
}

export const watchdogMinutes = {
  queued: 15,
  claimed: 45,
  planning: 45,
  "plan-ready": 10,
  deferred: 360,
  building: 90,
  checks: 60,
  review: 45,
  repair: 90,
  accepting: 30,
  "sent-back": 90,
  approved: 20,
  merged: 60,
  "delivery-lock": 120,
  escalation: 720,
  loop: 10,
} satisfies Partial<Record<Stall["stage"], number>>;

interface WatchdogActions {
  router: Router;
  alerts: PushAlerts;
  /** Resolve the key from current daemon facts. Null means the wait has ended. */
  describe(key: string): Promise<Pick<Stall, "issue" | "stage"> | null>;
  /** Retry and health updates are idempotent under the supplied occurrence key. */
  retry(key: string, occurrence: string): Promise<void>;
  degrade(event: Stall, occurrence: string): Promise<void>;
}

export function createWatchdog(input: {
  projectId: string;
  state: LeanStateStore;
  actions: WatchdogActions;
  now?: () => Date;
}): Watchdog & {
  /** Invoke from a separate timer so a blocked reconcile pass cannot suppress alerts. */
  tick(): Promise<void>;
} {
  const { state, projectId, actions } = input;
  const now = input.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const loopKey = "watchdog:loop";
  let ticking: Promise<void> | undefined;
  const watchdog: Watchdog = {
    async arm(key, deadline) {
      const at = deadline.toISOString();
      const existing = (await state.read(projectId)).deadlines[key];
      if (existing) return;
      await state.mutate(projectId, (ledger) => {
        ledger.deadlines[key] ??= {
          since: now().toISOString(),
          deadline: at,
          firedAt: null,
          breaches: 0,
        };
      });
    },
    async clear(key) {
      await state.mutate(projectId, (ledger) => {
        delete ledger.deadlines[key];
      });
    },
    async due(at) {
      return Object.entries((await state.read(projectId)).deadlines)
        .filter(([, entry]) => entry.firedAt === null && Date.parse(entry.deadline) <= +at)
        .map(([key, entry]) => ({ key, since: entry.since, secondBreach: entry.breaches > 0 }));
    },
  };

  async function check() {
    const at = now();
    const ledger = await state.read(projectId);
    const beat = ledger.loopBeat ?? startedAt;
    const loop = ledger.deadlines[loopKey];
    const loopDeadline = Date.parse(beat) + watchdogMinutes.loop * 60_000;
    if (loop && loop.since !== beat) await watchdog.clear(loopKey);
    if (loopDeadline <= +at && loop?.since !== beat) {
      await state.mutate(projectId, (current) => {
        if ((current.loopBeat ?? startedAt) === beat) {
          current.deadlines[loopKey] = {
            since: beat,
            deadline: new Date(loopDeadline).toISOString(),
            firedAt: null,
            breaches: 1,
          };
        }
      });
    }

    const due = await watchdog.due(at);
    const results = await Promise.allSettled(due.map(processDeadline));
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length) throw new AggregateError(failures, "Factory watchdog actions failed.");
  }

  async function alertOwner(event: Stall, occurrence: string): Promise<boolean> {
    const alert = actions.alerts.alert({
      title: "Factory needs attention",
      body: alertBody(event),
      dedupeKey: occurrence,
      minIntervalMinutes: 720,
    });
    if (event.stage === "escalation") return (await alert) !== "unavailable";
    const effects = await Promise.allSettled([
      alert,
      actions.degrade(event, occurrence),
      actions.router.route(event),
    ]);
    for (const effect of effects) {
      if (effect.status === "rejected") throw effect.reason;
    }
    return (await alert) !== "unavailable";
  }

  async function processDeadline({ key, since, secondBreach }: DueDeadline): Promise<void> {
    const current = await state.read(projectId);
    const entry = current.deadlines[key];
    if (!entry || entry.since !== since || entry.firedAt !== null) return;
    if (key === loopKey && (current.loopBeat ?? startedAt) !== since) return;
    const target =
      key === loopKey ? { issue: null, stage: "loop" as const } : await actions.describe(key);
    if (!target) {
      await state.mutate(projectId, (latest) => {
        if (latest.deadlines[key]?.since === since) delete latest.deadlines[key];
      });
      return;
    }
    const event: Stall = {
      kind: "stall",
      ...target,
      waitingSince: since,
      deadline: entry.deadline,
    };
    const occurrence = JSON.stringify([projectId, key, since]);
    const retry = !secondBreach && target.stage !== "escalation";
    if (retry) {
      await actions.retry(key, occurrence);
    } else if (!(await alertOwner(event, occurrence))) {
      return;
    }

    await state.mutate(projectId, (latest) => {
      const deadline = latest.deadlines[key];
      if (!deadline || deadline.since !== since || deadline.deadline !== entry.deadline) return;
      if (retry) {
        const interval = Math.max(60_000, Date.parse(entry.deadline) - Date.parse(since));
        deadline.deadline = new Date(+now() + interval).toISOString();
      } else {
        deadline.firedAt = now().toISOString();
      }
      deadline.breaches++;
    });
  }

  return {
    ...watchdog,
    tick() {
      ticking ??= check().finally(() => {
        ticking = undefined;
      });
      return ticking;
    },
  };
}
