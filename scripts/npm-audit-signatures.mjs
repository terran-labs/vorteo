#!/usr/bin/env node
// Runs the CI dependency signature audit and retries only a transient registry fault.
//
//   node scripts/npm-audit-signatures.mjs
//
// npm's attestations endpoint sometimes answers with a non-JSON body, which npm reports as
// FETCH_ERROR "invalid json response body" before verifying anything (#646). That fault, and
// other network errors fetching from the registry, are retried up to three attempts with a
// short backoff. A failed verification is never retried: npm reports it as an invalid or
// missing signature or attestation, and the step fails on that first report. Any other failure
// also fails at once. See docs/development.md#dependency-signature-audit.
//
// Every attempt audits with a fresh, empty npm cache. npm caches attestation responses for a
// year and CI restores ~/.npm between runs, so a cached bad body would fail every attempt, and a
// restored cache is not something a signature check should trust.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { isMainModule } from "./is-main-module.mjs";

// npm 10 rejects valid keyless provenance; keep all verification on npm 11.
export const AUDIT_COMMAND = ["npx", "--yes", "npm@11.19.1", "audit", "signatures"];
export const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [5_000, 15_000];

// npm's verification report (lib/utils/verify-signatures.js in npm 11). Any of these means a
// package failed verification, whatever else the output says.
const VERIFICATION_FAILURE = [
  /\binvalid registry signatures?\b/i,
  /\binvalid attestations?\b/i,
  /\bmissing registry signatures?\b/i,
  /might have tampered with/i,
];

// A request to the registry failed or answered with something npm could not parse.
const TRANSIENT_CODES = new Set([
  "FETCH_ERROR",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "E429",
  "E500",
  "E502",
  "E503",
  "E504",
]);

function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

/**
 * What one audit attempt means: "passed", "transient" (retry), or "failed" (stop now).
 * Decided from the output, not the exit code alone, since both faults exit 1.
 */
export function classifyAuditAttempt(output, exitCode) {
  const text = stripAnsi(output);
  if (VERIFICATION_FAILURE.some((pattern) => pattern.test(text))) return "failed";
  if (exitCode === 0) return "passed";
  const code = /^npm error code (\S+)/m.exec(text)?.[1];
  if (code && TRANSIENT_CODES.has(code)) return "transient";
  if (/invalid json response body at https:\/\/registry\.npmjs\.org\//.test(text))
    return "transient";
  return "failed";
}

/**
 * Runs the audit until it passes, fails verification, or the transient fault persists past
 * `attempts`. Resolves to the exit code the step should end with.
 */
export async function runAuditWithRetry({
  runAttempt,
  attempts = MAX_ATTEMPTS,
  backoffMs = BACKOFF_MS,
  wait = sleep,
  log = (line) => console.error(line),
}) {
  for (let attempt = 1; ; attempt++) {
    const { output, exitCode } = await runAttempt();
    const outcome = classifyAuditAttempt(output, exitCode);
    if (outcome === "passed") return 0;
    if (outcome === "failed") return exitCode === 0 ? 1 : exitCode;
    if (attempt >= attempts) {
      log(`[audit-signatures] Registry fetch still failing after ${attempts} attempts.`);
      return exitCode === 0 ? 1 : exitCode;
    }
    const delay = backoffMs[Math.min(attempt - 1, backoffMs.length - 1)] ?? 0;
    log(
      `[audit-signatures] Transient registry fetch error on attempt ${attempt} of ${attempts}; retrying in ${delay / 1000}s.`,
    );
    await wait(delay);
  }
}

/**
 * One audit attempt in a fresh, empty npm cache, removed afterwards, so every attestation and
 * signature is fetched from the registry.
 */
export async function auditInFreshCache(run = runAudit) {
  const cache = await mkdtemp(path.join(tmpdir(), "npm-audit-cache-"));
  try {
    return await run(["--cache", cache]);
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
}

/** Runs the audit, passing its output through to the CI log and capturing it for the decision. */
function runAudit(extraArgs) {
  return new Promise((resolve, reject) => {
    const [command, ...args] = AUDIT_COMMAND;
    const child = spawn(command, [...args, ...extraArgs], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      output += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ output, exitCode: code ?? 1 }));
  });
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await runAuditWithRetry({ runAttempt: () => auditInFreshCache() });
}
