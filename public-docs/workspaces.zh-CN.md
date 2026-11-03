---
title: 工作区
description: 了解 Paseo 如何把工作目录、Agent、终端和浏览器组织成工作区。
nav: 工作区
---

# 工作区 {#workspaces}

Paseo 围绕工作区组织，而不是围绕聊天。

工作区是任务发生的地方。它有一个工作目录，可以同时包含多个正在运行的会话。在应用中，每个会话以一个标签页打开。

## 项目包含工作区 {#projects-contain-workspaces}

侧边栏从项目开始。项目可以是一个 git 仓库、一个 GitHub 项目，或者运行 Paseo daemon 的机器上的任意目录。

每个项目中都有工作区。例如：

```
my-app
├── main
├── fix-login-flow
└── redesign-settings
```

每个工作区都是一个独立的工作场所。你可以为主检出保留一个，为某个功能再创建一个，或者把一个 GitHub PR 作为另一个工作区打开。

使用 [CLI 项目命令](/docs/cli#projects)注册、列出、重命名或删除项目。

## 工作区包含会话 {#workspaces-contain-sessions}

Agent 以会话的形式在工作区中运行。一个工作区可以同时打开一个或多个 Agent 会话，以及终端、浏览器和 diff。

这一点很重要，因为真实的开发很少能装进一段长长的聊天。你可能让一个 Agent 实现某个功能，打开一个终端运行服务，再启动另一个 Agent 审查 diff，同时在旁边开着浏览器。它们都属于同一个任务，所以应该放在一起。

在 Paseo 中，工作区是稳定的容器，会话是你在其中运行的东西。

## 常驻、受保护和已排程 {#standing-protected-and-scheduled}

打开工作区菜单，选择 **Tag As**，然后为持续性职责（例如监督者或定期议事更新）启用 **Standing**。常驻工作区显示在其项目内一个可折叠的分区中。单独置顶的工作区仍保留在 Pinned 中。

选择 Standing 也会启用 **Protected**。受保护的工作区带有锁形标识。保护会阻止归档该工作区或其 Agent 会话，包括批量操作和 daemon 请求。归档前需要显式移除 Protected。关闭 Standing 时保护仍保持启用。你也可以保护普通工作区。

当某个排程指向该工作区中的 Agent 时，会自动显示 **Scheduled**。已暂停的排程保留该徽标；已完成或已过期的排程不会保留。选择徽标即可打开 Schedules。每次运行都创建新工作区的排程，不会把这些产出标记为持续性工作。

Standing 和 Protected 使用锚和锁图标并带有选中状态。自定义标签显示在它们下方的独立分区中，底部为 **Create Label**。Standing、Protected 和 Scheduled 是保留名称，不会出现在自定义标签分区中。在较旧的环境中，内置控件保持可见但处于禁用状态，直到环境更新。已有的自定义分配保留其原名称；仅有旧版 Protected 分配并不会强制归档保护。

Standing 和 Protected 需要更新后的 daemon。当工作区所在环境需要更新时，Tag As 会给出说明。

Protected 和 Scheduled 在工作区标题行右侧使用一致的紧凑图标徽标，自定义标签共享这一行。徽标与 A1/G 计数器同高。悬停时会在最右侧内容上显示一个实心方角的菜单按钮，而不会移动内容；触屏布局会保持固定的菜单目标可见。Scheduled 会打开 Schedules，并在紧凑徽标周围保留完整尺寸的触摸目标。

## 选择隔离方式 {#choose-the-isolation}

每个工作区都有一种隔离模式：

- **本地** 使用一个现有目录，例如你的主检出。当会话应该共享磁盘上已有的文件时使用。
- **新建 worktree** 创建或打开一个受管理的 git worktree。当任务需要自己的目录和分支时使用。

工作区是产品概念；git worktree 是隔离其文件的一种方式。多个工作区可以指向同一个受管理的 worktree，Paseo 会在最后一个引用它的工作区被归档后删除该 worktree。

## 创建工作区 {#creating-a-workspace}

关于从启动并行 Agent 到审查和测试其改动的桌面端完整流程，请参见[运行并行任务](/docs/parallel-development)。

你可以在应用中或通过 CLI 创建工作区：

```bash
paseo workspace create --isolation local --path ~/dev/my-app --title main
paseo workspace create --isolation worktree --path ~/dev/my-app --base origin/main
```

你也可以创建工作区而不立即启动 Agent。工作区及其工作目录依然就绪；你可以打开终端、运行服务或浏览文件，稍后再启动 Agent。

无论哪种方式，工作区创建后都可以向其中添加更多会话。在 Agent 旁边打开一个终端，启动第二个 Agent 审查改动，或打开一个浏览器标签页检查本地服务。每个会话都是同一个工作区中的一个标签页。

创建 Agent 和创建工作区是两个独立的操作。如果你想让 Agent 位于某个已有的工作区，请传入工作区 ID。在人工操作的 shell 中直接运行 `paseo run` 会创建一个新的本地工作区；当某个 Agent 运行它时，Paseo 会识别调用者，并在调用者的工作区中创建一个子 Agent。

## Worktree {#worktrees}

Paseo 中的每个工作区都由一个工作目录支撑。当这个目录是 git worktree 时，每个任务都会获得独立的分支和隔离的环境。

如果想了解配置 setup 钩子、脚本和服务的细节，请继续阅读 [Git worktree](/docs/worktrees)。
