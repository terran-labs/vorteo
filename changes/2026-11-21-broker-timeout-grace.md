### Fixes

- Private previews on a busy Host no longer lose their link when a broker check times out. The broker keeps a verified route through up to two timeouts within 90 seconds while it confirms in place, without starting a subprocess, that the same listener process still listens on the preview's loopback port. Any other failure still withdraws the route at once.
- A preview whose process exits during that wait is withdrawn but stays requested, so restart recovery and the next clean check still bring it back.
- A preview withdrawn after timeouts now says so and comes back on the next successful check, instead of reporting that its mapping removal needs administrator review. A removal that times out after a definite failure keeps that failure as the reason and is retried next cycle.
- The broker reads Tailscale's published routes once per cycle for stopped previews, instead of once per stopped preview.

## Maintenance review

Updated the private workspace previews entry with the native timeout grace (issue #358), revised after security review. The periodic check and status requests share one failure rule. The in-process port check mirrors the macOS socket structures from the SDK header and only grants grace when it agreed with `lsof` at the last full verification, saying yes for the proven port and no for a port the process does not hold. The container broker keeps withdrawing on the first timeout because it cannot recheck its listener without the slow call. Cases in the existing broker tests cover the grace, the review findings and the real macOS listener check. README overview and onboarding are unchanged. Source only; not installed.
