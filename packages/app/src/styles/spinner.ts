/**
 * Passive spinners, status rings, the queue orbit and the snake loader share this calm tempo.
 * Status rings stay phase-locked to wall time. Prominent action waits use the faster period below.
 */
export const SPINNER_PERIOD_MS = 2700;

/**
 * The exception: a spinner the user is actively waiting on, such as a submit button or dictation
 * that is transcribing, turns at upstream Paseo's original ActivityIndicator speed so it reads as
 * work in progress rather than ambient motion.
 */
export const PROMINENT_SPINNER_PERIOD_MS = 750;
