### Features

- Share Voice OpenAI keys and endpoints with every installation environment. Adopt existing keys once, require an owner choice for conflicts, and retain local saves without an installation.

### Fixes

- Keep key and endpoint updates atomic and revision checked. Reject endpoint-only adoption, validate endpoints, expire identity-bound adoption nonces, and prevent empty or withheld deliveries from persisting local fallbacks.
- Release shared credential markers when an environment leaves the installation.

### Maintenance

- Integrate current main and validate Voice credential adoption, delivery, conflicts and standalone fallback before delivery. Confirm that a Host updated before its coordinator retains existing transcription credentials while shared credential edits wait for the coordinator update.

## Maintenance review

The installation owns shared Voice key and endpoint pairs. Existing security fixes remain in place while current main is integrated. The customizations inventory records the remaining delivery limitation; README overview and onboarding are unchanged.
