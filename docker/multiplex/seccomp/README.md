# Dev seccomp policy

`../dev-seccomp.json` is generated from the unmodified, vendored `upstream-default.json` plus exactly the exceptions in `generate.py`. The baseline is [moby/profiles seccomp v0.2.3](https://github.com/moby/profiles/blob/836ae4d37ef2ec995c77c99fc55f5b5f3af3a897/seccomp/default.json), commit `836ae4d37ef2ec995c77c99fc55f5b5f3af3a897`. Its SHA-256 is `536529b665dd0972c37bfb569f5d4ac8a53592e7b00752bc39ff063ca9864c74`. The upstream Apache license is included in `LICENSE`. Preserve the baseline's exact bytes; the generator checks its checksum and the formatter excludes this vendored file.

These unconditional syscall allowances are the complete approved exception list:

| Syscall      | Justification                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------------- |
| `clone`      | Bubblewrap creates child processes in its private namespaces.                                  |
| `clone3`     | Preserve the installed bubblewrap namespace-creation exception for the clone3 interface.       |
| `unshare`    | Bubblewrap creates an unprivileged user namespace before setting up its private mount tree.    |
| `mount`      | Bubblewrap constructs its private mount tree inside its user namespace.                        |
| `umount2`    | Bubblewrap detaches mounts from its private mount tree.                                        |
| `pivot_root` | Bubblewrap switches to the root of its private mount tree.                                     |
| `chroot`     | Chromium seals its sandbox using chroot inside its unprivileged user namespace for issue #284. |

Five bubblewrap exceptions remain after controlled removal probes; chroot addresses issue #284. Compared with a deployment using Docker's upstream default, all six are additional unconditional allowances. Compared with the installed Dev snapshot, this policy adds chroot and removes the redundant clone3 rule. It adds no container capabilities; kernel permission checks still apply. Applying it requires runtime security review on every deployment, including new installations.

## Controlled removal evidence

The 2026-11-11 probes used image `sha256:c3e40898d642dc2580412730546cb32c6f5c2e7c68b7aa109da979e87efcfbfc`, `--user paseo`, `--cap-drop ALL`, `--network none` and `no-new-privileges:true`. Each disposable container used the seven-rule candidate with exactly one exception removed. Existing Dev volumes were mounted read-only; HOME and CODEX_HOME pointed to fresh temporary directories. No live Dev configuration changed and no account or model call was made.

The provider probe ran the installed Codex 0.160.0 native binary at `/home/paseo/.local/share/vorteo-provider-cli/codex-0.160.0/node_modules/@openai/codex-linux-arm64/vendor/aarch64-unknown-linux-musl/bin/codex` with `sandbox -- /bin/sh -c 'printf "PROVIDER_OK\n"; cat /proc/self/uid_map'`. The successful provider command returned `PROVIDER_OK` and the sandbox UID map `1000 0 1`. This invokes the provider's actual bubblewrap boundary, rather than a substitute bubblewrap command. The independent chroot probe created a user namespace, mapped UID/GID and called chroot on `/`.

| Removed exception | Provider sandbox                                               | Independent chroot probe | Decision          |
| ----------------- | -------------------------------------------------------------- | ------------------------ | ----------------- |
| None, baseline    | Pass                                                           | Pass                     | Control           |
| `clone`           | Fail: `bwrap: No permissions to create a new namespace`        | Pass                     | Keep              |
| `clone3`          | Pass                                                           | Pass                     | Remove            |
| `unshare`         | Fail: `bwrap: unshare user ns: Operation not permitted`        | Fail: unshare errno 1    | Keep              |
| `mount`           | Fail: `bwrap: Failed to make / slave: Operation not permitted` | Pass                     | Keep              |
| `umount2`         | Fail: `bwrap: unmount old root: Operation not permitted`       | Pass                     | Keep              |
| `pivot_root`      | Fail: `bwrap: pivot_root: Operation not permitted`             | Pass                     | Keep              |
| `chroot`          | Pass                                                           | Fail: chroot errno 1     | Keep for Chromium |

The final six-rule profile also passed both probes together. With that profile, a direct clone3 syscall returned ENOSYS (errno 38), and a glibc-backed Python thread started and joined successfully. Upstream's clone3 ENOSYS rule remains intact; no clone3 allowance is needed for the tested provider launch or thread creation. This permits glibc's fallback to clone. These probes establish the syscall requirements for this image and provider version, not completed Chromium browser acceptance.

Regenerate from the repository root:

```sh
python3 docker/multiplex/seccomp/generate.py
```

Verify the entire policy and run the focused regression tests:

```sh
python3 docker/multiplex/seccomp/generate.py --check
python3 -m unittest docker.multiplex.test_install.DevSeccompTests
```

Tests compare the complete parsed profile with the pinned baseline plus exactly these exceptions. They reject extra rules and changes to upstream rules. Changing the baseline or exception list requires another security review, regeneration and tests.

Applying the generated policy requires tracked container recreation. A daemon source update or restart cannot replace a running container's seccomp filter. Browser acceptance through the provider and bubblewrap boundary remains required afterwards.
