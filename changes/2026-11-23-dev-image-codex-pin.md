### Maintenance

- The Dev image installs Codex 0.167.2 instead of 0.153.4, matching the version Builds installed in Dev on November 23, so a rebuilt image does not ship an older CLI. Which Codex the Dev daemon runs is set by its configured provider command, not by the image.

## Maintenance review

Image pin only. It changes nothing until the next Dev image build, and not the Codex the Dev daemon runs. README overview and onboarding are unchanged.
