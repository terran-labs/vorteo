### Tooling

- The secret scan checks only the commits a pull request, merge group or main push adds, instead of the whole repository history every time. A nightly run still scans all reachable history, and branch pushes no longer run a separate scan because their pull request does.

## Maintenance review

Owner-approved CI optimization: scoped the Secret scan workflow by event, added a nightly full-history run, and let `security:secrets` take an optional `SECRET_SCAN_LOG_OPTS` range that defaults to full history, so the pre-push hook is unchanged. Updated publication hygiene and the CI workflow test. README overview and onboarding are unchanged.
