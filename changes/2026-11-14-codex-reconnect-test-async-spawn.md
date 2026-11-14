### Maintenance

- Fix the Codex concurrent reconnect test for the asynchronous sign-in read that now precedes connecting. The test waits for the reconnect spawn, gives a second caller time to start a duplicate, then checks that exactly one reconnect ran.

## Maintenance review

Test only; provider behavior is unchanged. Removing the shared connection promise makes the revised test fail with three spawns, so it still guards reconnect sharing. README overview, onboarding and installation configuration are unchanged.
