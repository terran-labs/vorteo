### Fixes

- On phones, opening a file from Explorer keeps Explorer underneath its sheet, so closing the sheet returns to the file list.

## Maintenance review

The compact Explorer overlay closed itself whenever it opened a file, but compact layouts open files in a sheet above Explorer (upstream #7693), so closing the sheet left the bare workspace. It now closes only when the file opens as a tab. The phone Explorer and compact sheet browser tests pass. The customizations inventory and README need no updates.
