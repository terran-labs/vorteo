### Fixes

- The app sends a preview stop through the broker only when the daemon also advertises `previewStopOutcome`, so a daemon released before outcomes named their mode can never show a failed stop as "Couldn't start". Otherwise Stop ends the terminal as before (#586).

## Maintenance review

App side of the capability added in the same stack; the inventory's previews entry already describes the broker stop. The scripts button test gains one case table, which fails when the gate is removed. Interface only; the broker stop appears once a daemon with the capability is installed. README overview and onboarding are unchanged. Not published.
