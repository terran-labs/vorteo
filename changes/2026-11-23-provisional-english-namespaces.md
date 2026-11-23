### Maintenance

- The translation coverage test no longer counts the preview status strings, which every locale shows in English on purpose until the owner approves their wording, as untranslated fallbacks. The gallery badges had pushed Spanish and Chinese past the test's 25 percent limit (#586).

## Maintenance review

Touches the upstream translation coverage test: `countMatchingEnglishStrings` skips namespaces listed in `PROVISIONAL_ENGLISH_NAMESPACES`, kept beside the preview strings, so a later upstream edit to that function needs a manual merge. Remove `previewStatus` from the list when its translations land. No shipped behaviour changes, so no inventory entry changes. README overview and onboarding are unchanged.
