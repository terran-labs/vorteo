### Fixes

- Tab no longer gets stuck on a control whose tooltip is showing, such as a sidebar row's or the breadcrumb's actions button.
- Phones list the workspace's scripts in the Workspace actions menu again.
- Choosing Last prompt in the sidebar sort menu keeps the menu open, like Manual and Created.

### Tests

- The phone workspace header test expects the Explorer button the owner chose to keep, and an upstream test that drives the removed composer model selector is routed out.

## Maintenance review

Tooltips register with the overlay keyboard layer with focus management on by default, so Tab from a keyboard-focused trigger wrapped into a tooltip with nothing focusable and stayed put; tooltips now opt out, as hover cards already did. Merge 51f16b39f dropped the scripts page from the compact header's workspace menu, which Vorteo passes as a child; it is restored. The demo breadcrumb test loses a CSS opacity check that contradicted its own comment under the hover refactor, and the upstream hover card test tabs past the row's always-mounted actions button. The owner decided on 2026-11-07 to keep upstream's phone header with its Explorer button. The customizations inventory and README need no updates.
