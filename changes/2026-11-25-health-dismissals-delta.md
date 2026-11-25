### Fixes

- After the owner dismisses a failed restart, the Host or Dev card stops reporting that the latest restart failed, so the card, the Health list and its badge agree (#639).
- Each dismissal write saves the list as it stands when the write runs, so a dismissal whose own save failed does not reappear after a restart (#639).
- Restarts are ordered by parsed time when choosing the one Dismiss applies to (#639).

## Maintenance review

Review follow-up to owner dismissals; the System status and restart controls entry already describes Dismiss. Not installed. README overview and onboarding are unchanged.
