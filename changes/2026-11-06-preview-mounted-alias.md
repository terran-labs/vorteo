### Fixes

- Accept Dev preview workspace aliases only after verifying the configured bind mount and its unchanged destination. Preserve workspace grants, service identity and retained reservation checks.

## Maintenance review

Generalized the retained-registration alias check in the preview broker and added focused security regression coverage. Inventory updated; README overview and onboarding are unchanged. Request expiry and inventory timeouts remain unchanged. No deployment performed.
