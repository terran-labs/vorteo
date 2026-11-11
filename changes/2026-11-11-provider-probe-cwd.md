### Fixes

- Run one-shot provider checks and background title/summary generation from a private temporary directory instead of scanning shared homes or source checkouts.

## Maintenance review

Audited Claude model/version/auth probes, Codex app-server helpers, ACP probes and provider diagnostics. Real sessions retain their workspace directory. Pi and Oh My Pi catalogs retain their existing directories because project settings and extensions depend on them, as agreed with the coordinator. Relative custom helper executable/settings paths require absolute configuration. README overview and onboarding are unchanged. Source validation is separate from installation; Host and Dev daemon updates require tracked restarts.

Metadata generation intentionally excludes project instructions, MCP configuration and settings, including when Pi or Oh My Pi supplies the fallback model. The runtime must keep its OS temporary directory on local storage. Probe directory ownership and privacy are verified on each use, and a removed directory is recreated.
