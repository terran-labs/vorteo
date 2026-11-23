### Features

- The scripts menu shows a managed preview's state in one plain line under its name: running, starting, not responding, or stopped with the time and, when the broker recorded it, why (a Vorteo restart, a settings change or another program taking its place). Times are local and to the minute. When Vorteo is too busy to check, the line says what was last known. Start and Restart for these previews go through the preview broker, so the link stays the same, and Restart on a running preview asks first. Previews waiting for a link repair, in an archived workspace or already starting offer no Start (#586).

## Maintenance review

Updated the private workspace previews entry with the scripts menu's preview line and broker-routed Start and Restart. The wording is provisional and lives in one module, with English in every locale until the owner approves it. Stop is unchanged until the daemon gains a broker stop. Interface only; requires a daemon with `previewRestart`, so it must not publish before #590 is installed. README overview and onboarding are unchanged. Source only; not published.
