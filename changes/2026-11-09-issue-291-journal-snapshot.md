### Fixes

- Normalize the installation queue snapshot after a successful journal write so broker consumer deployment preparation can retain prepared or failed outcomes without a false reservation conflict. Genuine changes by another writer still invalidate the reservation.

## Maintenance review

Reviewed the broker consumer deployment inventory entry. This repair restores its existing preparation and failure bookkeeping contract without changing approval, plan binding or journal schemas. Legacy receipt and delegated restart test fixtures now use schema-valid UUIDs and distinct authority digests, preserving their assertions and grant toggling behavior. The existing entry remains accurate; README overview and onboarding are unchanged. A tracked coordinator installation is required before the repair affects running preparation requests.
