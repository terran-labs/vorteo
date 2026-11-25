import { useRef, useSyncExternalStore } from "react";

/**
 * Where a System Health row's Fix lands. The request cards live inside collapsed sections:
 * an environment's Details on the System card, or the Updates row's Details. Fix publishes the
 * card here first, so the section that holds it expands, then jumps to the card's anchor. The
 * settings page waits for the anchor to render before it scrolls and moves focus.
 */
export type HealthCard =
  | "restarts"
  | "dashboard"
  | "services"
  | "broker"
  | "monitor"
  | "helper"
  | "session-host"
  | "instructions"
  | "upgrades";

/** The collapsed section that holds a card. */
export type HealthCardHost = "host" | "container-daemon" | "updates";

export interface HealthCardReveal {
  card: HealthCard;
  host: HealthCardHost;
  nonce: number;
}

/** DOM id of a card, unique per section because Host and Dev Details can both be open. */
export function healthCardAnchorId(host: HealthCardHost, card: HealthCard): string {
  return `system-health-card-${host}-${card}`;
}

let current: HealthCardReveal | null = null;
let nonce = 0;
const listeners = new Set<() => void>();

/** Asks the section holding `card` to expand. Each call is a new request, even for one card. */
export function revealHealthCard(card: HealthCard, host: HealthCardHost): void {
  nonce += 1;
  current = { card, host, nonce };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): HealthCardReveal | null {
  return current;
}

/** The latest reveal request, for sections that expand to show a card. */
export function useHealthCardReveal(): HealthCardReveal | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * The latest reveal aimed at one section, or null. A reveal issued before the section mounted
 * belongs to an earlier visit, so a reopened page does not expand on its own.
 */
export function useHealthCardRevealFor(host: HealthCardHost): HealthCardReveal | null {
  const mountedAfter = useRef(nonce);
  const reveal = useHealthCardReveal();
  return reveal?.host === host && reveal.nonce > mountedAfter.current ? reveal : null;
}

/**
 * Marks a card anchor whose jump focuses the card's first enabled control rather than the card
 * itself, so a keyboard user lands on Approve, Reject or Dismiss.
 */
export const HEALTH_CARD_DATASET = { settingsJump: "card" } as const;

/** Props for the element a Fix lands on. */
export function healthCardAnchorProps(host: HealthCardHost, card: HealthCard) {
  return { nativeID: healthCardAnchorId(host, card), dataSet: HEALTH_CARD_DATASET };
}
