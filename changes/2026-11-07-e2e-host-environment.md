### Fixes

- Browser tests started from an agent shell on a managed Host no longer hand the Host's installation client, daemon home or agent identity to their isolated daemons, so agent creation works there without stripping the environment by hand.

## Maintenance review

Reviewed the app Playwright harness. Both Playwright configs now scrub the Host's own variables once at load, which covers the runner, every worker and every child process; product behavior is unchanged, docs/testing.md records the rule, and the customizations inventory and README need no feature updates.
