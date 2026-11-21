### Fixes

- Private previews on a busy Host no longer lose their link when a broker check times out. The broker keeps a verified route through up to two timeouts within 90 seconds while it confirms in place that the same listener process is still there, and any other failure still withdraws the route at once.
- A preview withdrawn after timeouts now says so and comes back on the next successful check, instead of reporting that its mapping removal needs administrator review.
- The broker reads Tailscale's published routes once per cycle for stopped previews, instead of once per stopped preview.

## Maintenance review

Updated the private workspace previews entry with the native timeout grace (issue #358). The periodic check and status requests share one failure rule. The container broker keeps withdrawing on the first timeout because it cannot recheck its listener without the slow call. One table case in the existing broker tests covers the grace, and the existing real-listener test covers the in-process recheck. README overview and onboarding are unchanged. Source only; not installed.
