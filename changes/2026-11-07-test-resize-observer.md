### Maintenance

- App unit tests get a no-op ResizeObserver, which jsdom lacks. The shared scroll view's edge fade measures with it, so the agent profile page's owner-lock tests failed with "ResizeObserver is not defined". Tests never resize, so the observer never needs to fire; a test that needs resize callbacks installs its own.

## Maintenance review

Test setup only; no app behavior changes. README overview and onboarding are unchanged.
