### Fixes

- The Usage settings card follows the app language again; its Settings, Percentages, Used and Remaining labels were stuck in English.

## Maintenance review

Reviewed the Usage settings card after merge 51f16b39f, which kept Vorteo's card layout but took its hard-coded English labels instead of upstream's translations from #7376. The card now reads the existing providerUsage translations; the English usageCopy object still serves non-interface messages. The existing language test covers it. The customizations inventory and README need no feature updates.
