### Fixes

- Renew full sign-in subscription accounts when Host use is enabled or Dev delivery is pending, record bounded renewal failure reasons, and request account-bound Host recovery before rejecting expired authentication.

## Maintenance review

Reviewed Host-owned account renewal and managed authentication. Recovery shares the existing writer, preserves exclusions and sign-out generations, and never transfers refresh grants to Dev. README overview and onboarding are unchanged. Live overnight acceptance remains unverified.
