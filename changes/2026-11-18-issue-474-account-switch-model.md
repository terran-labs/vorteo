### Fixes

- Coordinator account-only switches carry the source's configured model, or its recorded runtime model when the configured choice is unset, through validation, creation and storage. Explicit request models override named target-profile models, which override that source fallback. Unloaded threads use persisted runtime data.
- Carrying an unselected runtime model pins it explicitly, so the thread stops following future provider-default model changes. Unset thinking remains unset and uses that model's default; effective permission mode and feature values still carry over. A missing feature still refuses even when its preserved value is false.
- A source with neither a configured nor a recorded runtime model refuses with `incompatible-target` and asks the caller to load the source or choose a model or model-bearing profile. Frozen profiles and catalog defaults are not substitutes. Legacy records and incomplete catalog/runtime observations can leave the model unknown; frequency is unmeasured. App switching and source-only dry runs retain their behavior.

## Maintenance review

Updated the account-switching inventory for model precedence, runtime-model pinning and unknown-model refusal. The existing switch suite uses Claude's pure feature builder and manifest model options with fake sessions and differing account defaults. README overview and onboarding are unchanged. This server repair requires a daemon installation by Builds. Disposable-thread live checks remain owed for account-only moves in both directions, retained conversation and settings, caller/reason journaling, an ordinary mode change and enforcement of the carried permission mode; fake validation does not discharge them.
