### Fixes

- Dev now knows an adopted legacy Codex folder by its real path, so inode numbers that drift on Dev's virtiofs mount no longer stop the Host's sign-in from reaching it, and the saved backup there can still be deleted on time. Each drift is logged. Dev advertises the new `codexLegacyPinByPath` capability (#647).
- An adopted folder's projection now counts as Vorteo's only for the account it was written for, so another account's folder moved into place is replaced only when it holds a sign-in of the same person. The `.vorteo-signin` folder must be a real folder, and Dev restores a saved sign-in only for a person the coordinator names (#647).

## Maintenance review

Dev side of #647: path identity for adopted legacy Codex homes, a per-home definition binding, a real-directory check on `.vorteo-signin`, the gated `inspect` operation and restore `persons`, the optional target `dev`/`ino` widening, and the daemon logger passed to the account consumers. The adopted legacy Codex inventory entry is updated; the providers guide and protocol notes follow with the coordinator change. README overview and onboarding are unchanged. Not published.
