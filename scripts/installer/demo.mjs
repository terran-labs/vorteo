// No installer engine, child processes, network or filesystem writes belong in this module.
import { openSync } from "node:fs";
import { ReadStream } from "node:tty";
import readline from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { createRenderer } from "./progress.mjs";
import { encodeQr, renderTerminal, terminalWidth } from "./qr.mjs";
import { planSteps, STEP_TITLES } from "./flow.mjs";

export async function runDemo({
  ask,
  write = (text) => process.stdout.write(text),
  wait = sleep,
  animationMs = 300_000,
  interactive = Boolean(process.stdout.isTTY) && process.env.TERM !== "dumb",
} = {}) {
  const started = Date.now();
  const line = (text = "") => write(`${text}\n`);
  const question = async (id, text, fallback, valid = () => true) => {
    for (;;) {
      const answer = ask
        ? (await ask(`${text} [${fallback}] `, id, fallback)).trim() || fallback
        : fallback;
      if (!ask) line(`${text} [${fallback}]`);
      if (valid(answer)) return answer;
      line("Please choose one of the listed answers.");
    }
  };
  write(interactive && !process.env.NO_COLOR ? "\u001b[32m" : "");
  line(
    "\n■   ■  ■■■  ■■■■  ■■■■■ ■■■■■  ■■■ \n■   ■ ■   ■ ■   ■   ■   ■     ■   ■\n■   ■ ■   ■ ■■■■    ■   ■■■■  ■   ■\n ■ ■  ■   ■ ■ ■     ■   ■     ■   ■\n  ■    ■■■  ■  ■    ■   ■■■■■  ■■■ \nYOUR MACHINE. YOUR AGENTS. YOUR COMMAND.\n",
  );
  write(interactive && !process.env.NO_COLOR ? "\u001b[0m" : "");
  line("DEMO: every action and result below is simulated. Nothing will be installed or changed.");
  line("Build animation runs for five minutes after approval. Ctrl+C exits at any time.");
  line("\nPrerequisites");
  for (const tool of ["Node.js 24", "Git"]) line(`  ✓ ${tool} ready (simulated)`);
  line("\nPreparing\n  ✓ Fetching the release into ~/vorteo/source (simulated; no download)");
  line("\nQuestions");
  const dev = await question(
    "dev-container",
    "Provision a Dev container where agents work? It needs Docker.",
    "yes",
    (v) => ["yes", "no"].includes(v),
  );
  const name = await question("name", "Installation name?", "Vorteo", (v) => v.length <= 64);
  const projects = await question(
    "projects-folder",
    "Projects folder?",
    "~/dev",
    (v) => v.startsWith("/") || v.startsWith("~/"),
  );
  const remote = await question("remote", "Remote access: tailscale or local?", "tailscale", (v) =>
    ["tailscale", "local"].includes(v),
  );
  line("\nChecking this machine (simulated)");
  for (const tool of [
    "Node.js",
    "Git",
    ...(dev === "yes" ? ["Docker"] : []),
    ...(remote === "tailscale" ? ["Tailscale"] : []),
  ])
    line(`  ✓ ${tool}`);
  const steps = planSteps({ devContainer: dev === "yes", adopt: false, remote });
  line(
    `\nReal installation estimate: ${dev === "yes" ? "15 to 60" : "5 to 20"} minutes after approval. Slow downloads or limited resources can take longer. Demo build time: exactly five minutes.\n`,
  );
  line(
    `\nPlan (simulated)\n  • Create ${name} in ~/vorteo.\n  • Projects folder: ${projects}.\n  • Install the Host daemon and coordinator.\n  • ${dev === "yes" ? "Create Dev behind the network gate." : "Host only."}\n  • Access: ${remote}.\n  • Owner password: ~/vorteo/host/owner-password (not created).`,
  );
  if (
    (await question("proceed", "Proceed with this plan?", "yes", (v) =>
      ["yes", "no"].includes(v),
    )) === "no"
  ) {
    line("Demo canceled. Nothing was changed.");
    return;
  }
  line("\nInstalling (simulated)");
  await animateDemoSteps({ steps, write, interactive, started, animationMs, wait });
  finishDemo({ line, write, name, remote });
}

function finishDemo({ line, write, name, remote }) {
  line(
    `\n✓ ${name} is ready (simulated)\n  Address: ${remote === "tailscale" ? "https://demo.example.invalid" : "http://localhost:6770"}\n  On this machine: http://localhost:6770\n  Owner password: not generated or copied in demo\n  Password file: ~/vorteo/host/owner-password (not created)`,
  );
  if (remote === "tailscale") {
    line("\n  Demo phone QR code (placeholder address, not a running installation):\n");
    const qr = encodeQr("https://demo.example.invalid");
    if (terminalWidth(qr) + 2 <= (process.stdout.columns || 80))
      write(
        renderTerminal(qr)
          .split("\n")
          .map((row) => (row ? `  ${row}` : row))
          .join("\n"),
      );
  }
  line(
    "\n\n  Browser opening is simulated; no browser will open.\n  Sign in with the owner password after a real installation.\n  Commands: vorteo status, vorteo doctor, vorteo open, vorteo update, vorteo repair, vorteo uninstall\n\nDemo complete. Nothing was changed.",
  );
}

async function animateDemoSteps({ steps, write, interactive, started, animationMs, wait }) {
  const renderer = createRenderer({
    write,
    animate: interactive,
    banner: interactive,
    color: interactive && !process.env.NO_COLOR,
    installationStarted: started,
  });
  const interrupt = (signal) => {
    renderer.finish();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  const onInt = () => interrupt("SIGINT");
  const onTerm = () => interrupt("SIGTERM");
  process.once("SIGINT", onInt);
  process.once("SIGTERM", onTerm);
  try {
    const builds = steps.filter((step) => ["dev-images", "release"].includes(step));
    for (const [index, step] of steps.entries()) {
      const message = `${STEP_TITLES[step]} (demo)`;
      renderer.handle(
        JSON.stringify({ step, status: "start", message, index: index + 1, total: steps.length }),
      );
      if (builds.includes(step)) {
        const duration = animationMs / builds.length;
        for (let elapsed = 0; elapsed < duration; elapsed += 1000) {
          renderer.handle(
            JSON.stringify({
              step,
              status: "progress",
              detail: "Simulated build; no commands are running",
              outputBytes: 1,
            }),
          );
          await wait(Math.min(1000, duration - elapsed));
        }
      } else await wait(250);
      renderer.handle(JSON.stringify({ step, status: "done", message }));
    }
  } finally {
    renderer.finish();
    process.removeListener("SIGINT", onInt);
    process.removeListener("SIGTERM", onTerm);
  }
}

export async function demoMain(args) {
  let input;
  let reader;
  try {
    if (
      !args.includes("--yes") &&
      !args.includes("-y") &&
      (!process.env.VORTEO_YES || process.env.VORTEO_YES === "0") &&
      !args.includes("--non-interactive") &&
      !process.env.CLAUDECODE &&
      (!process.env.VORTEO_NON_INTERACTIVE || process.env.VORTEO_NON_INTERACTIVE === "0") &&
      process.stdout.isTTY
    ) {
      input = new ReadStream(openSync("/dev/tty", "r"));
      reader = readline.createInterface({ input, output: process.stdout });
      reader.on("SIGINT", () => process.kill(process.pid, "SIGINT"));
    }
    const ask = (prompt, id, fallback) => {
      const inline = args.find((arg) => arg.startsWith(`--${id}=`));
      const index = args.indexOf(`--${id}`);
      let answer;
      if (inline) answer = inline.slice(id.length + 3) || undefined;
      else if (index !== -1) answer = args[index + 1];
      if (id === "dev-container" && args.includes("--no-dev-container")) answer = "no";
      if (answer !== undefined || !reader) {
        process.stdout.write(`${prompt}${answer ?? fallback}\n`);
        return Promise.resolve(answer ?? fallback);
      }
      return new Promise((resolve, reject) => {
        const closed = () =>
          reject(new Error("Demo canceled: terminal input closed. Nothing was changed."));
        reader.once("close", closed);
        reader.question(prompt, (value) => {
          reader.removeListener("close", closed);
          resolve(value);
        });
      });
    };
    await runDemo({ ask });
  } finally {
    reader?.close();
    input?.destroy();
  }
}
