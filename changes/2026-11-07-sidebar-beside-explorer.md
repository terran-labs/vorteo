### Fixes

- Expanding the sidebar from the icon rail on a narrow window keeps it open; it had vanished and uncovered the Files and Changes cards instead.
- App navigation stays beside Explorer again; Vorteo's supporting cards give way when the window is narrow.

### Tests

- The plugin file panel test reopens Files after its compact round trip, since Vorteo's cards collapse again after a resize.

## Maintenance review

Merge 51f16b39f brought upstream's rule that app navigation yields when Explorer needs the width. Vorteo already makes room by collapsing its supporting cards and keeps an explicit Explorer toggle until the next resize, so with both rules, expanding the sidebar at 800 pixels hid it, which let the cards uncollapse and keep it hidden. The rule is removed from the app shell and docs/explorer-sidebar.md records Vorteo's behavior. Vorteo's own half-screen test from before the merge expects the sidebar beside Files and passes again. The customizations inventory and README need no updates.
