### Features

- System Health offers Dismiss on every failed record that still counts: preview broker, preview monitor, native helper, session host and service maintenance requests, and failed Vorteo upgrades, including ones that were not automatic. A dismissed failure stops counting and stays in its card marked Dismissed. When Fix lands on a failed record, keyboard focus goes to its Dismiss (#639).
- The coordinator records the owner's dismissals beside the records, behind owner-only routes that no agent door or maintenance grant reaches, and accepts Dismiss for any failed release upgrade, advertised as `acknowledgesFailures`. Older coordinators answer without these, and the interface then offers no Dismiss on those records (#639).

## Maintenance review

Updated the System status and restart controls entry for Dismiss. Needs the updated coordinator, so a Host restart through the tracked installation workflow. README overview and onboarding are unchanged.
