### Fixes

- Keep worker restarts waiting for provider children reported running by the attached session. Historical child descriptors remain visible in the conversation.

## Maintenance review

Restart impact now uses runtime child lifecycle events. The existing history replay test covers stale descriptors, a live child under an archived parent, and the child's completion. The README overview and onboarding are unaffected.
