### Maintenance

- Separate bounded browser restart prerequisites from the restart behavior budget, and give the fixture ownership of acquired resources through teardown.

## Maintenance review

Reviewed browser daemon lifecycle coverage. Prerequisites have a 120-second fixture budget; the restart body retains 60 seconds and existing 30-second expectations. The owner tracks late acquisition, releases planted processes before daemon close, and preserves cleanup failures. Production helpers and direct cleanup-contract tests remain unchanged. The revised full run passed six cases and failed the unclosable-process error assertion after 30 seconds; all new process cleanup was verified. An isolated diagnostic using the existing home-retention option passed, and the exact fixture source was restored afterward. The earlier readiness timeout remains unexplained; this is not an all-seven-case pass or release acceptance. README overview and onboarding are unchanged.
