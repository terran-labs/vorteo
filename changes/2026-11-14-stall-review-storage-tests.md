### Maintenance

- Move the stored review claim tests inside the review window now that late slots are forfeited.

## Maintenance review

Test-only correction for the stall review cost guards. Two agent storage tests claimed a review an hour after activity, which the forfeiture rule now refuses; they claim inside the first slot, assert that a late slot is refused, and take the second rung 15 minutes later. No product code changes. README overview and onboarding are unchanged.
