### Features

- The installation records one primary connection, stored once in shared settings and used in every environment. The Optimizer, Factory and other system threads launch with it, through its profile when one is set. Without one they wait instead of picking whichever provider is usable first.
- Upgrades adopt the only usable connection as primary once. With several, Settings asks the owner to choose: General Status shows "Choose a primary connection for system threads", and Providers marks the primary connection and offers Make primary, with a confirmation, on other ready connections.
- Standalone daemons show the same Primary badge and Make primary action on their providers page, saved in the daemon's own config.
- When the primary connection is off, signed out or not ready anywhere, General Status says "Your primary connection is unavailable. Choose another for system threads." Turning off the primary connection first warns that system threads will wait. Nothing switches automatically.

### Maintenance

- Shared settings conflict reviews name the primary connection.
- Shared settings refuse a primary connection that is removed or turned off, or whose profile belongs to another provider, with "That connection is no longer available." The setup guide's save resolves its choice from the exact settings it writes and retries once after a concurrent change.
- Requires the coordinator and daemons from the same release: with an older coordinator, installation daemons never receive the primary connection and system threads wait.

## Maintenance review

Primary connection: system threads launch with one owner-chosen connection stored in installation shared settings, with a daemon copy per environment and a standalone daemon setting, advertised as primaryConnectionSetting. The customizations inventory gains no entry yet; README overview and onboarding are unchanged.
