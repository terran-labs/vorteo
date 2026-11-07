### Tooling

- The upstream 50 MiB routed-host timeline test no longer runs in Vorteo's server suite. It is turned off by title in the server's test config, the same way retired upstream Playwright tests are, and still runs when named with `-t`.

## Maintenance review

Owner decision: Vorteo clients connect directly to every daemon over Tailscale and never use routed hosts, so per-route flow control was not built. The test failed on most Vorteo runs because a routed transfer has no end-to-end flow control (documented in the protocol compatibility guide). The upstream test file and the CI contract are unchanged. Re-check the retired-test list after each upstream merge. README overview and onboarding are unchanged.
