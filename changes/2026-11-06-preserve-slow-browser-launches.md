### Fixes

- Browser requests stop waiting after 10 seconds without killing a slow launch. The process keeps its 60-second startup budget and can serve later requests once ready.
- Fatal launch errors stay within 4,000 characters without repeating Playwright's browser logs; errors without those logs still include stderr.

## Maintenance review

Updated the headless browser inventory to distinguish the request deadline from the process startup budget. README overview and onboarding, sandbox flags, container settings and wire error shapes are unchanged.
