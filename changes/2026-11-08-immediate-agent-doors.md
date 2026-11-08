### Features

- Builds can take a safety snapshot, verify a failed helper's installed receipts and prepare a Dev repair under the full maintenance grant with `request-snapshot`, `request-helper-verification` and `request-dev-repair`. Each runs at once, and Installation controls history lists it under **Agent actions**.
- A Dev repair prepared under the grant follows the delegated Dev restart queue, with its thirty-second window and Cancel, instead of always waiting for the owner.

### Maintenance

- The front-door test accepts immediate agent requests only for handlers that restart, install and change nothing.

## Maintenance review

Added immediate agent doors for three pinned front-door gaps, with a receipt store shown in Installation controls history, and delegated Dev repair preparation under the full grant without adding fields to the shared lifecycle journal. Seven pinned gaps remain. Not yet installed. README overview and onboarding are unchanged.
