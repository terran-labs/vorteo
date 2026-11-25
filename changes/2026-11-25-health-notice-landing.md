### Fixes

- "System needs attention" lands the System Health heading at the top of the page, and keeps it there while rows above it finish loading. After any jump the reader starts, the page re-measures its target as layout changes and corrects the scroll until layout is quiet, the reader scrolls, types or moves focus, or four seconds pass (#639).
- The Host and Dev cards, the Health list, its badge and the Updates card no longer report a failed upgrade to a release the installation has already moved past, however it got there (#639).
- An optional feature left off, such as unattended maintenance that was never activated, paused or revoked, no longer shows "System services: Needs attention" (#639).

## Maintenance review

Updated the System status and restart controls entry for the notice landing, installed-release supersession and optional maintenance. Interface only; not installed. README overview and onboarding are unchanged.
