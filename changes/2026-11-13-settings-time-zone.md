### Features

- Settings > General > Installation has a Time zone row. Automatic follows the browser of the owner device that opened Vorteo most recently; a searchable list of zones overrides it. The choice is shared by the installation and reaches the Host and Dev.
- Agents learn the owner's time zone. Each launch adds one line naming it with the current abbreviation, and the list hosts tool returns it.

### Known limitations

- A daemon without an installation has no Time zone control, so its agents get no time zone line.
- Factory role schedules and the Optimizer review still use the daemon's own zone, which is UTC in Dev.

## Maintenance review

Added the owner's time zone to shared installation settings and daemon settings, behind the new `timeZoneSetting` capability and opt-in reads for older strict clients and daemons, with a Settings row in General > Installation. A new Owner time zone for agents inventory entry describes it. README overview and onboarding are unchanged.
