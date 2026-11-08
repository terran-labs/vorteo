### Fixes

- On a narrow window used with a mouse, clicking a control shows its tooltip instead of opening it on hover and closing it on the same click; a second click hides it.

## Maintenance review

Narrow windows use touch controls even with a mouse, so tooltips toggle on press there, while a mouse hover had already opened the tooltip just before the click. A press now keeps a hover-opened tooltip open and only toggles one it opened itself. Real touch taps report a touch pointer and are unchanged. The shared message queue, compact subagent sheet and demo keyboard tests pass. The customizations inventory and README need no updates.
