import { z } from "zod";
import { CustomDomainChangeSchema } from "@getpaseo/protocol/custom-domain";
import { InstallationTypeChangeSchema } from "@getpaseo/protocol/installation-type";
import { InstallationSettingsSchema } from "@getpaseo/protocol/installation-settings";
import type { QueuedActionDefinition } from "./queued-agent-actions.js";

/** Settings an agent may change: none widens what agents can do or names an account. */
export const ORDINARY_SETTINGS = [
  "autoArchiveAfterMerge",
  "metadataGeneration",
  "terminalProfiles",
] as const;

const OrdinarySettingsRequestSchema = z.strictObject({
  expectedRevision: z.number().int(),
  settings: InstallationSettingsSchema.pick({
    autoArchiveAfterMerge: true,
    metadataGeneration: true,
    terminalProfiles: true,
  })
    .partial()
    .refine((settings) => Object.keys(settings).length > 0, "Name at least one setting"),
});

const NameRequestSchema = z.strictObject({ name: z.string().max(200).nullable() });
const LiveDevRequestSchema = z.strictObject({
  expectedRevision: z.string(),
  mode: z.enum(["live", "reliable"]),
});

/** The owner operations the queued requests call, each exactly as its owner route does. */
export interface InstallationChangePorts {
  name: { read(): string | undefined; write(name: string | null): string | undefined };
  liveDev: {
    status(): Promise<{ mode: string; revision: string }>;
    change(input: unknown): Promise<{ mode: string; revision: string }>;
  };
  installationType: {
    read(): Promise<{ type: string; releaseChannel: string; revision: string }>;
    change(input: unknown): Promise<{ type: string; releaseChannel: string; revision: string }>;
  };
  settings: {
    snapshot(): { revision: number; settings?: Record<string, unknown> | null };
    update(input: {
      expectedRevision: number;
      settings: Record<string, unknown>;
    }): Promise<{ revision: number }>;
  };
  customDomain: {
    status(): Promise<{
      origin: string | null;
      revision: string;
      lastChange: { id: string } | null;
    }>;
    /** `options.id` names the change, as a queued restore does to recognize it later. */
    change(
      input: unknown,
      options?: { id?: string },
    ): Promise<{ origin: string | null; revision: string }>;
    /** True while a change or its coordinator restart has not reported. */
    running(): boolean;
  };
  /** The installation's main address, which every change must leave reachable. */
  publicOrigin: string;
  /** Null when the installation answers its health check at the origin, else the evidence. */
  health(origin: string): Promise<string | null>;
  /** Null when DNS resolves the host and it presents a valid certificate for it, else the evidence. */
  certificate(origin: string): Promise<string | null>;
  /** Waits between reachability checks; tests replace it. */
  sleep(ms: number): Promise<void>;
}

/** How long a change has to leave the installation reachable before it is restored. */
const REACHABILITY_WINDOW_MS = 120_000;
const REACHABILITY_POLL_MS = 5_000;

/** Null once every origin answers within the window, else the last evidence. */
async function reachable(
  ports: InstallationChangePorts,
  origins: string[],
): Promise<string | null> {
  let evidence: string | null = null;
  for (let waited = 0; waited <= REACHABILITY_WINDOW_MS; waited += REACHABILITY_POLL_MS) {
    evidence = null;
    for (const origin of origins) {
      const failure = await ports.health(origin);
      if (failure) {
        evidence = `${origin} did not answer: ${failure}`;
        break;
      }
    }
    if (!evidence) return null;
    await ports.sleep(REACHABILITY_POLL_MS);
  }
  return evidence;
}

export function installationChangeDefinitions(
  ports: InstallationChangePorts,
): QueuedActionDefinition[] {
  return [
    {
      name: "installation-name",
      schema: NameRequestSchema,
      disruption: () => "Renames the installation in the interface. Nothing restarts.",
      capture: async () => ports.name.read() ?? null,
      async apply(request) {
        const { name } = NameRequestSchema.parse(request);
        // An empty name restores the default, as in the owner's route.
        const next = ports.name.write(name?.trim() ? name : null);
        return `Renamed the installation to ${next ?? "the default name"}.`;
      },
      async state(request) {
        const { name } = NameRequestSchema.parse(request);
        const current = ports.name.read() ?? null;
        const wanted = name?.trim() ? name.trim() : null;
        return {
          applied: (current?.trim() ?? null) === wanted,
          revision: "",
          detail: `the name is ${current ?? "the default"}`,
        };
      },
    },
    {
      name: "live-dev",
      schema: LiveDevRequestSchema,
      disruption: (request) =>
        LiveDevRequestSchema.parse(request).mode === "live"
          ? "Serves the interface from the live development server. Open pages reload."
          : "Serves the interface from the published build. Open pages reload.",
      capture: async () => (await ports.liveDev.status()).mode,
      async apply(request) {
        const after = await ports.liveDev.change(LiveDevRequestSchema.parse(request));
        return `Delivery mode is now ${after.mode}.`;
      },
      async state(request) {
        const { mode } = LiveDevRequestSchema.parse(request);
        const current = await ports.liveDev.status();
        return {
          applied: current.mode === mode,
          revision: current.revision,
          detail: `delivery mode is ${current.mode}`,
        };
      },
      reachable: () => reachable(ports, [ports.publicOrigin]),
      async restore(previous, revision) {
        await ports.liveDev.change({ expectedRevision: revision, mode: previous });
      },
    },
    {
      name: "installation-type",
      schema: InstallationTypeChangeSchema,
      disruption: () =>
        "Changes which updates this installation is offered. Nothing restarts and remote access is unaffected.",
      async capture() {
        const { type, releaseChannel } = await ports.installationType.read();
        return { type, releaseChannel };
      },
      async apply(request) {
        const after = await ports.installationType.change(request);
        return `The installation is now ${after.type} on the ${after.releaseChannel} channel.`;
      },
      async state(request) {
        const change = InstallationTypeChangeSchema.parse(request);
        const current = await ports.installationType.read();
        return {
          applied:
            (change.type === undefined || current.type === change.type) &&
            (change.releaseChannel === undefined ||
              current.releaseChannel === change.releaseChannel),
          revision: current.revision,
          detail: `the installation is ${current.type} on the ${current.releaseChannel} channel`,
        };
      },
    },
    {
      name: "installation-settings",
      schema: OrdinarySettingsRequestSchema,
      disruption: (request) =>
        `Changes ${Object.keys(OrdinarySettingsRequestSchema.parse(request).settings).join(", ")}. Nothing restarts.`,
      async capture() {
        const current = ports.settings.snapshot().settings ?? {};
        return Object.fromEntries(ORDINARY_SETTINGS.map((key) => [key, current[key] ?? null]));
      },
      async apply(request) {
        const snapshot = await ports.settings.update(OrdinarySettingsRequestSchema.parse(request));
        return `Settings saved as revision ${snapshot.revision}.`;
      },
      async state(request) {
        const { settings } = OrdinarySettingsRequestSchema.parse(request);
        const snapshot = ports.settings.snapshot();
        const current = snapshot.settings ?? {};
        const differs = Object.keys(settings).filter(
          (key) =>
            JSON.stringify(current[key] ?? null) !==
            JSON.stringify((settings as Record<string, unknown>)[key]),
        );
        return {
          applied: differs.length === 0,
          revision: String(snapshot.revision),
          detail: differs.length
            ? `${differs.join(", ")} differ from the request`
            : "the settings match the request",
        };
      },
    },
    {
      name: "custom-domain",
      schema: CustomDomainChangeSchema,
      disruption: (request) =>
        `Can interrupt remote access: ${
          CustomDomainChangeSchema.parse(request).origin
            ? `moves the custom domain to ${CustomDomainChangeSchema.parse(request).origin}`
            : "removes the custom domain"
        } and restarts the coordinator. It is restored automatically if either address stops answering.`,
      async preflight(request) {
        const { origin } = CustomDomainChangeSchema.parse(request);
        // The main address must answer now, so a failed change always has a way back.
        const main = await ports.health(ports.publicOrigin);
        if (main)
          throw new Error(`the main address ${ports.publicOrigin} does not answer: ${main}`);
        if (origin) {
          const certificate = await ports.certificate(origin);
          if (certificate) throw new Error(certificate);
        }
      },
      capture: async () => (await ports.customDomain.status()).origin,
      async apply(request) {
        const { origin } = CustomDomainChangeSchema.parse(request);
        await ports.customDomain.change(request);
        return `Moving the custom domain to ${origin ?? "none"}; the coordinator restarts.`;
      },
      // The change restarts the coordinator; the next one follows it from the journal.
      settled: async () => !ports.customDomain.running(),
      async state(request) {
        const requested = CustomDomainChangeSchema.parse(request).origin;
        const current = await ports.customDomain.status();
        return {
          // The handoff restores the previous file itself when the coordinator does not answer.
          applied: current.origin === requested,
          revision: current.revision,
          detail: `the custom domain is ${current.origin ?? "none"}`,
          ...(current.lastChange ? { operation: current.lastChange.id } : {}),
        };
      },
      reachable(request) {
        const { origin } = CustomDomainChangeSchema.parse(request);
        return reachable(ports, origin ? [ports.publicOrigin, origin] : [ports.publicOrigin]);
      },
      async restore(previous, revision, operation) {
        await ports.customDomain.change(
          { expectedRevision: revision, origin: previous },
          { id: operation },
        );
      },
    },
  ];
}
