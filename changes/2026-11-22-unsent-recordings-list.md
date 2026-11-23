### Features

- An Unsent recordings list shows dictation recordings no composer is showing, including ones from an earlier page load and partial ones, with their date, length, whether they are complete and which thread they belong to. Each can be retried in the current composer, saved as audio or discarded. The list opens from a quiet line above the composer, which can be hidden for the session, and from a failed dictation.

### Fixes

- A dictation closed before any audio arrived no longer leaves an empty stored recording behind.
- A recording handed over before the microphone finished stopping now says it may be missing its end.
- Discarding from an Unsent recordings list that another tab has since changed no longer deletes a recording that tab is retrying.
- A Retry from the list that hits a storage error now says so and leaves the recording listed instead of hiding it until the tab closes.

## Maintenance review

Added the Unsent recordings list to the dictation recordings entry and removed it from the known gaps. Review fixes: Discard checks ownership before deleting, a failed Retry releases its claim, and the list refreshes when the tab is shown. Interface only. README overview and onboarding are unchanged.
