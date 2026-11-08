### Fixes

- Vorteo's dependencies install inside the Dev container. Node's built-in `fs.cpSync` directory copy fails with a permission error on Dev's shared Projects folder, on Node 22 and 24 alike, and `@shopify/react-native-skia` uses it during install, so every `npm ci` there failed. Linux installs now load `scripts/lib/cp-sync-js.cjs`, which keeps `fs.cpSync` calls that pass no filter of their own on Node's ordinary copy path.

### Maintenance

- In task worktrees and `paseo.json` workspace setup, a full dependency install now waits for the environment's heavy-job slot, as the queue's rules already required. Heavy jobs mark their commands with `VORTEO_HEAVY_JOB=1`, so an install that already runs inside one, or as Builds, does not wait on itself. Installer, coordinator, web build and live dev installs keep running at once, since they can run while the Builds gate holds the slot.
- The dependency cache stays macOS-only. Measured in Dev, copying a cached install onto the shared Projects folder took about 1m45s against about 2 minutes for `npm ci`, for a 5.6 GB cache.

## Maintenance review

Step 3 of running Factory issue agents in Dev. The owner first chose a Dev dependency cache (2026-11-08). Built and measured in Dev, it saved under a minute per worktree, so the owner was asked and this variant keeps the cache macOS-only. Implemented: the `fs.cpSync` shim for Linux installs (`scripts/lib/cp-sync-js.cjs`, preloaded through `NODE_OPTIONS` by `scripts/lib/dependency-cache.mjs`), opt-in queued full installs for task worktrees and `install-dependencies.mjs --queue` (paseo.json setup), and the `VORTEO_HEAVY_JOB` marker in `scripts/heavy-job.mjs`. Tests cover the queued install, the Builds exemption, the Linux shim command and the marker. Updated the shared dependency installs and heavy-job docs and the inventory entry. README overview and onboarding are unchanged. Not installed.
