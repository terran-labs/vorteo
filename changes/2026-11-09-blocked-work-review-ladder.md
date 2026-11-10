### Changes

- When blocked-work review is turned on, a stopped thread now gets at most three reviews, about 5, 15 and 30 minutes apart, then waits until someone messages it. The short gaps reuse the provider's prompt cache, so each review costs a fraction of the old hourly review, which reread the whole conversation every hour indefinitely. Blockers waiting on an open question are skipped, and the setting is renamed **Review blocked work**.

## Maintenance review

Replaces the hourly interval with a three-step ladder stored as an optional `blockedReviewCount` on the agent record. A user-message timestamp more than two minutes after the last review starts a new stretch, so a review's own prompt cannot restart the ladder, and housekeeping that only touches `updatedAt` cannot either. The review's end time is recorded so a long review does not shorten the next gap. The final review asks the agent to leave owner-actionable blocker descriptions. The setting stays off by default. One case-table test covers the ladder, the restart rule and open-question skipping; existing review and storage tests pass. The agent lifecycle guide and customizations inventory are updated; README overview and onboarding are unchanged. Daemon-checked wake conditions and a cheap pre-check are tracked in issue #328.
