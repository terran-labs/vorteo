### Maintenance

- The Unistyles lifecycle browser test reads the stylesheet after an unmount on the next animation frame instead of exactly two microtasks later. Batched stylesheet rebuilds (#609) drop a removed rule one microtask later, which left the old read with no margin; a frame is what a user would observe.

## Maintenance review

Test-only change to a Vorteo spec. Functionality is unchanged. README overview and onboarding are unchanged.
