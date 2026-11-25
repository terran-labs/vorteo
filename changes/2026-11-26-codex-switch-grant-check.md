### Fixes

- Switching a legacy Codex account on Dev to the Host's sign-in is no longer refused because an idle, failing or running Dev thread has the account loaded. The coordinator now checks whether Dev actually holds a copy of the Host's grant, with a single-use keyed hash that keeps neither token. Only then does a running Dev thread block the switch, and the reply names it by title (#658).
- When Dev does hold the Host's own grant, Dev pauses new sessions on that account while it replaces the sign-in, and refuses while a thread is running a turn. An older Dev keeps the earlier rule. Dev advertises the new `codexLegacySessionHold` capability (#658).

## Maintenance review

Server side of #658: the `session-check` legacy operation with busy titles, `adoption.sessionCheck` on the projection delivery, the in-write lease across every provider sharing the home, and the coordinator's check in place of the loaded-session rule at the first switch, a paused first projection's resume and an unsettled confirmation. The providers guide, protocol notes and the adopted legacy Codex inventory entry are updated. README overview and onboarding are unchanged. Not published.
