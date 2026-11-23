### Fixes

- On Windows, a symbolic link at the preset fence policy file was followed instead of refused, so a link to a missing file looked like no policy at all. The daemon now checks the path itself before opening it and refuses a link or junction on every platform (#360).

## Maintenance review

Preset fence policy reads refuse links with an `lstat` check on every platform and confirm the opened file is the one checked; POSIX keeps `O_NOFOLLOW` and `O_NONBLOCK`. Inventory behavior is unchanged (links were already described as refused). README overview and onboarding are unchanged. Source only; not installed.
