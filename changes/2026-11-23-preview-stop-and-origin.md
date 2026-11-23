### Maintenance

- Behind the new `previewStop` capability, `workspace.script.restart_preview.request` accepts mode `"stop"`: the daemon asks the preview broker to stop the preview, under the same password check, refusals and concurrency limits as a start, so an owner's stop records as an explicit stop. Every reserved service's `preview` now carries `origin`, the broker's reserved HTTPS origin, stopped or running, so the Previews gallery can match a stopped preview's link. A refusal for the restart limits now has its own code, `capacity`, apart from `busy` for a preview already in flight (#586).
- The bounded reader for the preview broker's files checks each path with `lstat` first and refuses links, junctions and anything that is not a regular file on every platform, then confirms the opened file is the one it checked. Windows has no `O_NOFOLLOW`, so a link there was followed before. This matches the preset fence policy reader (#595).

## Maintenance review

Updated the private workspace previews entry with the broker stop, `preview.origin` and the link check that holds on Windows. Wire fields are optional and capability-gated. Needs a Host daemon restart, and Dev for Dev previews. README overview and onboarding are unchanged. Source only; not installed.
