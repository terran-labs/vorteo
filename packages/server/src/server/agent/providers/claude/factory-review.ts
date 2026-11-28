import { execFile } from "node:child_process";
import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type {
  HookCallback,
  Options,
  Query,
  SDKSystemMessage,
} from "@anthropic-ai/claude-agent-sdk";

export const factoryReviewTools = ["Read", "Grep", "Glob"] as const;
const tools = new Set<string>(factoryReviewTools);
const refusal = "The Factory Reviewer can only read and search its pinned checkout.";
const forbidden = new Set([".git", ".claude"]);
const execute = promisify(execFile);

export async function verifyFactoryReviewCheckout(root: string | undefined, head: string) {
  if (
    !root ||
    !isAbsolute(root) ||
    (await realpath(root)) !== root ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(head)
  ) {
    throw new Error("The Factory Reviewer requires a physical checkout pinned to a commit.");
  }
  async function git(args: string[]) {
    const result = await execute(
      "/usr/bin/git",
      [
        "--no-replace-objects",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      {
        cwd: root,
        env: {
          PATH: "/usr/bin:/bin",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_NO_LAZY_FETCH: "1",
          GIT_OPTIONAL_LOCKS: "0",
        },
        timeout: 5_000,
      },
    );
    return result.stdout.trim();
  }
  const [checkout, actualHead, branch, status] = await Promise.all([
    git(["rev-parse", "--show-toplevel"]),
    git(["rev-parse", "--verify", "HEAD^{commit}"]),
    git(["branch", "--show-current"]),
    git(["status", "--porcelain", "--untracked-files=all", "--ignored=matching"]),
  ]);
  if (checkout !== root || actualHead !== head || branch || status) {
    throw new Error("The Factory Reviewer checkout is dirty, attached, or at a different commit.");
  }
}

function within(root: string, path: string): boolean {
  const child = relative(root, path);
  return (
    child !== ".." &&
    !child.startsWith(".." + sep) &&
    !isAbsolute(child) &&
    child.split(sep).every((part) => !forbidden.has(part.toLowerCase()))
  );
}

function safeSearchPattern(pattern: unknown): boolean {
  return (
    typeof pattern === "string" &&
    !isAbsolute(pattern) &&
    !pattern.startsWith("~") &&
    !/[{}\\]/u.test(pattern) &&
    !pattern.includes("\0") &&
    !pattern.split("/").includes("..")
  );
}

function validSearchOptions(name: string, fields: Record<string, unknown>): boolean {
  if (name === "Glob") return safeSearchPattern(fields.pattern);
  if (name === "Grep" && fields.glob !== undefined) return safeSearchPattern(fields.glob);
  return true;
}

async function regularSearchTree(directory: string): Promise<boolean> {
  const pending = [directory];
  let checked = 0;
  while (pending.length) {
    const path = pending.pop();
    if (!path) return false;
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (++checked > 50_000 || entry.isSymbolicLink()) return false;
      if (forbidden.has(entry.name.toLowerCase())) continue;
      if (entry.isDirectory()) pending.push(resolve(path, entry.name));
      else if (!entry.isFile()) return false;
    }
  }
  return true;
}

export async function verifyFactoryReviewHandshake(
  query: Pick<Query, "initializationResult" | "setPermissionMode">,
): Promise<void> {
  const info = await query.initializationResult();
  if (info.hooks_applied !== true)
    throw new Error("Claude did not verify the Factory Reviewer tool guard.");
  await query.setPermissionMode("plan");
}

/** Checked by the SDK hook even for operations that the provider preapproves in Plan mode. */
export async function permitsFactoryReviewTool(
  root: string,
  name: string,
  input: unknown,
): Promise<boolean> {
  if (!tools.has(name) || !input || typeof input !== "object") return false;
  const fields: Record<string, unknown> = { ...input };
  const path = name === "Read" ? fields.file_path : (fields.path ?? root);
  if (typeof path !== "string" || !path || path.startsWith("~") || path.includes("\0"))
    return false;
  if (!validSearchOptions(name, fields)) return false;
  try {
    const candidate = resolve(root, path);
    if (!within(root, candidate) || (await realpath(candidate)) !== candidate) return false;
    const stat = await lstat(candidate);
    if (stat.isFile()) return name !== "Glob";
    return name !== "Read" && stat.isDirectory() && (await regularSearchTree(candidate));
  } catch {
    return false;
  }
}

/** No profile, project, or global tool configuration enters a Factory review query. */
export async function factoryReviewOptions(base: Options, systemPrompt: string): Promise<Options> {
  const root = base.cwd;
  if (!root || !isAbsolute(root) || (await realpath(root)) !== root)
    throw new Error("The Factory Reviewer checkout is not a physical directory.");
  const preTool: HookCallback = async (event) => {
    if (
      event.hook_event_name === "PreToolUse" &&
      (await permitsFactoryReviewTool(root, event.tool_name, event.tool_input))
    )
      return {};
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: refusal,
      },
    };
  };
  return {
    cwd: root,
    pathToClaudeCodeExecutable: base.pathToClaudeCodeExecutable,
    env: { ...base.env, ENABLE_CLAUDEAI_MCP_SERVERS: "false" },
    model: base.model,
    thinking: base.thinking,
    effort: base.effort,
    stderr: base.stderr,
    persistSession: base.persistSession,
    sessionId: base.sessionId,
    resume: base.resume,
    includePartialMessages: true,
    systemPrompt,
    permissionMode: "plan",
    allowDangerouslySkipPermissions: false,
    tools: [...factoryReviewTools],
    mcpServers: {},
    strictMcpConfig: true,
    plugins: [],
    skills: [],
    settingSources: [],
    settings: {},
    enableFileCheckpointing: false,
    hooks: { PreToolUse: [{ hooks: [preTool] }] },
    async canUseTool(name, input) {
      return (await permitsFactoryReviewTool(root, name, input))
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: refusal };
    },
  };
}

export function verifyFactoryReviewInit(message: SDKSystemMessage, cwd: string | undefined): void {
  if (
    message.cwd !== cwd ||
    message.permissionMode !== "plan" ||
    message.tools.length !== tools.size ||
    new Set(message.tools).size !== tools.size ||
    !message.tools.every((name) => tools.has(name)) ||
    message.mcp_servers.length > 0
  )
    throw new Error("Claude reported a different Factory Reviewer mode, checkout, or tool set.");
}
