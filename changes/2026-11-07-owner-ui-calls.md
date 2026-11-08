### Improvements

- The daemon logs account usage every minute whether or not any client is open, instead of every 10 minutes. Each background reading bypasses the 2-minute cache, and client polls keep sharing it. History keeps one sample per minute for 48 hours and one per 5 minutes after that, for 8 days.
- A provider that answers 429 or fails a usage check now backs off on its own: it waits 2 minutes, then twice as long after each further refusal, up to 10 minutes, and returns to every minute after a success. Back-off is logged at info level with the provider ID and reason only.
- The sidebar quota meter refreshes its display only while it is on screen: its sidebar open and the app visible.
- Settings > Interface has a Sidebar pane again, with the Header and Footer cards that order and hide sidebar items. The old `/settings/sidebar` address opens it, and Settings search finds it.
- A three-finger tap on a touchscreen toggles dictation into the message field, like the middle click that a trackpad three-finger tap can send.

### Fixes

- Triple click no longer toggles dictation, so it selects a line or paragraph again.
- On touch layouts the composer's Fullscreen button sits just left of the dictation button instead of under it, so it can be pressed again.
- The fullscreen composer on touch layouts keeps the dictation button beside Exit and Send.

### Tests

- The sidebar toolbar test expects History, Schedules, then Search, the full-width order the toolbar has used since bcd8dda7a.
- The sidebar footer settings test no longer expects the footer's top rule over a short project list, which it has not drawn since 469492c4e.

## Maintenance review

Updated the usage, gesture dictation, touch access and settings navigation entries. The history file at 1-minute resolution for 48 hours and 5-minute after is about 92 KB per account window, roughly 1.8 MB for twenty windows, written once a minute. The native iOS and Android apps have no three-finger tap; physical touchscreen acceptance is pending. Not yet installed. README overview and onboarding are unchanged.
