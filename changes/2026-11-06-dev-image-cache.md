### Performance

- Dev image rebuilds reuse Docker's cache for the dependency install, the agent command-line tools and Tailscale, so upgrades rebuild only the packages that changed. A version bump or new build commit alone no longer reinstalls every dependency. First installs are unchanged.

## Maintenance review

Merged main into the Dev image layer caching branch and moved its changelog entry into a change fragment, then formatted the manifest script, which failed the format check. No behavior change.
