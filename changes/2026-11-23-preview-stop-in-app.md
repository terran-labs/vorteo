### Features

- A refused preview start says which limit applies: this preview is already starting or stopping, or several previews are. A stop in progress reads "Stopping the preview." (#586).

### Maintenance

- Behind `previewStop`, the scripts menu's Stop for a reserved preview goes through the preview broker so the stop records as explicit; otherwise it ends the terminal as before.

## Maintenance review

The broker Stop's inventory update is in the stop outcome fragment of the same pull request; the refusal split is wording in the existing preview strings module. README overview and onboarding are unchanged. Source only; not published.
