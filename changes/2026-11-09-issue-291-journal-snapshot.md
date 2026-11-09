### Fixes

- Normalize the installation queue snapshot after a successful journal write so broker consumer deployment preparation can retain prepared or failed outcomes without a false reservation conflict. Genuine changes by another writer still invalidate the reservation.

## Maintenance review

Reviewed the broker consumer deployment inventory entry. This repair restores its existing preparation and failure bookkeeping contract without changing approval, plan binding or journal schemas. The existing entry remains accurate; README overview and onboarding are unchanged. A tracked coordinator installation is required before the repair affects running preparation requests.
