### Fixes

- The coordinator starts with no dismissals when its dismissal file cannot be read, instead of stopping, and sets a damaged file aside (#639).
- A failed restart can be dismissed from System Health like the other failed records, so the Health badge can reach zero (#639).
- A record that needs recovery cannot be dismissed: the coordinator refuses it and the interface does not offer Dismiss on it (#639).
- A dismissal the coordinator could not save no longer shows as dismissed until the next restart (#639).

## Maintenance review

Review follow-up to owner dismissals; the System status and restart controls entry already describes Dismiss. Protocol compatibility now documents the dismissal routes and `acknowledgesFailures`. Not installed. README overview and onboarding are unchanged.
