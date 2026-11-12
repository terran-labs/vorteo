### Fixes

- Prevent Claude sign-in from launching after cancellation while its probe directory is being acquired.
- Isolate model-discovery fixtures from persistent probe storage and preserve retained helper files.

## Maintenance review

Corrected the final cancellation guard ordering without changing sign-in arguments, environment or authentication defaults. Added deferred cwd-acquisition cancellation and disposal regressions with a fake launcher, and injected fake authentication verification into existing login fixtures so installation custody does not affect them. Model discovery keeps its cwd-binding assertion using private test storage. README overview and onboarding are unchanged. Installation and independent re-review remain separate from source validation.
