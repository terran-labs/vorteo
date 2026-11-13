### Fixes

- Attach the Previews service to the agent manager at startup, so the publish and feedback tools and the Previews feature flag are present on a running daemon.

## Maintenance review

Correction to the unreleased Previews gallery. The service was constructed and its routes mounted, but tools and client requests reach it through the agent manager, which never received it. Found by starting the built daemon in an isolated home and calling the tools through the agent tool endpoint; the same run confirmed publishing, thumbnails, rating, pairing and refusal of forged feedback. README overview and onboarding are unchanged.
