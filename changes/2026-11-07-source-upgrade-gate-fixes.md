### Fixes

- The installer replaces a source upgrade only when its record is abandoned: unchanged for 10 minutes, with no Host build, including build-only builds, or coordinator handoff running, and no coordinator answering for two minutes. Release upgrade takeover now also recognizes build-only Host builds.
- A source upgrade stops before its next step, and before the Host restart, once the installation becomes Lab. It checks again right before the Host restart that the Host has not changed.
- On installer-built Hosts, a release upgrade refuses a release that does not contain a commit a source upgrade installed.
- The update check notes, rather than reports as an error, a release it holds back while another job blocks release upgrades. This applies to every installation, Lab included.

## Maintenance review

Gate review fixes to the unpublished source upgrade slice. The installation guide section was revised; the inventory entry still describes the feature accurately. README overview and onboarding are unchanged.
