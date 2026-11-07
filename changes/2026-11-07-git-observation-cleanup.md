### Maintenance

- Adopt Paseo [#8743](https://github.com/getpaseo/paseo/pull/8743) to settle metadata observation before removing the missing-folder test fixture and drain queued Git trace writes before cleanup.

## Maintenance review

Reviewed the Git observation test against upstream commit `c7e137d4b466d77d775c0f1b47ebcb35c964622d`. This narrow adoption preserves the missing-folder polling, explicit refresh and restored-branch assertions; production behavior and the customizations inventory are unchanged. The restored wait uses the same 15-second bound as initial observation setup because it now waits for metadata observation, including its 10-second liveness canary, rather than only a repository link. Later upstream observation recovery changes are outside this adoption. README overview and onboarding are unchanged.
