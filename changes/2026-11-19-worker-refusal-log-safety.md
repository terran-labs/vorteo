### Fixes

- Refusal log lines for worker launches and account switches can no longer replace the refusal, grow with the request or carry error text: a failing logger is ignored, every string is cut to 200 characters and only a refusal code is recorded. The switch tool's `provider` is limited to 256 characters.

## Maintenance review

Security review of the worker account change found the new log lines unguarded, unbounded and carrying raw error messages, and found documentation that overstated two rules. Refusals now go through one guarded helper that truncates strings and takes codes only. Worker refusals carry a code on a small error class or on the profile launch error; "Managed worker launch refused" fires only for those, and other creation failures are not logged by it. An unclassified switch failure is logged with a fixed label. The inventory, preset guide and supervisor instruction text now say the preset's worker account is a default and that a worker may also run on the supervisor's current same-type account whether or not the supervisor moved, and that model, reasoning, features and instructions are frozen while permission mode is not, pending #518. No dispatch rule changed. One test case covers a throwing logger and an oversized provider value, and the switch test asserts the model. README overview and onboarding are unchanged. Not installed.
