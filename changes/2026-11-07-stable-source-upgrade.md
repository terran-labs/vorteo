### Features

- Stable installations can install one reviewed commit from `main` before the next release. The coordinator checks that the commit is on `main`, is not a downgrade and passed the required checks, waits for the owner's approval, and installs it through the release upgrade's tracked steps. For 24 hours the owner can roll an installer-built Host back to the release it replaced. Owner routes only; Settings controls follow.

## Maintenance review

Added source upgrades as a second instance of the release upgrade pipeline with its own journal, owner routes, `sourceUpgrade` capability and installer refusals; the inventory gains a source-awaiting-publication entry. Removed the duplicated "Installation type and lab self-updates" section from the installation guide. README overview and onboarding are unchanged because no interface exists yet.
