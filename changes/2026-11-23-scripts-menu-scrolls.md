### Fixes

- The wide scripts menu now scrolls within the window. With many scripts, or previews that each show a status line, it ran past the bottom of the window and the wheel scrolled the panel behind it, so the last rows could not be reached. This predates the preview status work, which made it worse (#586).

## Maintenance review

Uses the menu engine's existing `scrollable` option, which caps the popover at the window height and scrolls its content; no inventory entry changes. Interface only. README overview and onboarding are unchanged. Not published.
