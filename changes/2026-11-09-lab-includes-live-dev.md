### Features

- Make Lab the single switch for live development: choosing Lab serves your browser from the live checkout with hot reload and enables lab self-updates, and Stable serves the published interface. The separate Delivery mode switch is replaced by a read-only Live development status.

## Maintenance review

Live dev mode and the installation type merge into one owner choice, because a lab self-update builds from the live checkout and Lab without it could not update itself. The coordinator derives the delivery mode from the installation type record, re-reads it every two seconds, and keeps the delivery mode route for older interfaces by translating it to a type change. A pre-merge `live-dev.json` is ignored. An unreadable type record still serves static and only repairs to Stable. Coordinator change; installing it needs a coordinator update. README overview and onboarding are unchanged.
