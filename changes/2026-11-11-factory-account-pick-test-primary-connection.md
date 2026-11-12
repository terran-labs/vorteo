### Maintenance

- Repair two Factory account choice tests whose daemon settings chose no primary connection, so the pick for a stage without a profile never ranked any account.

## Maintenance review

Test-only correction. The usage dating fix and the primary connection landed on parallel branches. Once merged, a standalone daemon with no primary connection has no default launch, so a stage without a profile resolves no provider type and the pick returns no account on every platform and time zone. The fixtures now choose Codex as the primary connection. The dating test passes with its assertion unchanged, and the usage failure test now reaches the failed usage read it names instead of passing early. Production account choice is unchanged. README overview and onboarding are unchanged.
