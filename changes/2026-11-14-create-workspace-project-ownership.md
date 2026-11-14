### Fixes

- Agents that create a local workspace in a folder outside their own project no longer file it under their project. The workspace joins the project that contains the folder, or the folder becomes a new project.

### Improvements

- Agents can pass `newProject: true` to `create_workspace` to register a local folder as its own project.

## Maintenance review

`create_workspace` previously gave every local workspace without `projectId` the caller's project and sidebar membership, even for a folder outside that project. Local ownership now follows the folder: the caller's root, its workspaces and checkouts of its repository keep inheriting; other folders go to the deepest containing project or register a new one through the add project path, including its Projects folder rule, now shared by the session and the tool. Worktree and remote host creation are unchanged. Focused MCP tests cover the four ownership cases and invalid `newProject` combinations. The bundled Paseo skill and agent lifecycle guide describe the rules. README overview and onboarding are unchanged; no merge or installation is included.
