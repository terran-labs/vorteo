### Features

- Add the local account-switch tool and CLI command for individual threads or explicit workspace/project batches, with per-thread outcomes and refusal codes. A dry run checks only each source thread's eligibility and scope; it does not check the target account.
- Record the requesting caller and reason after a committed switch, and report audit failures without hiding the completed switch.
- Add the account-switch tool to the shared timeline presentation catalog.
- Keep provider discovery and saved-history loading off the dry-run path. Dry-run results report whether the source thread is eligible and omit target settings.
- Serialize settings changes with account switches so queued permission restrictions reach the replacement session.

## Maintenance review

Updated the account-switching inventory with tool and CLI usage, capability requirements and preserved authorization boundaries. README overview and onboarding remain unchanged. The saved-history repair from main is retained; this change does not alter its readers or storage.
