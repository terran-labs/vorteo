### Fixes

- Preview broker deployment checks a framework Python image's protection before reading it, so a pipe or oversized file at that path refuses promptly instead of hanging preparation. Refused preparation messages shown in installation controls and the log no longer carry terminal escape sequences or control characters.

## Maintenance review

Follow-up to the framework Python review. `digestProtectedExecutable` streams an executable's digest after the existing protection checks (canonical, regular single-link file, owner-only, executable, bounded) on one no-follow, non-blocking descriptor; `verifyExecutable` keeps its behavior on top of it, and the deployment executor uses it for the derived image instead of an unbounded read. The refusal line drops ANSI CSI and OSC sequences and C0, DEL and C1 controls, and a carriage return ends the line. Tests cover symlinked, group-writable and FIFO images with the real checks, argv order and extra arguments in the worker's route match, and the sanitized refusal text. The broker maintenance guide and inventory entry stay accurate; README overview and onboarding are unchanged. Source only; not installed.
