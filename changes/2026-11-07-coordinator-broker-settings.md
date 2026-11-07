### Added

- Builds can request preview broker configuration changes through **Coordinator settings** on installer-layout installations. The coordinator pins the Docker endpoint, Dev container, Python and broker placement to recorded values, accepts code only from installer-managed releases, and hashes every file itself before approval and again before applying. The owner reviews each changed field as a path and digest prefix marked verified on disk.

## Maintenance review

Registered `previewBrokerDeployment` and `previewBroker` as reviewed broker settings and moved the bootstrap review's broker binding and executor checks into a shared module that both paths call. The coordinator settings job gained optional per-field changes, so older interfaces show these keys as changed without values. README overview and onboarding are unchanged.
