### Fixes

- Restrict Previews thumbnail rendering to one snapshot's own files in a sandboxed browser process, and stop rendering live links, so a published address cannot make the daemon read an internal service into an image.
- Copy snapshot files through descriptors opened without following links, refuse hard-linked files and directories that leave the published tree, and enforce the size limit on bytes actually read.
- Send feedback written in a frame embedded in a live preview only after confirmation on a top-level page that cannot be framed.
- Compare the full origin on Previews posts and compare version ids in constant time.

## Maintenance review

Security corrections to the unreleased Previews gallery from an independent review before installation: one high finding (thumbnail request forgery with the browser sandbox off) and two medium findings (snapshot copy race, clickjacking of the embedded comment frame), plus two hardening items. The guide and inventory describe the new confirmation step, the thumbnail restriction and the skip list as a convenience instead of secret filtering. Tests cover each fix. README overview and onboarding are unchanged.
