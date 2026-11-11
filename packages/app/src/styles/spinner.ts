/**
 * One calm tempo for every loading or busy indicator that turns: spinners, status rings, the
 * queue orbit and the snake loader all complete a cycle in this time, so nothing on screen spins
 * faster than anything else. Rings stay phase-locked to wall time at this period.
 */
export const SPINNER_PERIOD_MS = 2700;

/**
 * The exception: a spinner the user is actively waiting on, such as a submit button or dictation
 * that is transcribing, turns at upstream Paseo's original ActivityIndicator speed so it reads as
 * work in progress rather than ambient motion.
 */
export const PROMINENT_SPINNER_PERIOD_MS = 750;
