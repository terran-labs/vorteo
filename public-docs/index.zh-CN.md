---
title: 快速上手
description: 安装 Vorteo，随时随地运行编程 Agent。
nav: 快速上手
---

# 快速上手 {#getting-started}

Vorteo 在你的机器上运行 Agent，包含一个受信任的 Host 环境和一个可选的隔离 Dev 容器。安装 fork 版本请参阅[安装指南](https://github.com/terran-labs/vorteo#install)，容器细节见 [Docker 运维](/docs/docker)。安装程序从 fork 源码构建，并配置私有连接。

## 接下来 {#where-next}

- [运行并行任务](/docs/parallel-development)：在桌面应用中使用独立的 worktree、审查 diff 并测试改动。
- [连接](/docs/connectivity)：通过中继或 Tailscale 连接。
- [Docker](/docs/docker)：在容器中运行 daemon 和内置网页界面。
- [工作区](/docs/workspaces)：Paseo 所围绕的项目、工作区和会话模型。
- [Provider](/docs/providers)：什么是 Provider，以及 Paseo 如何封装现有 CLI。
- [编排](/docs/orchestration)：让一个 Agent 把工作委派给其他 Provider 和模型。
- [插件](/docs/plugins)：添加受信任的本地界面、侧边栏操作、daemon 行为和 Composer 附件。
- [CLI 参考](/docs/cli)：所有命令。
- [自托管网页界面](/docs/web-ui)：从你自己的 daemon 提供浏览器应用。
- [GitHub 仓库](https://github.com/getpaseo/paseo)
- [报告问题](https://github.com/getpaseo/paseo/issues)

## 前置条件 {#prerequisites}

Paseo 管理其他 Agent，本身并不附带 Agent。要让它发挥作用，请先自行安装至少一个 Provider CLI，并确认它能使用你的凭据正常工作。完整列表见[支持的 Provider](/docs/supported-providers)。

你还需要安装并认证 [GitHub CLI](https://cli.github.com/)（`gh`）。Paseo 用它实现感知 PR 的 worktree 和一些编排功能。
