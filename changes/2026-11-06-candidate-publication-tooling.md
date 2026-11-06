### Fixes

- Host source updates use the verified candidate release's publisher and reviewed icon-migration rules, preventing stale tooling from refusing newer reviewed migrations. Publication rechecks the candidate artifact, source binding and preparation receipts after restart. Existing preparation-tool configuration stays compatible.
- This fix takes effect only after Builds installs it and renews the coordinator through the tracked lifecycle workflow.

### Maintenance

- Wait for background release retention before removing Host-install test fixtures, and document the publisher recheck’s same-account trust boundary.

## Maintenance review

Updated the installation reference and customization inventory for candidate-owned publication and retained preparation-tool renewal. Publisher guards and runtime behavior remain unchanged by the review repair. README overview and onboarding are unchanged.
