### Features

- Shared profiles can save a reasoning level, including Claude Ultra Code, or follow the model default, which the editor names, such as Model default (Medium).
- Profile picker rows show the model and effective reasoning, and the composer's profile button adds the reasoning level.
- Choosing a profile without saved reasoning uses the model default instead of the composer's last remembered level.
- Fable 5.2 now defaults to Medium reasoning, matching Claude Code.

## Maintenance review

Shared workflow editing now stores the existing optional `thinkingOptionId` field instead of discarding it; the wire format, capabilities and migration are unchanged, and workflows without the field keep the model default. The Fable 5.2 default is a daemon catalog change. The shared workflows inventory entry and launch presets guide describe the behavior. README overview and onboarding are unchanged.
