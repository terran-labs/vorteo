### Fixes

- Normalize slow EC2 Ubuntu archive entries inside the CI runner's explicitly referenced local mirror list. Preserve healthy entries, order, comments and metadata while retaining the existing installation and recovery limits.

## Maintenance review

Updated the CI inventory and testing guide after the first hosted candidate timed out safely but missed the indirect EC2 mirror. Canonical-mirror throughput and downstream website acceptance still require the repaired candidate's own CI evidence. README overview and onboarding remain unchanged because this affects CI setup only.
