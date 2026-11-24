### Fixed

- A preview whose link checks are delayed no longer reads "not responding" with a Restart button. The scripts menu says it is running with its link up, and the Previews gallery badges it Unconfirmed, so Restart is not offered on a preview that still works (#616).
- A preview whose link the broker withdrew after its checks kept timing out now says the link comes back by itself when a check finishes, and offers Restart only for when it does not.

## Maintenance review

Daemon adds the optional `preview.linkCheck` field; older apps keep today's wording. README overview and onboarding are unchanged.
