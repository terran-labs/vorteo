### Fixes

- Keep a submenu open when its row is tapped on a touch screen. A tap's pointer enter and leave were read as hover, so the flyout closed a moment after it opened; a tap inside an open flyout closed it the same way. Mouse and pen hover are unchanged.

## Maintenance review

Shared menu hover handling now ignores touch pointer events in popover menus; sheets and native are unaffected. The touch access entry in the inventory records the behavior and the matching Paseo pull request. A browser regression case extends the existing menu overlay test. README overview and onboarding are unchanged.
