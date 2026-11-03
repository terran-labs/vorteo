import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RestartJob } from "@getpaseo/protocol/execution-installation";
import { afterEach, expect, test, vi } from "vitest";
import {
  delegatedHandler,
  readOwnerDelegation,
  maintenanceDelegationActivation,
  maintenanceDelegationStatus,
  managementDelegationAuthority,
  changeMaintenanceDelegation,
} from "./owner-delegation.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function job(overrides: Partial<RestartJob> = {}): RestartJob {
  return {
    id: "10000000-0000-4000-8000-000000000001",
    revision: "10000000-0000-4000-8000-000000000002",
    target: "host",
    reason: "Routine update",
    requester: "Nova integration",
    requestedBy: "host-agent",
    createdAt: new Date(0).toISOString(),
    expiresAt: new Date(1).toISOString(),
    status: "pending",
    detail: "Waiting",
    ...overrides,
  };
}

const delegation = { delegatedRequesterPrefixes: ["Nova "], graceMinutes: 15 };
const createdAt = Date.parse(job().createdAt);
const minutes = (count: number) => createdAt + count * 60_000;
const handling = { state: "handling", requester: "Nova integration" };
const overdue = { state: "overdue", requester: "Nova integration" };

test("only Host-agent requests with a delegated label are handled by the delegate", () => {
  expect(delegatedHandler(job(), delegation, minutes(1))).toEqual(handling);
  // Requester labels are free text; a Dev agent cannot hide its request from the owner.
  expect(
    delegatedHandler(job({ requestedBy: "container-agent" }), delegation, minutes(1)),
  ).toBeNull();
  expect(delegatedHandler(job({ requester: "Astra worker" }), delegation, minutes(1))).toBeNull();
  expect(delegatedHandler(job({ requester: undefined }), delegation, minutes(1))).toBeNull();
  expect(delegatedHandler(job({ status: "succeeded" }), delegation, minutes(1))).toBeNull();
  expect(
    delegatedHandler(job(), { ...delegation, delegatedRequesterPrefixes: [] }, minutes(1)),
  ).toBeNull();
});

test("an unapproved delegated request prompts the owner again after its grace window", () => {
  expect(delegatedHandler(job(), delegation, minutes(14))).toEqual(handling);
  expect(delegatedHandler(job(), delegation, minutes(15))).toEqual(overdue);
  expect(delegatedHandler(job(), { ...delegation, graceMinutes: 60 }, minutes(59))).toEqual(
    handling,
  );
});

test("an automatic approval or a running request stays handled past the grace window", () => {
  const automaticApproval = {
    policyActivatedAt: new Date(0).toISOString(),
    requestRevision: job().revision,
  };
  expect(
    delegatedHandler(job({ status: "approved", automaticApproval }), delegation, minutes(90)),
  ).toEqual(handling);
  expect(delegatedHandler(job({ status: "running" }), delegation, minutes(90))).toEqual(handling);
  // An owner approval is already decided; it is ordinary queued work, not a delegation.
  expect(delegatedHandler(job({ status: "approved" }), delegation, minutes(1))).toBeNull();
});

test("a source batch is delegated only when every remaining contribution is", () => {
  const contribution = {
    id: "10000000-0000-4000-8000-000000000003",
    update: {
      sourceCommit: "a".repeat(40),
      baseCommit: "b".repeat(40),
      sha256: "c".repeat(64),
      bytes: 1,
    },
    reason: "Update",
    requestedBy: "host-agent" as const,
    requester: "Nova integration",
    createdAt: new Date(0).toISOString(),
    status: "included" as const,
    detail: "Included",
  };
  const batch = (contributions: (typeof contribution)[]) =>
    job({ sourceBatch: { status: "ready", webCommit: "b".repeat(40), contributions } });
  expect(delegatedHandler(batch([contribution]), delegation, minutes(1))).toEqual(handling);
  const other = { ...contribution, requester: "Owner script" };
  expect(delegatedHandler(batch([contribution, other]), delegation, minutes(1))).toBeNull();
  expect(
    delegatedHandler(
      batch([contribution, { ...other, status: "superseded" }]),
      delegation,
      minutes(1),
    ),
  ).toEqual(handling);
});

test("a missing or invalid delegation file delegates nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "owner-delegation-"));
  dirs.push(dir);
  expect(readOwnerDelegation(dir)).toMatchObject({
    delegatedRequesterPrefixes: [],
    hostUpdateServiceRestart: false,
    graceMinutes: 15,
  });
  writeFileSync(
    join(dir, "owner-delegation.json"),
    '{"version":1,"hostUpdateServiceRestart":true}',
  );
  expect(readOwnerDelegation(dir).hostUpdateServiceRestart).toBe(false);
  writeFileSync(join(dir, "owner-delegation.json"), "not json");
  expect(readOwnerDelegation(dir).hostUpdateServiceRestart).toBe(false);
  writeFileSync(
    join(dir, "owner-delegation.json"),
    JSON.stringify({
      version: 1,
      delegatedRequesterPrefixes: ["Nova "],
      hostUpdateServiceRestart: true,
    }),
  );
  expect(readOwnerDelegation(dir)).toMatchObject({
    delegatedRequesterPrefixes: ["Nova "],
    hostUpdateServiceRestart: true,
    graceMinutes: 15,
  });
  writeFileSync(
    join(dir, "owner-delegation.json"),
    JSON.stringify({
      version: 1,
      delegatedRequesterPrefixes: [],
      hostUpdateServiceRestart: false,
      graceMinutes: 61,
    }),
  );
  // The window is capped at an hour; an out-of-range value delegates nothing.
  expect(readOwnerDelegation(dir).graceMinutes).toBe(15);
});

// Protected grants require POSIX ownership and mode semantics. Windows must remain fail-closed.
const posixTest = test.skipIf(process.platform === "win32");

posixTest(
  "maintenance authority requires an explicit protected grant, not a requester label",
  () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "owner-maintenance-")));
    dirs.push(dir);
    const file = join(dir, "owner-delegation.json");
    const grant = {
      version: 1,
      delegatedRequesterPrefixes: ["Nova "],
      hostUpdateServiceRestart: true,
    };
    writeFileSync(file, JSON.stringify(grant), { mode: 0o600 });
    expect(maintenanceDelegationActivation(dir)).toBeNull();
    const activatedAt = "2026-10-28T19:00:00.000Z";
    writeFileSync(file, JSON.stringify({ ...grant, maintenanceApprovedAfter: activatedAt }));
    expect(maintenanceDelegationActivation(dir)).toBe(activatedAt);
    chmodSync(file, 0o666);
    expect(maintenanceDelegationActivation(dir)).toBeNull();
    chmodSync(file, 0o600);
    writeFileSync(file, JSON.stringify({ ...grant, maintenanceApprovedAfter: null }));
    expect(maintenanceDelegationActivation(dir)).toBeNull();
    rmSync(file);
    const target = join(dir, "other.json");
    writeFileSync(target, JSON.stringify({ ...grant, maintenanceApprovedAfter: activatedAt }), {
      mode: 0o600,
    });
    symlinkSync(target, file);
    expect(maintenanceDelegationActivation(dir)).toBeNull();
  },
);

posixTest(
  "owner maintenance changes preserve existing delegation and reject stale revisions",
  () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "owner-maintenance-change-")));
    dirs.push(dir);
    const file = join(dir, "owner-delegation.json");
    const original = {
      version: 1,
      delegatedRequesterPrefixes: ["Nova "],
      hostUpdateServiceRestart: true,
      graceMinutes: 8,
    };
    writeFileSync(file, JSON.stringify(original), { mode: 0o600 });
    const initial = maintenanceDelegationStatus(dir);
    const enabled = changeMaintenanceDelegation(dir, {
      expectedRevision: initial.revision,
      enabled: true,
    });
    expect(enabled.enabled).toBe(true);
    expect(readOwnerDelegation(dir)).toMatchObject(original);
    expect(() =>
      changeMaintenanceDelegation(dir, { expectedRevision: initial.revision, enabled: false }),
    ).toThrow("changed");
    expect(
      changeMaintenanceDelegation(dir, { expectedRevision: enabled.revision, enabled: true }),
    ).toEqual(enabled);
    const disabled = changeMaintenanceDelegation(dir, {
      expectedRevision: enabled.revision,
      enabled: false,
    });
    expect(disabled.enabled).toBe(false);
    expect(maintenanceDelegationActivation(dir)).toBeNull();
    const renewed = changeMaintenanceDelegation(dir, {
      expectedRevision: disabled.revision,
      enabled: true,
    });
    expect(renewed.activatedAt).not.toBe(enabled.activatedAt);
  },
);

posixTest(
  "owner maintenance edits refuse symlinks, unsafe modes and invalid retained state",
  () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "owner-maintenance-edit-")));
    dirs.push(dir);
    const file = join(dir, "owner-delegation.json");
    const target = join(dir, "target.json");
    writeFileSync(
      target,
      JSON.stringify({
        version: 1,
        delegatedRequesterPrefixes: [],
        hostUpdateServiceRestart: false,
      }),
      { mode: 0o600 },
    );
    symlinkSync(target, file);
    expect(() => maintenanceDelegationStatus(dir)).toThrow();
    expect(() =>
      changeMaintenanceDelegation(dir, { expectedRevision: null, enabled: true }),
    ).toThrow();
    rmSync(file);
    writeFileSync(file, "invalid", { mode: 0o600 });
    expect(() =>
      changeMaintenanceDelegation(dir, { expectedRevision: null, enabled: true }),
    ).toThrow();
    rmSync(file);
    chmodSync(dir, 0o777);
    expect(() =>
      changeMaintenanceDelegation(dir, { expectedRevision: null, enabled: true }),
    ).toThrow("directory");
    chmodSync(dir, 0o700);
    expect(
      changeMaintenanceDelegation(dir, { expectedRevision: null, enabled: true }).enabled,
    ).toBe(true);
  },
);

test("maintenance authority fails closed when POSIX owner identity is unavailable", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "owner-maintenance-unknown-")));
  dirs.push(dir);
  const file = join(dir, "owner-delegation.json");
  const bytes = JSON.stringify({
    version: 1,
    delegatedRequesterPrefixes: ["Nova "],
    hostUpdateServiceRestart: true,
    maintenanceApprovedAfter: "2026-10-28T19:00:00.000Z",
  });
  writeFileSync(file, bytes, { mode: 0o600 });
  vi.stubGlobal("process", { ...process, getuid: undefined });
  try {
    expect(maintenanceDelegationActivation(dir)).toBeNull();
    expect(() => maintenanceDelegationStatus(dir)).toThrow("directory is not protected");
    expect(() =>
      changeMaintenanceDelegation(dir, { expectedRevision: null, enabled: true }),
    ).toThrow("directory is not protected");
    expect(readFileSync(file, "utf8")).toBe(bytes);
  } finally {
    vi.unstubAllGlobals();
  }
});

test.skipIf(process.platform !== "win32")(
  "native Windows cannot activate or edit a POSIX-protected maintenance grant",
  () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "owner-maintenance-windows-")));
    dirs.push(dir);
    const file = join(dir, "owner-delegation.json");
    const bytes = JSON.stringify({
      version: 1,
      delegatedRequesterPrefixes: [],
      hostUpdateServiceRestart: false,
      maintenanceApprovedAfter: "2026-10-28T19:00:00.000Z",
    });
    writeFileSync(file, bytes, { mode: 0o600 });
    expect(maintenanceDelegationActivation(dir)).toBeNull();
    expect(() => maintenanceDelegationStatus(dir)).toThrow("directory is not protected");
    expect(() =>
      changeMaintenanceDelegation(dir, { expectedRevision: null, enabled: false }),
    ).toThrow("directory is not protected");
    expect(readFileSync(file, "utf8")).toBe(bytes);
  },
);

const credentials = {
  installationId: "installation-1",
  hostAgentTokenHash: "1".repeat(64),
  containerAgentTokenHash: "2".repeat(64),
  ownerPasswordHash: "$2b$10$owner",
};

posixTest("the full grant implies management and revokes it", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "management-grant-")));
  dirs.push(dir);
  expect(managementDelegationAuthority(dir, credentials)).toBeNull();
  const granted = changeMaintenanceDelegation(dir, { expectedRevision: null, enabled: true });
  const authority = managementDelegationAuthority(dir, credentials);
  expect(authority).toEqual({
    revision: expect.stringMatching(/^[a-f0-9]{64}$/),
    activatedAt: granted.activatedAt,
  });
  // An older client's separate switch is accepted and ignored.
  const ignored = changeMaintenanceDelegation(dir, {
    expectedRevision: granted.revision,
    enabled: true,
    management: false,
  });
  expect(ignored.revision).toBe(granted.revision);
  expect(managementDelegationAuthority(dir, credentials)).toEqual(authority);
  // Rotated credentials invalidate the observed authority revision.
  expect(
    managementDelegationAuthority(dir, { ...credentials, hostAgentTokenHash: "3".repeat(64) })
      ?.revision,
  ).not.toBe(authority?.revision);
  expect(
    managementDelegationAuthority(dir, { ...credentials, ownerPasswordHash: "$2b$10$rotated" })
      ?.revision,
  ).not.toBe(authority?.revision);
  const revoked = changeMaintenanceDelegation(dir, {
    expectedRevision: granted.revision,
    enabled: false,
    management: true,
  });
  expect(revoked.enabled).toBe(false);
  expect(managementDelegationAuthority(dir, credentials)).toBeNull();
  // A later grant has a new epoch, so the earlier authority revision stays invalid.
  changeMaintenanceDelegation(dir, { expectedRevision: revoked.revision, enabled: true });
  const regranted = managementDelegationAuthority(dir, credentials);
  expect(regranted?.revision).toMatch(/^[a-f0-9]{64}$/);
  expect(regranted?.revision).not.toBe(authority?.revision);
});

posixTest("a legacy separate opt-in is read, ignored and never rewritten as granted", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "management-legacy-")));
  dirs.push(dir);
  const file = join(dir, "owner-delegation.json");
  const legacyFile = (managementApprovedAfter: string | null) =>
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        delegatedRequesterPrefixes: [],
        hostUpdateServiceRestart: false,
        maintenanceApprovedAfter: "2026-10-28T19:00:00.000Z",
        maintenanceChangedAt: "2026-10-28T19:00:00.000Z",
        managementApprovedAfter,
      }),
      { mode: 0o600 },
    );
  // A full grant whose owner never opted in to separate management gains it automatically.
  legacyFile(null);
  const implied = managementDelegationAuthority(dir, credentials);
  expect(implied?.activatedAt).toBe("2026-10-28T19:00:00.000Z");
  legacyFile("2026-10-29T19:00:00.000Z");
  const status = maintenanceDelegationStatus(dir);
  expect(status.enabled).toBe(true);
  // The legacy timestamp is not part of the authority, so the revision is unchanged.
  expect(managementDelegationAuthority(dir, credentials)).toEqual(implied);
  changeMaintenanceDelegation(dir, { expectedRevision: status.revision, enabled: false });
  expect(JSON.parse(readFileSync(file, "utf8")).managementApprovedAfter).toBeNull();
  const regrant = changeMaintenanceDelegation(dir, {
    expectedRevision: maintenanceDelegationStatus(dir).revision,
    enabled: true,
    management: true,
  });
  expect(regrant.enabled).toBe(true);
  // An older runtime reading this file after rollback sees no separate opt-in.
  expect(JSON.parse(readFileSync(file, "utf8")).managementApprovedAfter).toBeNull();
  expect(managementDelegationAuthority(dir, credentials)).not.toBeNull();
});

posixTest(
  "grant revocation refuses success when its parent directory cannot be synchronized",
  () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "management-durability-")));
    dirs.push(dir);
    const grant = changeMaintenanceDelegation(dir, { expectedRevision: null, enabled: true });
    const sync = fs.fsyncSync;
    let refuse = true;
    let directorySyncs = 0;
    const spy = vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (fs.fstatSync(fd).isDirectory()) {
        directorySyncs++;
        if (refuse) throw new Error("Directory sync failed");
      }
      sync(fd);
    });
    syncBuiltinESMExports();
    try {
      expect(() =>
        changeMaintenanceDelegation(dir, { expectedRevision: grant.revision, enabled: false }),
      ).toThrow("Directory sync failed");
      expect(managementDelegationAuthority(dir, credentials)).toBeNull();
      const observed = maintenanceDelegationStatus(dir);
      expect(() =>
        changeMaintenanceDelegation(dir, { expectedRevision: observed.revision, enabled: false }),
      ).toThrow("Directory sync failed");
      refuse = false;
      expect(
        changeMaintenanceDelegation(dir, { expectedRevision: observed.revision, enabled: false })
          .enabled,
      ).toBe(false);
      expect(directorySyncs).toBe(3);
    } finally {
      spy.mockRestore();
      syncBuiltinESMExports();
    }
  },
);
