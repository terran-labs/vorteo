### Features

- A refused preview start says which limit applies: this preview is already starting or stopping, or several previews are. A stop in progress reads "Stopping the preview." (#586).

### Maintenance

- Behind `previewStop`, the scripts menu's Stop for a reserved preview goes through the preview broker so the stop records as explicit; otherwise it ends the terminal as before. Not for merge until restart outcomes carry their mode: a failed or unconfirmed stop would read as a failed start today.

## Maintenance review

Updated nothing in the inventory's behavior yet: the broker Stop is held until the daemon reports an outcome's mode, and the refusal split is wording in the existing preview strings module. README overview and onboarding are unchanged. Source only; not published.
