// A 3x3 grid of dots that twinkle independently: each dot flicks to full
// brightness at pseudo-random moments, then eases back down to a dim resting
// glow. Opacity is a pure function of wall-clock time and dot index, so every
// loader on screen shows the same frame without coordinating state, and the
// UI thread does a few multiplications per dot per frame.
export const SYNCED_LOADER_COLUMNS = 3;
export const SYNCED_LOADER_DOT_COUNT = SYNCED_LOADER_COLUMNS * SYNCED_LOADER_COLUMNS;

// Each dot owns a stream of slots; a slot holds at most one flash.
const SLOT_MS = 900;
// Share of slots that flash. Tuned so two or three dots are usually glowing.
const FLASH_CHANCE = 0.55;
// The fade must fit inside one slot so only the current and previous slot can
// contribute to a dot's opacity.
const FADE_MS = 820;
// Keeps the grid's shape legible between flashes.
export const SYNCED_LOADER_REST_OPACITY = 0.16;

// Integer hash returning [0, 1). Math.imul keeps it in 32-bit space on every
// JS engine, including the worklet runtime.
function hashUnit(a: number, b: number): number {
  "worklet";
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Brightness contributed by a flash in slot `slot`, `elapsedInSlot` after the slot began.
function flashLevel(dot: number, slot: number, elapsedInSlot: number): number {
  "worklet";
  if (hashUnit(dot * 2 + 1, slot) >= FLASH_CHANCE) {
    return 0;
  }
  const sinceFlash = elapsedInSlot - hashUnit(dot * 2 + 2, slot) * SLOT_MS;
  if (sinceFlash < 0 || sinceFlash >= FADE_MS) {
    return 0;
  }
  // Flick on instantly, linger a beat at the peak, then glide out (inverted smoothstep).
  const u = sinceFlash / FADE_MS;
  return 1 - u * u * (3 - 2 * u);
}

export function getSyncedLoaderDotOpacity(nowMs: number, dot: number): number {
  "worklet";
  // Stagger slot boundaries per dot so flashes never line up on a shared beat.
  const shifted = nowMs + hashUnit(dot, 0x5eed) * SLOT_MS;
  const slot = Math.floor(shifted / SLOT_MS);
  const elapsedInSlot = shifted - slot * SLOT_MS;
  const level = Math.max(
    flashLevel(dot, slot, elapsedInSlot),
    flashLevel(dot, slot - 1, elapsedInSlot + SLOT_MS),
  );
  return SYNCED_LOADER_REST_OPACITY + (1 - SYNCED_LOADER_REST_OPACITY) * level;
}
