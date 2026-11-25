### Fixes

- A failed upgrade is hidden only when it was offered by the update check or installed automatically, both of which only move forward, and the installed release is strictly newer than its target. A failure to the installed release itself, and an owner-requested upgrade that may have been a rollback, stay visible (#639).
- After a jump lands, the settings page lets go as soon as the reader moves the page in any way it did not, such as dragging the scrollbar or momentum scrolling (#639).

## Maintenance review

Review follow-up to the notice landing; the System status and restart controls entry is updated for the narrower upgrade rule. Interface only; not installed. README overview and onboarding are unchanged.
