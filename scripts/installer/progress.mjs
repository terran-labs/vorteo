// Renders the installer engine's JSON-line events as tidy progress for install.sh and the
// `vorteo` command. Reads events on stdin:
//   {"step":"…","status":"start"|"done"|"skip"|"fail","message":"…","fix":"…"}
//   {"result":{"origin":"…","localOrigin":"…","passwordFile":"…","name":"…"}}
// Lines that are not JSON are shown as they are, indented.
//
// Usage: engine … | node scripts/installer/progress.mjs [--result <file>]
// Exit status: 0 when the stream ended with a result (or with no failure when no result is
// expected, see --no-result), 1 after a failed step, 2 when the stream ended early.
import { writeFileSync } from "node:fs";
import readline from "node:readline";
import { stripVTControlCharacters } from "node:util";
import { colliderFrame } from "./banner.mjs";
import { isMainModule } from "../is-main-module.mjs";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function paint(enabled, code, text) {
  return enabled ? `\u001b[${code}m${text}\u001b[0m` : text;
}

/**
 * Turns events into output lines. `write` receives finished text; with `animate` the
 * current step shows a spinner on its own line that is replaced when the step ends.
 */
export function createRenderer({
  write,
  animate = false,
  color = false,
  intervalMs = 1000,
  banner = false,
  installationStarted = Date.now(),
  rows = () => process.stdout.rows || 24,
  columns = () => process.stdout.columns || 120,
}) {
  let active = null;
  let showBanner = false;
  let alternateScreen = false;
  const animationStarted = Date.now();
  let frame = 0;
  let timer = null;
  let started = 0;
  let lastOutput = null;
  let detail = "";
  let counter = "";
  let draw = null;
  const duration = (ms) => {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  };
  const status = () => {
    const quiet =
      lastOutput === null
        ? "waiting for output"
        : `last output ${duration(Date.now() - lastOutput)} ago`;
    return `${counter}${duration(Date.now() - started)} elapsed | Total ${duration(Date.now() - installationStarted)} | ${active} | ${
      detail || quiet
    }${detail ? `; ${quiet}` : ""}`;
  };
  const state = { failed: null, result: null };

  const clearFrame = () => {
    if (!alternateScreen) return;
    write("\u001b[?1049l");
    alternateScreen = false;
  };
  const clearSpinner = () => {
    if (timer) clearInterval(timer);
    timer = null;
    if (active && animate) {
      if (alternateScreen) clearFrame();
      else write("\r\u001b[K");
    }
    active = null;
  };
  const line = (text) => {
    clearSpinner();
    write(`${text}\n`);
  };

  const label = (event) => event.message || event.step || "Working";
  const handlers = {
    start(event) {
      clearSpinner();
      active = label(event);
      showBanner = banner && ["dev-images", "release"].includes(event.step);
      counter = event.index ? `[${event.index}/${event.total}] ` : "";
      started = Date.now();
      lastOutput = null;
      detail = "";
      draw = () => {
        if (animate) {
          // Stay on one physical line so carriage return never leaves wrapped debris.
          const width = Math.max(1, columns() - 1);
          const elapsed = `${counter}${duration(Date.now() - started)} elapsed`;
          const activity = detail || active;
          const quiet =
            lastOutput === null ? "" : ` | output ${duration(Date.now() - lastOutput)} ago`;
          const compact = `${elapsed} | ${activity}${quiet}`;
          const text = `  ${SPINNER[frame++ % SPINNER.length]} ${width < 100 ? compact : status()}`;
          if (showBanner) {
            const art = colliderFrame({
              seconds: (Date.now() - animationStarted) / 1000,
              columns: columns(),
              rows: rows(),
              color,
            });
            const total = duration(Date.now() - installationStarted);
            const phase = duration(Date.now() - started);
            const timing =
              width < 100
                ? `Total ${total} | Phase ${phase}`
                : `Total elapsed ${total} | Phase elapsed ${phase}`;
            const statusLines = [
              `${SPINNER[(frame - 1) % SPINNER.length]} ${counter}${active}`.slice(0, width),
              `${timing}${detail ? ` | ${detail}` : ""}${quiet}`.slice(0, width),
            ].slice(0, Math.max(1, rows()));
            // Recompute margins every frame; small terminals retain just status.
            const content = [...art, ...(art.length ? [""] : []), ...statusLines];
            const top = art.length ? Math.max(0, Math.floor((rows() - content.length) / 2)) : 0;
            const lines = [
              ...Array(top).fill(""),
              ...content.map((frameLine) => {
                const cells = [...stripVTControlCharacters(frameLine)].length;
                const left = art.length ? Math.max(0, Math.floor((columns() - cells) / 2)) : 0;
                return " ".repeat(left) + frameLine;
              }),
            ];
            if (!alternateScreen) {
              write("\u001b[?1049h");
              alternateScreen = true;
            }
            // A dedicated build surface keeps terminal reflow away from prior logs.
            write("\u001b[H" + lines.join("\u001b[K\r\n") + "\u001b[K\u001b[J");
          } else {
            write(`\r${text.slice(0, width)}\u001b[K`);
          }
        } else {
          write(`  … ${status()}\n`);
        }
      };
      if (animate) draw();
      else write(`  ${paint(color, 2, "…")} ${active}\n`);
      const animatedInterval = showBanner ? 150 : intervalMs;
      timer = setInterval(draw, animate ? animatedInterval : 15000);
      timer.unref?.();
    },
    progress(event) {
      if (!active) return;
      if (event.outputBytes > 0) lastOutput = Date.now();
      if (event.detail) detail = event.detail;
      if (animate) draw();
    },
    done(event) {
      line(`  ${paint(color, 32, "✓")} ${label(event)}`);
      if (event.fix) line(`    ${paint(color, 1, "Note:")} ${event.fix}`);
    },
    skip(event) {
      // The engine skips steps that are already done on a rerun or do not apply.
      line(`  ${paint(color, 2, "·")} ${label(event)} ${paint(color, 2, "(skipped)")}`);
    },
    fail(event) {
      line(`  ${paint(color, 31, "✗")} ${label(event)}`);
      if (event.fix) line(`    ${paint(color, 1, "Fix:")} ${event.fix}`);
      state.failed = event;
    },
  };

  return {
    state,
    handle(rawLine) {
      const text = rawLine.trimEnd();
      if (!text) return;
      let event;
      try {
        event = JSON.parse(text);
      } catch {
        line(`    ${paint(color, 2, text)}`);
        return;
      }
      if (!event || typeof event !== "object") {
        line(`    ${paint(color, 2, text)}`);
      } else if (event.result) {
        clearSpinner();
        state.result = event.result;
      } else if (handlers[event.status]) {
        handlers[event.status](event);
      } else if (event.message) {
        line(`    ${event.message}`);
      }
    },
    finish() {
      clearSpinner();
      return state;
    },
  };
}

export function exitStatus(state, { expectResult = true } = {}) {
  if (state.failed) return 1;
  if (expectResult && !state.result) return 2;
  return 0;
}

async function main(argv) {
  const resultIndex = argv.indexOf("--result");
  const resultFile = resultIndex === -1 ? null : argv[resultIndex + 1];
  const expectResult = !argv.includes("--no-result");
  const interactive = Boolean(process.stdout.isTTY) && process.env.TERM !== "dumb";
  const renderer = createRenderer({
    write: (text) => process.stdout.write(text),
    animate: interactive,
    banner: interactive,
    installationStarted: Number(process.env.VORTEO_INSTALL_STARTED_MS) || Date.now(),
    color: interactive && !process.env.NO_COLOR,
  });
  const interrupted = (signal) => {
    renderer.finish();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const rawLine of input) renderer.handle(rawLine);
  } finally {
    renderer.finish();
    process.removeListener("SIGINT", interrupted);
    process.removeListener("SIGTERM", interrupted);
  }
  const state = renderer.state;
  if (resultFile && state.result) {
    writeFileSync(resultFile, `${JSON.stringify(state.result)}\n`, { mode: 0o600 });
  }
  return exitStatus(state, { expectResult });
}

if (isMainModule(import.meta.url, process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
