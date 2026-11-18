### Fixes

- Host release cleanup keeps a set-aside copy beside a recreated job folder whenever anything names that job, because after a crash the copy may hold the real release.

## Maintenance review

From the fresh review of safe release pruning. A leftover `.pruning` copy was deleted when only its job folder was referenced; the copy is now kept when the job is referenced or in use under either name, which can only add keeps. New tests each fail when their check is removed: the recreated job folder, a reference naming the copy directly, an unreadable reference file, the session host check after publishing its receipt, deletion through a release root reached by an ancestor link, and a process listing that reaches a release only through argv and a link. `pathsInListing` is exported for that test. Not installed.
