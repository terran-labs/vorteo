### Maintenance

- The daemon advertises `previewStopOutcome` beside `previewStop`, saying every preview restart outcome names its mode. Apps send broker stops only with both, because a daemon released between the two reports a failed stop like a failed start (#586).

## Maintenance review

Capability only, for the outcome mode added in #599; no behaviour changes. The inventory's previews entry already describes the outcome mode, so it is unchanged. Needs a Host daemon restart, and Dev for Dev previews; until then the app keeps the terminal stop. README overview and onboarding are unchanged. Source only; not installed.
