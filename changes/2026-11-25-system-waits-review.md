### Fixes

- A request the owner decides in Settings > System stays in view as one line, with its status and then its result, until they leave the page, instead of folding into In progress as soon as they tap. Its full card stays in its section (#656).
- The sidebar badge and the Health list no longer count a pending restart that another agent is handling or that recorded policy will approve, matching the Host card and Details (#656).

### Maintenance

- The broker and monitor review browser tests open In progress only for approved and running requests and check each card's section, so a waiting card filed under In progress fails (#656).

## Maintenance review

Review follow-up to the waiting-on-owner layout; the System status and restart controls entry is updated for decided requests. Interface only; not installed. README overview and onboarding are unchanged.
