### Performance

- Host release builds during installs and upgrades reuse cached dependencies on macOS instead of downloading and installing them from scratch.
- Upgrades build both the Host and Dev before restarting anything, so running agents are interrupted only at the end. A failed build, or one that never reports, leaves everything running as it was.
- Dev upgrades reuse the server the Host release already compiled for the same commit, so building Dev's release or image no longer compiles every package a second time.
- Most Dev upgrades restart only Dev's daemon on a release the Host builds, instead of rebuilding and recreating Dev's image. The image is rebuilt only when its own files change, and Dev returns to the previous release if the new one is unhealthy. The first upgrade after this change still rebuilds the image once.
- A Dev release that fails and is rolled back is swapped in again when the installer reruns, instead of being reported as installed, and returning Dev to an earlier image also returns it to the release that image ran.

## Maintenance review

Merged current `main` into the Dev release mount and shared-server branch, and moved its changelog entries into this change fragment. The Dev image caching entry already has its own fragment. README overview and onboarding are unchanged.
