### Improvements

- Time Machine skips dependency installs inside task artifacts, at the owner's request, without excluding the evidence, screenshots or checkout source stored there.

## Maintenance review

Owner decision 2026-11-11: `--node-modules-under <folder>` marks every directory named exactly `node_modules` inside a folder, found by a walk that never enters one it found, `.git` or a link, with real-path containment. Used for task artifacts, whose orphaned checkouts Git cannot read. A test row covers nesting, exact names, links and `.git`. README overview and onboarding are unchanged.
