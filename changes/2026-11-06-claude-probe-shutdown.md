### Fixes

- Stop and await Claude availability probes during daemon shutdown so authentication checks cannot recreate files during test cleanup.
- Wait for command children to close before reporting cancellation; force an aborted child to exit after a one-second cleanup grace period if it ignores its signal.

## Maintenance review

Reviewed provider discovery and command cancellation ownership. The provider diagnostics inventory now records availability-probe shutdown; network gate and proxy behavior are unchanged. README overview and onboarding are unchanged.
