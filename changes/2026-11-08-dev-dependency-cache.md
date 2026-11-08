### Features

- Dev container checkouts reuse a cached dependency install. On Linux the dependency cache copies a finished install of the same lockfile into each new worktree instead of running a full `npm ci`, which skips the download, extraction and native builds. Each environment keeps installs built for its own platform.

### Maintenance

- In task worktrees and `paseo.json` workspace setup, a full dependency install now waits for the environment's heavy-job slot, as the queue's rules already required. Heavy jobs mark their commands with `VORTEO_HEAVY_JOB=1`, so an install that already runs inside one, or as Builds, does not wait on itself. Installer, coordinator, web build and live dev installs keep running at once, since they can run while the Builds gate holds the slot.

## Maintenance review

Step 3 of running Factory issue agents in Dev, chosen by the owner on 2026-11-08. `scripts/lib/dependency-cache.mjs` enables the cache on Linux with `cp -a --reflink=auto` and queues full installs through `scripts/heavy-job.mjs`; `launchSpec` sets the nested-job marker. The cache and heavy-job tests cover the queued install, the Builds exemption and the marker. Review fix: queuing is opt-in for task worktrees and `paseo.json` setup (`install-dependencies.mjs --queue`), because the installer, the coordinator's protected preparer and web builds can run while the Builds gate holds the slot, and the protected tooling does not ship `heavy-job.mjs`. Updated the shared dependency installs and heavy-job docs and the inventory entry. README overview and onboarding are unchanged. Not installed.
