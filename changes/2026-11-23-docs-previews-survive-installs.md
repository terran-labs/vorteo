### Documentation

- The terminal worker guide, the instance continuity guide and the preview skill now say which restarts keep running previews and which close them, that a supervisor started before keep-terminals support closes terminals on every worker restart, and that worker changes reach a long-lived worker only through a protocol bump (#587).

## Maintenance review

Documentation only; describes the Host install change in the pull request this one is stacked on and the broker states from #358 and #587's broker change. After #617's review, the execution installation guide also says which recoveries adopt kept terminals and which close them, and what a kept, unlinked preview's held port blocks. After #620's review, the preview skill tells agents how to check whether a preview survived and what `unverified` and `withdrawn` mean instead of stating unshipped behavior as current, and the terminal worker guide drops installation-specific state. The skill sends agents to a bare `status` for a stop's recorded cause, because a named status of a stopped preview returns only its state and port. No inventory entry changes. README overview and onboarding are unchanged. Nothing to install.
