import type { ProviderPreferences } from "@getpaseo/protocol/provider-preferences";
import {
  ExecutionInstallationSchema,
  InstallationProfilesPatchSchema,
  InstallationProfilesSnapshotSchema,
  InstallationUnlockSchema,
  type ExecutionInstallation,
} from "@getpaseo/protocol/execution-installation";
import {
  InstallationSettingsSchema,
  InstallationSettingsSnapshotSchema,
  InstallationSettingsUpdateSchema,
  type InstallationSettings,
} from "@getpaseo/protocol/installation-settings";
import {
  ProviderLoginStateSchema,
  type ProviderLoginState,
} from "@getpaseo/protocol/provider-login";
import type { InstallationProvider } from "@getpaseo/protocol/installation-provider";
import { UpgradeStatusSchema } from "@getpaseo/protocol/installation-upgrades";
import { DEMO_SERVER_ID } from "./scenario";

/**
 * A simulated two-environment installation, "Demo Lab", so the demo shows the installation-wide
 * settings: owner lock, environments, shared providers and their sign-in, skills, plugins and
 * profiles. Everything lives in memory for the page's lifetime. No request leaves the browser;
 * no credential, provider or installation stands behind any of it.
 */
export const DEMO_DEV_SERVER_ID = "vorteo-demo-dev";
const INSTALLATION_ID = "00000000-0000-4000-8000-00000000d3e0";
const HOST_ENDPOINT = "demo-host.invalid:6767";
const DEV_ENDPOINT = "demo-dev.invalid:6767";

/** Each demo daemon's identity, keyed by server ID. */
export const DEMO_SERVERS: Record<string, { hostname: string; primary: boolean }> = {
  [DEMO_SERVER_ID]: { hostname: "Host", primary: true },
  [DEMO_DEV_SERVER_ID]: { hostname: "Dev", primary: false },
};

export function demoInstallation(origin: string): ExecutionInstallation {
  return ExecutionInstallationSchema.parse({
    version: 1,
    installationId: INSTALLATION_ID,
    name: "Demo Lab",
    origin,
    environments: [
      { kind: "host", serverId: DEMO_SERVER_ID, endpoint: HOST_ENDPOINT, useTls: false },
      { kind: "container", serverId: DEMO_DEV_SERVER_ID, endpoint: DEV_ENDPOINT, useTls: false },
    ],
  });
}

// --- Provider connections --------------------------------------------------------------------

type ConnectionState = "connected" | "expired" | "signed-out";

interface DemoConnection {
  definitionId: string;
  /** The daemon's provider ID in both environments. */
  providerId: string;
  providerType: "claude" | "codex" | "opencode";
  label: string;
  email: string | null;
  state: ConnectionState;
  accountSuffix: string;
}

/**
 * Claude has four connections (two working, one expired, one signed out) so "Reconnect expired"
 * appears; Codex has one working connection; OpenCode has a single signed-out connection.
 * Provider IDs match the sample usage in `usage.ts`.
 */
const CONNECTIONS: readonly DemoConnection[] = [
  {
    definitionId: "demo-claude-work",
    providerId: "claude-account-work",
    providerType: "claude",
    label: "Work",
    email: "work@example.com",
    state: "connected",
    accountSuffix: "c01",
  },
  {
    definitionId: "demo-claude-personal",
    providerId: "claude-account-personal",
    providerType: "claude",
    label: "Personal",
    email: "personal@example.com",
    state: "connected",
    accountSuffix: "c02",
  },
  {
    definitionId: "demo-claude-research",
    providerId: "claude-account-research",
    providerType: "claude",
    label: "Research",
    email: "research@example.com",
    state: "expired",
    accountSuffix: "c03",
  },
  {
    definitionId: "demo-claude-archive",
    providerId: "claude-account-archive",
    providerType: "claude",
    label: "Archive",
    email: null,
    state: "signed-out",
    accountSuffix: "c04",
  },
  {
    definitionId: "demo-codex-team",
    providerId: "codex-account-team",
    providerType: "codex",
    label: "Team",
    email: "team@example.com",
    state: "connected",
    accountSuffix: "c05",
  },
  {
    definitionId: "demo-opencode",
    providerId: "opencode",
    providerType: "opencode",
    label: "OpenCode",
    email: null,
    state: "signed-out",
    accountSuffix: "c06",
  },
];

const PROVIDER_NAMES: Record<DemoConnection["providerType"], string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
};

/**
 * Each connection's current sign-in state, shared by the demo coordinator and the demo daemons,
 * so a simulated sign-in shows in provider status and usage too. Lives for the page's lifetime.
 */
const connectionStates = new Map(CONNECTIONS.map((entry) => [entry.definitionId, entry.state]));
const connectionListeners = new Set<() => void>();

function setConnectionState(definitionId: string, state: ConnectionState) {
  if (connectionStates.get(definitionId) === state) return;
  connectionStates.set(definitionId, state);
  for (const listener of connectionListeners) listener();
}

/** Calls `listener` whenever a simulated sign-in or sign-out changes a connection. */
export function onDemoConnectionChange(listener: () => void): () => void {
  connectionListeners.add(listener);
  return () => connectionListeners.delete(listener);
}

/** What a demo daemon reports for its providers: one entry per connection. */
export function demoProviderConnections(): readonly {
  providerId: string;
  providerType: string;
  label: string;
  state: ConnectionState;
  ready: boolean;
  accountId: string | null;
}[] {
  return CONNECTIONS.map((connection) => {
    const state = connectionStates.get(connection.definitionId) ?? connection.state;
    return {
      providerId: connection.providerId,
      providerType: connection.providerType,
      label: `${PROVIDER_NAMES[connection.providerType]} · ${connection.label}`,
      state,
      ready: state === "connected",
      accountId: connection.providerType === "opencode" ? null : accountId(connection),
    };
  });
}

function accountId(connection: DemoConnection): string {
  return `00000000-0000-4000-8000-000000000${connection.accountSuffix}`;
}

function providerDefinition(connection: DemoConnection, order: number): InstallationProvider {
  const bindings = {
    [DEMO_SERVER_ID]: connection.providerId,
    [DEMO_DEV_SERVER_ID]: connection.providerId,
  };
  // Explicitly on: without a choice, only connections the Host reports ready count as on.
  if (connection.providerType === "opencode")
    return {
      id: connection.definitionId,
      providerType: "opencode",
      bindings,
      policy: { order, enabled: true },
    };
  return {
    id: connection.definitionId,
    providerType: connection.providerType,
    accountId: accountId(connection),
    accountSetup: {
      provider: connection.providerType,
      creationId: `00000000-0000-4000-9000-000000000${connection.accountSuffix}`,
      ...(connection.providerType === "claude" ? { signIn: "full" as const } : {}),
    },
    bindings,
    policy: { label: connection.label, order, enabled: true },
  };
}

// --- Shared settings -------------------------------------------------------------------------

/** The bundled orchestration skills both demo environments report as installed. */
const ORCHESTRATION_SKILLS = ["handoff", "orchestrate", "review", "schedule"];

const SKILLS = [
  ["release-notes", "Write release notes from merged changes."],
  ["accessibility-review", "Audit an interface change for keyboard and screen reader use."],
  ["incident-summary", "Summarize an incident for the owner."],
  ["dependency-upgrade", "Upgrade one dependency with its tests."],
  ["design-tokens", "Apply the design tokens to a new component."],
  ["data-migration", "Plan and verify a reversible data migration."],
  ["api-changelog", "Describe a protocol change and its compatibility."],
] as const;

function sha(seed: number): string {
  return seed.toString(16).padStart(2, "0").repeat(32);
}

function createSettings(): InstallationSettings {
  return InstallationSettingsSchema.parse({
    browserTools: { enabled: true },
    providerDefinitions: CONNECTIONS.map(providerDefinition),
    primaryConnection: { providerId: "demo-claude-personal" },
    plugins: [
      "calendar",
      "linear-sync",
      "screenshot-diff",
      "sentry",
      "storybook",
      "figma-tokens",
    ].map((id, index) => ({ id, enabled: index !== 3, source: { kind: "directory" } })),
    skillLibrary: SKILLS.map(([name], index) => ({
      identity: `demo-skill-${name}`,
      name,
      sha256: sha(index + 1),
      source:
        index % 2 === 0
          ? {
              repository: "example/skills",
              revision: sha(index + 40).slice(0, 40),
              directory: `skills/${name}`,
            }
          : null,
    })),
    skills: { selection: { mode: "all" } },
    mcp: { injectIntoAgents: true },
    appendSystemPrompt: "",
    autoArchiveAfterMerge: false,
    enableTerminalAgentHooks: false,
    metadataGeneration: { providers: [{ provider: "claude-account-work" }] },
    pluginsEnabled: true,
    terminalProfiles: [
      { id: "demo-terminal-shell", name: "Shell", command: "zsh" },
      { id: "demo-terminal-claude", name: "Claude Code", command: "claude" },
      { id: "demo-terminal-codex", name: "Codex", command: "codex" },
      {
        id: "demo-terminal-tests",
        name: "Watch tests",
        command: "npm",
        args: ["test", "--", "--watch"],
      },
      {
        id: "demo-terminal-logs",
        name: "Daemon logs",
        command: "tail",
        args: ["-f", "daemon.log"],
      },
      { id: "demo-terminal-python", name: "Python", command: "python3" },
    ],
    // A few exceptions, so the environment dialogs show some turned off.
    resourceExclusions: {
      [DEMO_DEV_SERVER_ID]: {
        browserTools: true,
        pluginIds: ["calendar"],
        skillIdentities: ["demo-skill-incident-summary"],
        terminalProfileIds: ["demo-terminal-logs"],
        metadataProviderIds: [],
      },
    },
    projectPolicies: {},
  });
}

/**
 * Shared profiles by provider type: seven for Claude, more than its card shows before "Show all",
 * and two for Codex.
 */
const PROFILES = {
  claude: ["Builder", "Reviewer", "Designer", "Researcher", "Docs writer", "Planner", "Tester"],
  codex: ["Bug fixer", "Release captain"],
} as const;

function createProfiles(): Record<string, ProviderPreferences> {
  return Object.fromEntries(
    Object.entries(PROFILES).map(([provider, names]) => {
      const workflows = names.map((name) => ({
        id: `demo-profile-${name.toLowerCase().replace(/\s+/g, "-")}`,
        name,
        provider,
      }));
      return [
        provider,
        {
          defaults: {},
          preferredModels: [],
          preferredThinkingOptions: [],
          workflows,
          defaultWorkflowId: workflows[0]!.id,
        },
      ];
    }),
  );
}

// --- Coordinator -----------------------------------------------------------------------------

interface DemoAttempt {
  attemptId: string;
  startedAt: number;
  /** When a Claude code was pasted; Codex verifies on its own after a pause. */
  submittedAt: number | null;
  failed: boolean;
  cancelled: boolean;
}

const STARTING_MS = 900;
const CODEX_WAIT_MS = 5000;
const VERIFYING_MS = 1500;
const DEV_SYNC_MS = 4000;

export interface OwnerSessionStore {
  read(): boolean;
  write(unlocked: boolean): void;
}

/** Keys under `vorteo:demo:` are cleared when the demo resets. */
const OWNER_SESSION_KEY = "vorteo:demo:owner-unlocked";

export interface DemoReply {
  status: number;
  body: unknown;
}

/**
 * The installation coordinator's owner routes, answered in memory. Owner access starts locked
 * and any password unlocks it. Routes the demo does not simulate answer 404, which the
 * interface already treats as a feature this coordinator does not offer.
 */
export class DemoCoordinator {
  private unlocked: boolean;
  private revision = 1;
  private settings = createSettings();
  private name: string | null = "Demo Lab";
  private attempts = new Map<string, DemoAttempt>();
  private attemptOrdinal = 0;
  private profilesRevision = 1;
  private profiles = createProfiles();
  /** When shared settings last changed; Dev applies them a few seconds later. */
  private changedAt: number;

  /**
   * `session` keeps the owner unlocked across page reloads, as a real coordinator's session
   * cookie does. The demo's reset clears it.
   */
  constructor(
    private readonly origin: string,
    private readonly now: () => number = Date.now,
    private readonly session: OwnerSessionStore | null = null,
  ) {
    this.changedAt = now();
    this.unlocked = session?.read() ?? false;
  }

  private setUnlocked(unlocked: boolean) {
    this.unlocked = unlocked;
    this.session?.write(unlocked);
  }

  /** `path` is the part after `/api/installation/`. */
  handle(path: string, method: string, body: unknown): DemoReply {
    if (path === "owner-access" && method === "GET")
      return ok({ sessions: true, passwordFile: null });
    if (path === "owner/session") return ok({ authenticated: this.unlocked, expiresAt: null });
    if (path === "owner/unlock") {
      // Any password works: the demo has nothing to protect.
      this.setUnlocked(true);
      return ok(this.unlockPayload());
    }
    if (!this.unlocked) return { status: 401, body: { error: "Unlock to continue." } };
    if (path === "owner/connections") return ok(this.unlockPayload());
    if (path === "owner/lock") {
      this.setUnlocked(false);
      return ok({});
    }
    if (path === "owner/name") return this.rename(body);
    if (path === "owner/settings/read") return ok(this.snapshot());
    if (path === "owner/settings" && method === "PATCH") return this.save(body);
    if (path === "owner/settings/skills/preview") return ok(this.skillsPreview(body));
    if (path === "owner/upgrades/query") return ok(this.upgradeStatus());
    if (path === "owner/profiles/read") return ok(this.profilesSnapshot());
    // No service maintenance is waiting in the demo.
    if (path === "owner/maintenance-services/query")
      return ok({ installationId: INSTALLATION_ID, available: true, jobs: [] });
    if (path === "owner/profiles" && method === "PATCH") return this.saveProfiles(body);
    const signIn =
      /^owner\/(claude\/oauth|codex\/signin)\/(read|start|submit|cancel|sign-out)$/.exec(path);
    if (signIn)
      return this.signIn(signIn[1] === "codex/signin" ? "codex" : "claude", signIn[2], body);
    return { status: 404, body: { error: "Not available in the demo." } };
  }

  private unlockPayload() {
    const installation = demoInstallation(this.origin);
    return InstallationUnlockSchema.parse({
      installationId: installation.installationId,
      connections: installation.environments.map((environment) =>
        Object.assign({}, environment, { password: "demo" }),
      ),
    });
  }

  private snapshot() {
    // Dev applies each change a few seconds after the Host, so syncing shows and then clears.
    const devPending = this.now() - this.changedAt < DEV_SYNC_MS;
    return InstallationSettingsSnapshotSchema.parse({
      version: 1,
      revision: this.revision,
      settings: this.settings,
      sources: {
        [DEMO_SERVER_ID]: { appliedRevision: this.revision, pendingRevision: null, error: null },
        [DEMO_DEV_SERVER_ID]: devPending
          ? { appliedRevision: this.revision - 1, pendingRevision: this.revision, error: null }
          : { appliedRevision: this.revision, pendingRevision: null, error: null },
      },
    });
  }

  private profilesSnapshot() {
    const source = { error: null, conflicts: [], conflictValues: [] };
    return InstallationProfilesSnapshotSchema.parse({
      version: 1,
      revision: this.profilesRevision,
      sources: { [DEMO_SERVER_ID]: source, [DEMO_DEV_SERVER_ID]: source },
      providers: this.profiles,
    });
  }

  private saveProfiles(body: unknown): DemoReply {
    const patch = InstallationProfilesPatchSchema.parse(body);
    if (patch.expectedRevision !== this.profilesRevision)
      return { status: 409, body: { error: "Profiles changed." } };
    this.profiles = patch.providers;
    this.profilesRevision += 1;
    return ok(this.profilesSnapshot());
  }

  /** Both environments already have every bundled orchestration skill. */
  private skillsPreview(body: unknown) {
    const selection =
      typeof body === "object" && body ? Reflect.get(body, "selection") : { mode: "all" };
    const status = {
      state: "up-to-date",
      ops: [],
      available: ORCHESTRATION_SKILLS,
      installed: ORCHESTRATION_SKILLS,
      selection,
      confirmationRequired: null,
    };
    return { sources: { [DEMO_SERVER_ID]: status, [DEMO_DEV_SERVER_ID]: status } };
  }

  /** One release the update check offered, waiting for the owner's approval. */
  private upgradeStatus() {
    return UpgradeStatusSchema.parse({
      available: true,
      detail: "A new release is ready to install.",
      repository: "example/vorteo",
      current: { sourceCommit: "a".repeat(40), release: "release-26.11.100" },
      container: true,
      upgrades: [
        {
          id: "00000000-0000-4000-8000-0000000000a1",
          revision: "00000000-0000-4000-8000-0000000000a2",
          release: "release-26.11.120",
          sourceCommit: "b".repeat(40),
          previousCommit: "a".repeat(40),
          createdAt: new Date(this.now() - 2 * 60 * 60_000).toISOString(),
          status: "pending",
          detail: "Waiting for your approval.",
          steps: [],
          origin: "update-check",
        },
      ],
    });
  }

  private save(body: unknown): DemoReply {
    const update = InstallationSettingsUpdateSchema.parse(body);
    if (update.expectedRevision !== this.revision)
      return { status: 409, body: { error: "Shared settings changed." } };
    this.settings = InstallationSettingsSchema.parse({ ...this.settings, ...update.settings });
    this.revision += 1;
    this.changedAt = this.now();
    return ok(this.snapshot());
  }

  private rename(body: unknown): DemoReply {
    const raw = typeof body === "object" && body ? Reflect.get(body, "name") : null;
    const name = typeof raw === "string" ? raw.trim() : "";
    if (name.length > 40) return { status: 400, body: { error: "Too long." } };
    this.name = name || null;
    return ok({ name: this.name });
  }

  private signIn(provider: "claude" | "codex", operation: string, body: unknown): DemoReply {
    const definitionId = readString(body, "definitionId");
    // Answering the availability probe with 409 is how a coordinator says it runs Host sign-in.
    const connection = CONNECTIONS.find(
      (entry) => entry.definitionId === definitionId && entry.providerType === provider,
    );
    if (!connection) return { status: 409, body: { error: "Unknown connection." } };
    const id = connection.definitionId;
    if (operation === "start") {
      const attempt: DemoAttempt = {
        attemptId: `demo-attempt-${++this.attemptOrdinal}`,
        startedAt: this.now(),
        submittedAt: null,
        failed: false,
        cancelled: false,
      };
      this.attempts.set(id, attempt);
      return ok(this.login(provider, connection, attempt));
    }
    const attempt = this.attempts.get(id);
    if (operation === "submit" && attempt) {
      attempt.submittedAt = this.now();
      // Pasting "fail" shows the failure path.
      attempt.failed = readString(body, "code")?.trim().toLowerCase() === "fail";
      return ok(this.login(provider, connection, attempt));
    }
    if (operation === "cancel" && attempt) {
      attempt.cancelled = true;
      return ok(this.login(provider, connection, attempt));
    }
    if (operation === "sign-out") {
      setConnectionState(id, "signed-out");
      this.attempts.delete(id);
    }
    const login = attempt ? this.login(provider, connection, attempt) : { status: "idle" as const };
    const state = connectionStates.get(id) ?? "signed-out";
    return ok({
      login,
      connection: {
        signedIn: state !== "signed-out",
        needsSignIn: state === "expired",
        identity: state === "signed-out" ? null : { email: connection.email },
        environments: [DEMO_SERVER_ID, DEMO_DEV_SERVER_ID].map((serverId) => ({
          serverId,
          status: state === "connected" ? "ready" : "disconnected",
        })),
      },
    });
  }

  /** The attempt's state, derived from elapsed time so polling walks the real sequence. */
  private login(
    provider: "claude" | "codex",
    connection: DemoConnection,
    attempt: DemoAttempt,
  ): ProviderLoginState {
    const { attemptId } = attempt;
    const now = this.now();
    if (attempt.cancelled) return { status: "cancelled", attemptId };
    if (now - attempt.startedAt < STARTING_MS) return { status: "starting", attemptId };
    const verifyFrom =
      provider === "codex" ? attempt.startedAt + STARTING_MS + CODEX_WAIT_MS : attempt.submittedAt;
    if (verifyFrom === null || now < verifyFrom)
      return ProviderLoginStateSchema.parse({
        status: "waiting",
        attemptId,
        verificationUrl: "https://example.invalid/demo-sign-in",
        userCode: provider === "codex" ? "DEMO-4821" : "",
        inputRequired: provider === "claude",
        expiresAt: new Date(attempt.startedAt + 10 * 60_000).toISOString(),
      });
    if (now - verifyFrom < VERIFYING_MS) return { status: "verifying", attemptId };
    if (attempt.failed)
      return {
        status: "failed",
        attemptId,
        message: "The sign-in code was not accepted. Start again and paste the new code.",
      };
    setConnectionState(connection.definitionId, "connected");
    return {
      status: "succeeded",
      attemptId,
      accountLabel: connection.email ?? `${connection.label.toLowerCase()}@example.com`,
    };
  }
}

function ok(body: unknown): DemoReply {
  return { status: 200, body };
}

function readString(body: unknown, key: string): string | null {
  const value = typeof body === "object" && body ? Reflect.get(body, key) : null;
  return typeof value === "string" ? value : null;
}

/**
 * Answers `/api/installation/*` requests from the demo coordinator and passes every other
 * request to the browser. Installed only in a demo session, before the app makes requests.
 */
export function installDemoCoordinator(): void {
  const coordinator = new DemoCoordinator(window.location.origin, Date.now, {
    read: () => window.sessionStorage.getItem(OWNER_SESSION_KEY) === "1",
    write: (unlocked) =>
      unlocked
        ? window.sessionStorage.setItem(OWNER_SESSION_KEY, "1")
        : window.sessionStorage.removeItem(OWNER_SESSION_KEY),
  });
  const browserFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
      window.location.origin,
    );
    if (url.origin !== window.location.origin || !url.pathname.startsWith("/api/installation/"))
      return browserFetch(input, init);
    const method = (init?.method ?? "GET").toUpperCase();
    const text = typeof init?.body === "string" ? init.body : "";
    const body: unknown = text ? JSON.parse(text) : {};
    // A short pause, so saving and loading states are visible as they are with a real coordinator.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const reply = coordinator.handle(url.pathname.slice("/api/installation/".length), method, body);
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "Content-Type": "application/json" },
    });
  };
}
