### Fixes

- Stop and await Claude availability probes during daemon shutdown so authentication checks cannot recreate files during test cleanup.
- Wait for command children to close before reporting cancellation.

## Maintenance review

Reviewed provider discovery and command cancellation ownership. The provider diagnostics inventory now records availability-probe shutdown; network gate and proxy behavior are unchanged. README overview and onboarding are unchanged.
