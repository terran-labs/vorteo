### Fixes

- The Host watch counts every open file of the Docker VM, including the descriptors lsof prints truncated as `*<digits>`, which are most of them under pressure.

## Maintenance review

Review follow-up on the Host watch: `countDescriptors` counts numbered and truncated descriptors from `lsof -F f`, not `cwd` or `txt`, with a test row. README overview and onboarding are unchanged.
