### Fixes

- Keep owner attention after a restart hold deadline when its policy is omitted. Automatic interruption requires an explicit `auto` setting and the existing authenticated preparation checks.

## Maintenance review

Corrected the deadline configuration comment, installation guide, customization inventory and original preparation fragment. Tests cover an omitted policy and explicit ask preserving the owner prompt without cooperative preparation; automatic scenarios now opt in explicitly. README overview and onboarding are unchanged. No installation configuration was changed.
