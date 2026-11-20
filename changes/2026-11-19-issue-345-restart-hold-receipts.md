### Fixes

- Show live restart hold details in installation controls and history, including the option to keep waiting at an ask-mode deadline.
- Preserve failed hold-release reasons and distinguish them from the restart outcome. A confirmed retry keeps the earlier failure without repeating the restart.

- Bound and redact untrusted hold-release diagnostics, including recovered failure history, before displaying them. Keep diagnostic text distinct from owner decisions.

## Maintenance review

Updated the execution environments and installation inventory and installation reference. The configurable 15-minute deadline, ask default, recorded automatic choices, cancellation and interruption admission are unchanged. Security review bounds diagnostic processing and output, strips terminal and Unicode line controls, and redacts credential-shaped values and home paths. Hostile fake-adapter coverage includes recovery and confirmed retries without extra dispatch. Receipt handling uses existing fields and requires acknowledgement before reporting release. Validation uses fake lifecycle adapters; no live restart acceptance is claimed. README overview and onboarding are unchanged.
