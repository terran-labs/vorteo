/**
 * One calm tempo for every loading or busy indicator that turns: spinners, status rings, the
 * queue orbit and the snake loader all complete a cycle in this time, so nothing on screen spins
 * faster than anything else. Rings stay phase-locked to wall time at this period.
 */
export const SPINNER_PERIOD_MS = 2700;
