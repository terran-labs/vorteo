import { useEffect, useRef, useSyncExternalStore } from "react";

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
  issuedAt: number;
}

/**
 * A section that mounts because a reveal expanded its parent, such as Host's Details body, still
 * acts on that reveal when it arrives within this window. Older reveals belong to an earlier
 * visit and are ignored.
 */
const MOUNT_WINDOW_MS = 3000;

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
  current = { card, host, nonce, issuedAt: Date.now() };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): HealthCardReveal | null {
  return current;
}

function useHealthCardReveal(): HealthCardReveal | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * Calls `onReveal` once for each new reveal aimed at `host`. A reveal is consumed when it is
 * delivered, so a Fix whose card was not there to open never fires later, for example when an
 * unrelated restart request arrives afterwards.
 */
export function useOnHealthCardReveal(
  host: HealthCardHost,
  onReveal: (card: HealthCard) => void,
): void {
  const handled = useRef<number | null>(null);
  if (handled.current === null) {
    const recent = current && Date.now() - current.issuedAt < MOUNT_WINDOW_MS;
    handled.current = recent ? current!.nonce - 1 : nonce;
  }
  const latest = useRef(onReveal);
  useEffect(() => {
    latest.current = onReveal;
  });
  const reveal = useHealthCardReveal();
  useEffect(() => {
    if (!reveal || reveal.nonce <= (handled.current ?? 0)) return;
    handled.current = reveal.nonce;
    if (reveal.host === host) latest.current(reveal.card);
  }, [reveal, host]);
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
