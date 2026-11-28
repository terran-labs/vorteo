import { createHash } from "node:crypto";
import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import type { ProviderRuntimeSettings } from "@getpaseo/protocol/provider-config";
import { z } from "zod";

export type FactoryCodexBoundary = "checkout-write" | "no-tool-effects";

/** Fresh, non-secret provenance from the trusted installation registry for one provider opening. */
export interface FactoryManagedCodexAccount {
  providerId: string;
  accountKey: string;
  codexHome: string;
  codexBinary: string;
}

export interface FactoryCodexOpening {
  identity: string;
  home: string;
  binary: string;
  environment: Record<string, string>;
}

function contains(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child !== ".." && !child.startsWith(".." + sep) && !isAbsolute(child);
}

async function canonical(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("Factory Codex requires an absolute native path.");
  return realpath(path);
}

async function verifyNativeCommand(
  command: ProviderRuntimeSettings["command"],
  binary: string,
): Promise<void> {
  if (!command || command.mode === "default") return;
  if (command.mode === "append" && !command.args?.length) return;
  if (
    command.mode === "replace" &&
    command.argv.length === 1 &&
    (await canonical(command.argv[0])) === binary
  )
    return;
  throw new Error("The selected Factory Codex provider has an unverified native command.");
}

async function verifyManagedPaths(home: string, binary: string, cwd: string): Promise<void> {
  const [homeInfo, binaryInfo, checkout] = await Promise.all([
    stat(home),
    stat(binary),
    canonical(cwd),
  ]);
  if (
    !homeInfo.isDirectory() ||
    homeInfo.uid !== process.getuid?.() ||
    (homeInfo.mode & 0o022) !== 0 ||
    !binaryInfo.isFile() ||
    (binaryInfo.mode & 0o022) !== 0 ||
    (binaryInfo.uid !== 0 && binaryInfo.uid !== process.getuid?.())
  ) {
    throw new Error("The selected Factory Codex provider has unverified native paths.");
  }
  if (contains(home, checkout) || contains(checkout, home) || contains(checkout, binary)) {
    throw new Error("Factory requires a native Codex home and binary outside the runner checkout.");
  }
  await access(binary, constants.X_OK);
}

export async function openManagedFactoryCodex(input: {
  account: FactoryManagedCodexAccount | null | undefined;
  providerId: string;
  runtime: ProviderRuntimeSettings | undefined;
  cwd: string;
  previous?: { identity: unknown };
}): Promise<FactoryCodexOpening> {
  const { account, providerId, runtime, cwd, previous } = input;
  if (!account?.accountKey || account.providerId !== providerId) {
    throw new Error("The selected Factory Codex provider has no verified managed account.");
  }
  const { codexHome, codexBinary, accountKey } = account;
  const configuredHome = runtime?.env?.CODEX_HOME;
  if (!configuredHome || runtime?.env?.OPENAI_BASE_URL?.trim()) {
    throw new Error(
      "Factory Codex requires an explicit managed home and the native OpenAI provider.",
    );
  }
  const [home, binary, providerHome] = await Promise.all([
    canonical(codexHome),
    canonical(codexBinary),
    canonical(configuredHome),
  ]);
  if (home !== providerHome)
    throw new Error("The selected Factory Codex home differs from its provider binding.");
  const identity = createHash("sha256")
    .update(JSON.stringify([providerId, accountKey, home, binary]))
    .digest("hex");
  if (previous && previous.identity !== identity) {
    throw new Error("The selected Factory Codex account changed before resume.");
  }
  await verifyNativeCommand(runtime?.command, binary);
  await verifyManagedPaths(home, binary, cwd);
  return {
    identity,
    home,
    binary,
    environment: { HOME: home, CODEX_HOME: home, PATH: "/usr/bin:/bin", SHELL: "/bin/sh" },
  };
}

const commonDisabled = [
  "apps",
  "plugins",
  "plugin_sharing",
  "remote_plugin",
  "recommended_plugins",
  "tool_suggest",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "in_app_browser",
  "computer_use",
  "hooks",
  "shell_snapshot",
  "goals",
  "multi_agent",
  "multi_agent_v2",
  "skill_search",
  "skill_mcp_dependency_install",
  "default_mode_request_user_input",
] as const;

function disabled(boundary: FactoryCodexBoundary): readonly string[] {
  return boundary === "checkout-write"
    ? commonDisabled
    : [...commonDisabled, "shell_tool", "unified_exec", "view_image"];
}

const shellPolicy = { inherit: "none", set: { PATH: "/usr/bin:/bin" } } as const;
const codexConfig = z.object({
  config: z.object({
    features: z.record(z.string(), z.unknown()),
    mcp_servers: z.record(z.string(), z.unknown()),
    plugins: z.record(z.string(), z.unknown()),
    notify: z.null().optional(),
    allow_login_shell: z.literal(false),
    web_search: z.literal("disabled"),
    model_provider: z.string(),
    openai_base_url: z.null().optional(),
    chatgpt_base_url: z.union([z.literal("https://chatgpt.com/backend-api/"), z.null()]).optional(),
    shell_environment_policy: z.object({
      inherit: z.literal(shellPolicy.inherit),
      set: z.strictObject({ PATH: z.literal(shellPolicy.set.PATH) }),
      experimental_use_profile: z.union([z.literal(false), z.null()]).optional(),
    }),
  }),
});

export function factoryCodexConfig(boundary: FactoryCodexBoundary): Record<string, unknown> {
  return {
    features: Object.fromEntries(disabled(boundary).map((feature) => [feature, false])),
    mcp_servers: {},
    plugins: {},
    allow_login_shell: false,
    shell_environment_policy: shellPolicy,
    web_search: "disabled",
  };
}

export function factoryCodexArgs(boundary: FactoryCodexBoundary): string[] {
  return [
    ...disabled(boundary).flatMap((feature) => ["--disable", feature]),
    "-c",
    "mcp_servers={}",
    "-c",
    "plugins={}",
    "-c",
    "allow_login_shell=false",
    "-c",
    'shell_environment_policy.inherit="none"',
    "-c",
    'shell_environment_policy.set={PATH="/usr/bin:/bin"}',
    "-c",
    'web_search="disabled"',
    "-c",
    'model_provider="openai"',
  ];
}

export async function verifyFactoryCodexConfig(
  boundary: FactoryCodexBoundary,
  cwd: string,
  result: unknown,
  modelProvider = "openai",
): Promise<void> {
  const parsed = codexConfig.safeParse(result);
  const config = parsed.success ? parsed.data.config : null;
  if (
    process.platform !== "darwin" ||
    !isAbsolute(cwd) ||
    (await realpath(cwd)) !== cwd ||
    !config ||
    config.model_provider !== modelProvider ||
    Object.keys(config.mcp_servers).length ||
    Object.keys(config.plugins).length ||
    disabled(boundary).some((feature) => config.features[feature] !== false)
  )
    throw new Error("Codex did not verify the Factory tool and shell boundary.");
}

export function factoryCodexThread(boundary: FactoryCodexBoundary, cwd: string) {
  return {
    cwd,
    runtimeWorkspaceRoots: [cwd],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: boundary === "checkout-write" ? "workspace-write" : "read-only",
    config: {
      ...factoryCodexConfig(boundary),
      ...(boundary === "checkout-write"
        ? {
            sandbox_workspace_write: {
              writable_roots: [],
              network_access: false,
              exclude_slash_tmp: true,
              exclude_tmpdir_env_var: true,
            },
          }
        : {}),
    },
  };
}

export function factoryCodexTurn(boundary: FactoryCodexBoundary, cwd: string) {
  const thread = factoryCodexThread(boundary, cwd);
  return {
    cwd,
    approvalPolicy: thread.approvalPolicy,
    approvalsReviewer: thread.approvalsReviewer,
    config: thread.config,
    sandboxPolicy:
      boundary === "checkout-write"
        ? {
            type: "workspaceWrite",
            writableRoots: [cwd],
            networkAccess: false,
            excludeSlashTmp: true,
            excludeTmpdirEnvVar: true,
          }
        : { type: "readOnly", networkAccess: false },
  };
}

const thread = z.object({
  approvalPolicy: z.literal("never"),
  approvalsReviewer: z.literal("user"),
  cwd: z.string(),
  runtimeWorkspaceRoots: z.tuple([z.string()]),
  thread: z.object({ id: z.string().min(1) }),
  sandbox: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("readOnly"), networkAccess: z.literal(false) }),
    z.strictObject({
      type: z.literal("workspaceWrite"),
      writableRoots: z.array(z.never()).max(0),
      networkAccess: z.literal(false),
      excludeSlashTmp: z.literal(true),
      excludeTmpdirEnvVar: z.literal(true),
    }),
  ]),
});

export function verifyFactoryCodexThread(
  boundary: FactoryCodexBoundary,
  cwd: string,
  result: unknown,
  expectedThread?: string,
): string {
  const parsed = thread.safeParse(result);
  const scope = boundary === "checkout-write" ? "workspaceWrite" : "readOnly";
  if (
    !parsed.success ||
    parsed.data.cwd !== cwd ||
    parsed.data.runtimeWorkspaceRoots[0] !== cwd ||
    parsed.data.sandbox.type !== scope ||
    (expectedThread && parsed.data.thread.id !== expectedThread)
  )
    throw new Error("Codex did not verify the Factory thread sandbox.");
  return parsed.data.thread.id;
}
