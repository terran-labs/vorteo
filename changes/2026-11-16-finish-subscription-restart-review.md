### Fixes

- A lead whose worker's hosted session cannot be reopened after a daemon restart now gets one notice saying so, instead of waiting forever.
- A worker that finished while the daemon was restarting is reported finished once its session is adopted.
- A finished result that was waiting for a paused lead or a restart hold is delivered after a restart, instead of a not-running notice.

## Maintenance review

Review fixes on the restart-safe finish subscription branch, after merging current main. A watch opened while the child's hosted session is pending adoption now follows the adoption: it joins or retries the load, reports an idle child as finished because a completion applied as adopted history emits no live event, and ends with an errored "could not be reopened" notice when the load fails, so no runtime stays protected. Deferred outcomes are stored with the subscription in the local JSON file and delivered as observed after a restart; an outcome dispatched but not acknowledged is still observed again, as the upstream recovery test expects. No protocol change. Finish subscription tests gain two restart cases and one restart assertion in the latched-caller case; the existing adoption case now adopts a busy child. The agent lifecycle guide and customizations inventory are updated; README overview and onboarding are unchanged.
