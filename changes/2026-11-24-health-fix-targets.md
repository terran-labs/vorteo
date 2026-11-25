### Fixes

- System Health's Fix buttons open the card that resolves each row instead of scrolling to the top of a pane. Fix expands the Host, Dev or Updates Details holding the card, scrolls it into view and focuses its first enabled control. A pending restart opens its Restart sheet. Rows whose card needs owner access ask to unlock first; cancelling leaves the page unchanged (#639).
- Health no longer counts a failed broker, monitor, helper, service, session host, restart or upgrade request once a later request for the same service succeeded, or once the owner dismissed it. The failure that is the latest state of its service keeps counting. Superseded failures stay visible in their card, marked Superseded (#639).
- A pending agent instruction change written against older instructions is marked Stale, does not count on Health and offers only Reject (#639).
- The Updates card no longer shows a dismissed upgrade result beside the current status, and lists each failed upgrade that still counts with its detail and, for automatic upgrades, Dismiss (#639).
- Host, Dev and Updates Details grow with the Settings page instead of scrolling inside a fixed-height box, so a jump to a card inside them lands on it on phones (#639).

## Maintenance review

Updated the System status and restart controls entry for Fix targets, the superseded and dismissed counting rule, stale instruction requests and the Updates card. Dismissing failed broker, monitor, helper and session host requests, and failed upgrades that were not automatic, needs a daemon change that follows separately. Interface only; not installed. README overview and onboarding are unchanged.
