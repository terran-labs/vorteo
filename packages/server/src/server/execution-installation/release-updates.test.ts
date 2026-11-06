import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  createUpgradeJournal,
  InstallationUpgrades,
  type UpgradePorts,
} from "./release-upgrades.js";
import {
  createUpdatePolicyStore,
  newestRelease,
  readReleaseNotes,
  ReleaseUpdates,
} from "./release-updates.js";

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "release-updates-"));
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

function release(tag: string, changes: Record<string, unknown> = {}) {
  return {
    tag_name: tag,
    draft: false,
    html_url: `https://github.com/terran-labs/vorteo/releases/tag/${tag}`,
    body: "",
    assets: [{ name: "install.sh", state: "uploaded" }],
    ...changes,
  };
}

/** Upgrades whose steps never run here; only offers and decisions matter. */
function harness(releases: ReturnType<typeof release>[], installedVersion = "26.11.300") {
  const upgrades = new InstallationUpgrades(createUpgradeJournal(directory), {
    now: () => new Date("2026-11-03T12:00:00Z"),
    conflict: () => null,
    currentCommit: () => "a".repeat(40),
    resolveRelease: async () => "b".repeat(40),
  } as unknown as UpgradePorts);
  const updates = new ReleaseUpdates(createUpdatePolicyStore(directory), upgrades, {
    now: () => new Date("2026-11-03T12:00:00Z"),
    listReleases: async () => releases,
    installedVersion: () => installedVersion,
  });
  return { upgrades, updates, releases };
}

test("each channel offers only installable releases above the installed version", () => {
  const releases = [
    release("release-26.11.500-beta"),
    release("release-26.11.400"),
    release("release-26.11.450", { draft: true }),
    release("release-26.11.460", { assets: [] }),
    release("release-26.11.200"),
  ];
  expect(newestRelease(releases, "stable", "26.11.300")?.tag_name).toBe("release-26.11.400");
  expect(newestRelease(releases, "beta", "26.11.300")?.tag_name).toBe("release-26.11.500-beta");
  // A beta installation already on 26.11.500 is not offered its promotion to stable.
  expect(
    newestRelease([release("release-26.11.500")], "beta", "26.11.500")?.tag_name,
  ).toBeUndefined();
});

test("release notes give a summary, the security flag and charter changes", () => {
  const notes = readReleaseNotes(
    release("release-26.11.400", {
      body: [
        "Installations now **update themselves** on their [channel](https://x.test).",
        "",
        "## Security",
        "- Fixes token exposure.",
        "",
        "## Factory charter changes",
        "- Mechanic: reads the update status.",
        "- Builds: drains before restarts.",
      ].join("\n"),
    }),
  );
  expect(notes).toMatchObject({
    summary: "Installations now update themselves on their channel.",
    security: true,
    charterChanges: ["Mechanic: reads the update status.", "Builds: drains before restarts."],
  });
});

test("one offer per release: newer replaces, declined is not offered again", async () => {
  const { upgrades, updates, releases } = harness([release("release-26.11.400")]);
  await updates.check();
  const first = upgrades.active();
  expect(first).toMatchObject({ release: "release-26.11.400", origin: "update-check" });

  releases.unshift(release("release-26.11.500"));
  await updates.check();
  expect(upgrades.list().find((item) => item.id === first!.id)?.status).toBe("cancelled");
  const second = upgrades.active()!;
  expect(second.release).toBe("release-26.11.500");

  upgrades.decide(second.id, second.revision, "reject");
  await updates.check();
  expect(upgrades.active()).toBeNull();
});

test("switching to automatic approves the standing offer to install after current work", async () => {
  const { upgrades, updates } = harness([release("release-26.11.400")]);
  await updates.check();
  expect(upgrades.active()?.status).toBe("pending");
  await updates.changePolicy({ mode: "automatic" });
  await updates.checkAgain();
  expect(upgrades.active()).toMatchObject({
    status: "approved",
    automatic: true,
    restart: "after-work",
  });
});
