### Maintenance

- Strengthen the Claude catalog shutdown regression to check child exit before awaiting the refresh, so the test detects shutdown returning before cleanup.

## Maintenance review

The provider diagnostics inventory and README remain accurate; production behavior is unchanged. Removing catalog draining now fails both active-child cases, and restoring it passes the focused suites. The version marker test proves no late writes, not the absence of an attempted process launch.
