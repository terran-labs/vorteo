### Features

- A coordinator bound to a worker preset can ask for a lead thread on another preset with `request_lead_launch`. The daemon stores the exact launch, asks the owner on the coordinator's thread and starts the lead only when the owner picks an option in the app; a retried or simultaneous click, any edit to the preset, or a withdrawn question starts nothing, while an unrelated settings save does not block it. The card shows an excerpt of the lead's first task, what each preset allows, and recommends no option (#360).

### Maintenance

- Agent paths that could start or reshape a coordinator's threads outside its worker preset, from the coordinator or any thread beneath it, including while the coordinator is idle or closed (local, remote and CLI creates, `update_agent`, `set_agent_mode`, `send_agent_prompt` with a mode, `switch_agent_profile` and agent schedule tools) now log "Preset fence would refuse" with the path, reason and thread IDs. Nothing is refused yet; enforcement follows a day of installed logs (#360).

## Maintenance review

Added the "Owner-confirmed lead launches and the preset fence" inventory entry under supervised workers: a daemon-owned confirmation question with a stored, single-use launch record checked again on the create path, and a report-only preset fence on the remaining agent launch and settings paths, including launches by the coordinator's workers (security review of #584). No wire or app change. The #525 caller-identity limit is recorded. README overview and onboarding are unchanged. Source only; not installed.
