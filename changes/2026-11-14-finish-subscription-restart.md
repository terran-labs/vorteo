### Fixes

- A lead waiting on a worker no longer hears "was closed" when the daemon restarts or an idle release closes the worker's runtime. A hosted worker still running its turn reports its real outcome after the restart, once.
- A worker left stopped by a restart sends its lead one not-running notice and keeps the finish notification armed, so the lead still hears when the worker next finishes.
- A finished worker's runtime can be released while its notification waits for a quota-paused lead.

## Maintenance review

Diagnosed from the Host log and the lead's transcript: shutdown closes every loaded agent and stores it as closed, and the restored subscription read that stored status before the session host adoption loaded the worker, delivering "was closed" and removing the subscription. Finish observation now waits for a pending hosted adoption, ignores closes emitted by automatic releases (a new manager marker), and reports a child found closed at rest without an archive as not running on the existing errored event, keeping the subscription with a local `notRunningNoticeSent` flag in the JSON store. Archived children still report closed. Folded in review notes on the quota branch: captured outcomes stop protecting the child from idle cleanup, the startup quota release shares its team root with the quota stop, and launch presets document that a Don't resume hold without a reset time keeps teammates latched. Finish subscription tests gain three restart cases with a real agent manager and one assertion; the agent lifecycle guide, launch presets and customizations inventory are updated; README overview and onboarding are unchanged. No protocol change.
