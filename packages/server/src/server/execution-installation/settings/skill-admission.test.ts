import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { MutableDaemonConfigSchema } from "@getpaseo/protocol/messages";
import type { SkillPreview } from "@getpaseo/protocol/skill-library";
import {
  createInstallationSettingsReader,
  InstallationSettingsAdmissionError,
  readInstallationSettingsForLaunch,
  type InstallationSettingsAdmission,
} from "./admission.js";
import { assertInstallationSkillChange } from "./skill-admission.js";
import { readInstallationSettings } from "./projection.js";

test("shared skill changes require current content and provenance and preserve physical packages on removal", () => {
  const source = { repository: "example/skills", revision: "a".repeat(40), directory: "review" };
  const definition = {
    name: "review",
    identity: "github:example/skills/review",
    sha256: "b".repeat(64),
    source,
  };
  const admission: InstallationSettingsAdmission = {
    installationId: "4c07b582-7d41-4be4-9725-36f975708983",
    serverId: "host",
    environment: "host",
    revision: 1,
    installationInstructions: "",
    settings: {
      ...readInstallationSettings(
        MutableDaemonConfigSchema.parse({ mcp: { injectIntoAgents: false } }),
      ),
      skillLibrary: [definition],
    },
  };
  const preview: SkillPreview = {
    id: "preview",
    name: "review",
    action: "install",
    source,
    target: "/local/review",
    beforeHash: null,
    afterHash: definition.sha256,
    changes: [],
    createdAt: "now",
  };
  for (const action of ["install", "restore", "link", "consolidate"] as const)
    expect(() => assertInstallationSkillChange(admission, { ...preview, action })).not.toThrow();
  expect(() =>
    assertInstallationSkillChange(admission, { ...preview, afterHash: "c".repeat(64) }),
  ).toThrow("coordinator");
  expect(() => assertInstallationSkillChange(admission, { ...preview, source: null })).toThrow(
    "coordinator",
  );
  expect(() =>
    assertInstallationSkillChange(admission, { ...preview, action: "remove", afterHash: null }),
  ).toThrow("coordinator");
  admission.settings.resourceExclusions.host = {
    terminalProfileIds: [],
    metadataProviderIds: [],
    skillIdentities: [definition.identity],
  };
  expect(() => assertInstallationSkillChange(admission, preview)).toThrow("coordinator");
  admission.settings.resourceExclusions = {};
  admission.settings.skillLibrary = [];
  expect(() => assertInstallationSkillChange(admission, preview)).toThrow("coordinator");
  delete admission.settings.skillLibrary;
  expect(() => assertInstallationSkillChange(admission, preview)).toThrow("migration");
});

test("new task settings reject another environment and incomplete skill migration", async () => {
  const binding = {
    installationId: "4c07b582-7d41-4be4-9725-36f975708983",
    serverId: "host",
    environment: "host" as const,
    revision: 1,
  };
  const settings = MutableDaemonConfigSchema.parse({
    mcp: { injectIntoAgents: false },
    sharedProviderPreferences: {
      version: 1,
      revision: 1,
      providers: {},
      legacyProfiles: {},
      installation: binding,
    },
  });
  const admission: InstallationSettingsAdmission = {
    ...binding,
    installationInstructions: "",
    settings: { ...readInstallationSettings(settings), skillLibrary: [] },
  };
  await expect(
    readInstallationSettingsForLaunch(settings, {
      read: async () => ({ ...admission, serverId: "other" }),
    }),
  ).rejects.toThrow("different installation or environment");
  delete admission.settings.skillLibrary;
  await expect(
    readInstallationSettingsForLaunch(settings, { read: async () => admission }),
  ).rejects.toThrow("migration");
  admission.settings.skillLibrary = [];
  await expect(
    readInstallationSettingsForLaunch(settings, { read: async () => admission }),
  ).resolves.toEqual(admission);
});

test("a timed-out admission read names the unreachable origin and keeps the cause", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "settings-admission-"));
  const configFile = path.join(dir, "client.json");
  const origin = "https://coordinator.example:8443";
  writeFileSync(configFile, JSON.stringify({ origin, token: "secret-token", kind: "host-agent" }));
  const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
  const fetchAdmission: typeof fetch = async () => {
    throw timeout;
  };
  try {
    const error = await createInstallationSettingsReader(configFile, fetchAdmission)
      .read({
        installationId: "4c07b582-7d41-4be4-9725-36f975708983",
        serverId: "host",
        environment: "host",
        revision: 1,
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InstallationSettingsAdmissionError);
    expect((error as Error).message).toContain(origin);
    expect((error as Error).message).not.toContain("secret-token");
    expect((error as Error).cause).toBe(timeout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.each([
  [
    "the gate route for Dev in gate mode",
    "http://host.docker.internal:6770",
    "container-agent",
    "gate",
    true,
  ],
  [
    "HTTPS outside gate mode",
    "https://host.docker.internal:6770",
    "container-agent",
    undefined,
    true,
  ],
  ["Host loopback", "http://127.0.0.1:6770", "host-agent", undefined, true],
  [
    "the gate route outside gate mode",
    "http://host.docker.internal:6770",
    "container-agent",
    undefined,
    false,
  ],
  [
    "the gate route with a Host token",
    "http://host.docker.internal:6770",
    "host-agent",
    "gate",
    false,
  ],
  ["another plain-HTTP host in gate mode", "http://gate:6770", "container-agent", "gate", false],
  [
    "the gate host without its listen port",
    "http://host.docker.internal",
    "container-agent",
    "gate",
    false,
  ],
  [
    "the gate route with a path",
    "http://host.docker.internal:6770/x",
    "container-agent",
    "gate",
    false,
  ],
])("admission origins: %s", (_case, origin, kind, mode, accepted) => {
  const dir = mkdtempSync(path.join(tmpdir(), "settings-admission-"));
  const configFile = path.join(dir, "client.json");
  writeFileSync(configFile, JSON.stringify({ origin, token: "fixture-only-token", kind }));
  const env = mode ? { PASEO_NETWORK_MODE: mode } : {};
  try {
    const create = () => createInstallationSettingsReader(configFile, fetch, env);
    if (accepted) expect(create).not.toThrow();
    else expect(create).toThrow(InstallationSettingsAdmissionError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
