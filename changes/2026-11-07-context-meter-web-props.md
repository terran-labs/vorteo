### Fixes

- The context window meter no longer passes native-only accessibility props to web SVG elements, which logged React warnings on every workspace.

## Maintenance review

Reviewed the context window meter's decorative rings. They now use the same web-safe decorative props as the quota timelines and checklist flower: aria-hidden on web and the native accessibility props elsewhere. The demo workspace browser test's clean-console check passes again. The customizations inventory and README need no feature updates.
