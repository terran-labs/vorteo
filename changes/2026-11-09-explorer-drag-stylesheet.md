### Fixes

- Dragging the docked Explorer's edge no longer rewrites the app's shared stylesheet on every frame, so resizing stays smooth.

## Maintenance review

Vorteo's floating Explorer card passed its width as an ordinary style, so Unistyles web registered a new CSS class and replaced the shared stylesheet on each drag frame. The width now uses the inline style lane, as upstream's Explorer frame already does (#7284). The existing upstream drag performance test passes again. The customizations inventory and README need no updates.
