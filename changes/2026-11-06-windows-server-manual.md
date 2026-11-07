### Tooling

- The Windows server test jobs run only when started manually while a Windows Host is out of scope, instead of on every merge and nightly run.

## Maintenance review

Owner decision: no Windows Host for now. Routed `server-tests (windows-latest)` and `server-integration (windows-latest)` to manual runs through a new `windows_host` routing output that fails open, kept their tests, and extended the CI workflow test and testing docs. README overview and onboarding are unchanged.
