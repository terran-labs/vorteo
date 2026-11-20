### Features

- Machine turns in a thread collapse to one muted line: agent messages, agent notifications, system rows and background task notifications show the sender, kind, time and first words, adjacent ones share a line with a count, and pressing the line shows the rows as before. Your own messages, question answers included, keep full weight. Display only; what the model receives is unchanged.

## Maintenance review

Issue #521, slice C1. Added the Machine turn lines entry under Projects, devices and interface. Rows are classified by structure alone, after turn collapse, and the fold feeds the reading-position, find and outline reveal maps. One table in the existing presentation test covers owner messages, a question answer and quoted envelopes staying full weight, the four machine shapes, grouping and the reading position. Automatic prompts marked `origin: "agent"` and the show-everything setting are later slices. No locale strings were added: kind labels come from the existing agent message and tool call display names. README overview and onboarding are unchanged. Not rendered or reviewed on screen; not installed.
