### Maintenance

- Pin the CI signature audit client to npm 11.19.1 so valid keyless provenance reaches certificate verification. Record the retained failure evidence and limits of the historical diagnosis.

## Maintenance review

The dependency signature audit retains registry and attestation checks. Controlled CLI cases reject damaged or missing signatures and damaged attestations. README overview and onboarding are unchanged because this changes CI tooling only.
