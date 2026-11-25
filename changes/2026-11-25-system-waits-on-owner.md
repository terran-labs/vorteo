### Features

- Settings > System shows only what waits on the owner (#656). In Host and Dev Details, approvals the owner must give, failures that still count and recoveries to reconcile stay open with their one action. Work in progress folds into "In progress (N)", unattended maintenance into "Maintenance", finished requests from every queue into "History (N)", and transport, version, process and commits into "Diagnostics". A Fix or deep link still opens the section that holds its card.
- A restart that another agent handles, or that the installation's recorded policy will approve, shows one plain line ("Being handled by …", "Preparing; it will be approved automatically") with its reason behind Show reason, and no Approve button. Without recorded policy fields a request waits on the owner and Approve shows.

### Fixes

- "Coordinator maintenance is unavailable" no longer appears as a red error with internal phase and class codes. It reads as one muted line in Maintenance that says the reason is not known yet and that restarts and updates still work.
- A failed coordinator status refresh reads "Status could not be refreshed. Retrying." It turns red only after three failures in a row, saying the Host is not answering and retries by itself.
- Host's Diagnostics show the installed commit from the upgrade status when unattended maintenance does not report one; Dev omits the line instead of saying Unknown.

## Maintenance review

Updated the System status and restart controls entry for the waiting-on-owner layout. Interface only; not installed. README overview and onboarding are unchanged.
