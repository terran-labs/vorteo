### Fixes

- Keep scroll edge fades working in browsers and test environments that lack `ResizeObserver`; the fade then follows scrolling and window resizes instead of crashing the screen.

## Maintenance review

The shared scroll edge fade constructed `ResizeObserver` unconditionally, which threw in the app's unit test DOM and would break any older browser without it. It now treats both observers as optional and falls back to a window resize listener. Visuals are unchanged where the observers exist; the customization inventory is unchanged.
