### Fixes

- Show the conversation navigation rail on tablets and small windows whenever the margin beside the messages can hold it, and hide it when a widened text column would put it over messages or tool rows. Phone layouts are unchanged.
- Keep the floating Latest button on its resting background when hovered, so it is no more translucent on hover than at rest and conversation text no longer shows through it in the built-in appearances.

## Maintenance review

The conversation rail previously hid below a fixed 918 pixel panel width. Stream columns now publish where message content starts, and the rail shows on non-phone layouts only when its column plus an 8 pixel clearance ends before that edge, so classic always-visible scrollbars cannot put it over text. The browser outline spec drops its stale 918 pixel checks; one geometry case covers the content edge. The floating Latest button used the secondary button hover, whose surface is translucent, so hover now keeps the control's resting background and paints the tint over it. Plugin themes may still define a translucent control colour; the pressed state's existing 85% opacity is unchanged. Interface only. README overview and onboarding are unchanged. Not installed.
