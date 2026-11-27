import { createHash } from "node:crypto";
import type { EventClass, FactoryEvent, LeanStateStore, RoutedEvent, Router } from "./types.js";

const eventClasses: Record<FactoryEvent["kind"], EventClass> = {
  "reviewed-green": "judgment",
  "plan-posted": "judgment",
  "overlap-stuck": "judgment",
  "scope-exceeded": "judgment",
  stall: "judgment",
  "no-account": "mechanic",
  "runner-question": "judgment",
  "delivery-failed": "judgment",
  "repair-loop": "judgment",
  sampler: "mechanic",
  "version-skew": "owner",
  "lane-unanswered": "owner",
};

export function acceptanceEventId(issue: number, sha: string): string {
  return `reviewed-green:${issue}:${sha}`;
}

export function createRouter(input: {
  projectId: string;
  state: LeanStateStore;
  planAcceptanceEnabled: () => boolean;
  now?: () => Date;
}): Router {
  const now = input.now ?? (() => new Date());
  return {
    async route(event) {
      let eventClass = eventClasses[event.kind];
      if (event.kind === "plan-posted" && !input.planAcceptanceEnabled()) eventClass = "mechanical";
      if (event.kind === "stall" && (event.stage === "loop" || event.stage === "escalation")) {
        eventClass = "owner";
      }
      const id =
        event.kind === "reviewed-green"
          ? acceptanceEventId(event.issue, event.sha)
          : createHash("sha256").update(JSON.stringify(event)).digest("hex");
      const at = now().toISOString();
      const routed: RoutedEvent = {
        id,
        at,
        class: eventClass,
        event,
        issue: "issue" in event ? event.issue : null,
      };
      if (eventClass === "mechanical") return routed;

      return input.state.mutate(input.projectId, (ledger) => {
        const existing = ledger.pendingEvents.find((entry) => entry.routed.id === id);
        if (existing) return existing.routed;
        if (
          Object.hasOwn(ledger.answeredEvents, id) ||
          (event.kind === "reviewed-green" &&
            ledger.acceptances[event.issue]?.some((decision) => decision.sha === event.sha))
        ) {
          return routed;
        }
        ledger.pendingEvents.push({ routed, queuedAt: at, deliveredAt: null });
        return routed;
      });
    },
  };
}
