### Maintenance

- The usage sources integration test checks each field of the legacy provider usage response exactly, instead of the whole object, so the optional `automaticPrimary` field added in #669 no longer fails it.

## Maintenance review

Test only; usage behavior is unchanged. The case still asserts `requestId`, `fetchedAt`, every provider entry and `workerActivity` exactly, and no other e2e test in that directory asserts the whole shape of this response. README overview and onboarding are unchanged.
