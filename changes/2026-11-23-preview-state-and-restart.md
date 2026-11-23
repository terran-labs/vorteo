### Maintenance

- Workspace script status carries an optional `preview` state for services the preview broker has reserved: ready, not responding, starting or stopped, with the broker's recorded cause and times and whether the state is stale. The daemon re-sends script status when the broker's published state changes (#586).
- New `workspace.script.restart_preview.request`, gated by `previewRestart`, starts or restarts a managed preview through the broker so its link stays the same. Only sessions that signed in with the daemon password may use it; the local credential, service, plugin and password-less sessions are refused. The client SDK adds `restartWorkspaceScriptPreview`. The app does not use it yet (#586).
- Sessions record how they were admitted (password, local credential, service, plugin or no password configured), from transport admission only.

## Maintenance review

Updated the private workspace previews entry with the daemon's preview state and the owner-only restart request. In Dev the broker channel is agent-writable, so the daemon shows only known stop codes and plain error text from it and never grants anything from it. Needs a Host daemon restart, and Dev for Dev previews; wire fields are optional and capability-gated. README overview and onboarding are unchanged. Source only; not installed.
