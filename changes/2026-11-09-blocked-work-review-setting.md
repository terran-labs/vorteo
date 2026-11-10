### Changes

- Blocked-work review is now off by default. Each review resumes the thread's whole conversation, so a few blocked threads could use a large share of a weekly provider limit. Turn it back on in Settings, System, **Review blocked work**; the change applies without a restart.

## Maintenance review

Adds the host setting `agents.blockedWorkReview`, exposed as an optional `blockedWorkReview` daemon config field behind the `blockedWorkReviewSetting` capability. Absent or false disables the review scan; existing installations stop reviewing on upgrade until the owner opts in. Usage-limit resumes, schedules and heartbeats are unchanged. The existing review test gains a disabled-service case and the config test covers the default. The agent lifecycle guide and the customizations inventory are updated; README overview and onboarding are unchanged.
