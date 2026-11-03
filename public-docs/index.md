---
title: Getting started
description: Install Vorteo and start running coding agents from anywhere.
nav: Getting started
order: 1
category: Getting started
---

# Getting started

Vorteo runs agents on your machines, with a trusted Host environment and an optional isolated Dev container. Follow the [installation guide](https://github.com/terran-labs/vorteo#install) for the fork installer and [Docker operations](/docs/docker) for container details. The installer builds from the fork source and configures private connectivity.

## Where next

- [Run parallel tasks](/docs/parallel-development), use separate worktrees, review diffs, and test changes in the desktop app.
- [Connectivity](/docs/connectivity), connect through the relay or Tailscale.
- [Docker](/docs/docker), run the daemon and bundled web UI in a container.
- [Workspaces](/docs/workspaces), the project, workspace, and session model Vorteo is built around.
- [Providers](/docs/providers), what a provider is and how Vorteo wraps existing CLIs.
- [Orchestration](/docs/orchestration), let one agent delegate work to other providers and models.
- [Plugins](/docs/plugins), add trusted local surfaces, sidebar actions, daemon behavior, and composer attachments.
- [CLI reference](/docs/cli), every command.
- [Self-hosting the web UI](/docs/web-ui), serve the browser app from your own daemon.
- [GitHub repo](https://github.com/getpaseo/paseo)
- [Report an issue](https://github.com/getpaseo/paseo/issues)

## Prerequisites

Vorteo manages other agents, it doesn't ship one. Before it's useful, install at least one provider CLI yourself and make sure it works with your credentials. See [Supported providers](/docs/supported-providers) for the full list.

You'll also want the [GitHub CLI](https://cli.github.com/) (`gh`) installed and authenticated, Vorteo uses it for PR-aware worktrees and a few orchestration features.
