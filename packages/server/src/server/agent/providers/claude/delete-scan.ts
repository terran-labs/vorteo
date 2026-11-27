/**
 * Does a shell command visibly delete anything? Used only to decide whether Vorteo may answer
 * Claude Code's dangerous-removal prompt by itself in Bypass mode (#659, part B). It catches an
 * accident, not a hostile agent: anything it cannot read counts as a delete, so the owner is
 * asked.
 *
 * The scan reads the whole command text, including quotes, heredoc bodies, `$(...)`, backticks,
 * process substitutions, subshells and inline `-c` scripts. Shell words are normalised before
 * matching: quoting and concatenation are removed (`r''m`, `"rm"`), and so are a leading
 * backslash and a path prefix (`\rm`, `/bin/rm`, `./node_modules/.bin/rimraf`).
 *
 * The default is to ask. Before any positional analysis, a delete word (`rm`, `rmdir`, `unlink`,
 * `rimraf`, `trash` and the rest of DELETE_VERBS) appearing as a whole token anywhere means ask:
 * in the raw text, and in every word after quote removal and concatenation, whatever its position,
 * including inside quoted arguments, comments and heredoc bodies. Tokens split on anything that is
 * not a letter, digit, `_` or `-`, so `/bin/rm`, `x;rm` and `"rm old file"` all count. Positional
 * parsing may then only add reasons to ask (wrappers, shells, interpreters, `find -delete`, git,
 * the hiding constructs); it never clears a mention, so a parser gap fails toward asking. The cost
 * is a false ask, for example `git commit -m "rm old file"`; a missed delete would be worse.
 *
 * Anything the scan cannot read literally also means ask (rule version 2): ANSI-C quoting
 * (`$'...'`) with a backslash escape, which is decoded for the mention check as well; brace
 * expansion (`{a,b}`, `{a..b}`) anywhere in the text; and a command word holding an expansion,
 * a substitution, a glob character or anything outside printable ASCII.
 *
 * Some commands that pass can delete indirectly: `make`, `npm run` and other build or script
 * runners, a script that already exists on disk, or `mv` and `cp` onto an existing file. That is
 * acceptable only because the scan is consulted for one kind of prompt: Claude Code's
 * dangerous-removal check, raised because it found an `rm` it could not analyse. Bypass mode
 * already runs those commands without asking whenever Claude Code does not raise that prompt, so
 * passing them here grants nothing Bypass does not. Reviewers: challenge this if the scan is ever
 * used for any other decision.
 */

/** Bump when the rules change; recorded with every automatic answer. */
export const DELETE_SCAN_RULE_VERSION = 2;

export interface DeleteScanResult {
  /** True when the command deletes, may delete, or could not be read. */
  deletes: boolean;
  /** What was found, for the owner: for example "rm -rf build" or "could not read the command". */
  finding: string | null;
}

interface Word {
  /** The word with quoting removed. */
  text: string;
  /** Contains an unquoted expansion or substitution, so its value is unknown before it runs. */
  dynamic: boolean;
  /** A process substitution, `<(...)` or `>(...)`. */
  processSubstitution: boolean;
  /** Why the word cannot be read literally, such as ANSI-C escapes; it then counts as a delete. */
  unreadable?: string;
}

interface SimpleCommand {
  words: Word[];
  /** Redirections with their targets, such as `>` `out.txt` or `<` `input.sh`. */
  redirects: Array<{ op: string; target: Word | null }>;
  /** Heredoc bodies attached to this command. */
  heredocs: string[];
  /** Position in its pipeline: 0 for the first command. */
  pipelineIndex: number;
  /** Defined as a function (`name() {` or `function name`). */
  definesFunction: boolean;
}

class Untokenizable extends Error {}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "ash"]);
const SCRIPT_INTERPRETERS = new Set([
  "python",
  "python2",
  "python3",
  "node",
  "nodejs",
  "perl",
  "ruby",
  "php",
  "deno",
  "bun",
  "osascript",
  "lua",
  "rscript",
  "awk",
  "gawk",
  "mawk",
  "nawk",
]);
const DELETE_VERBS = new Set([
  "rm",
  "rmdir",
  "unlink",
  "shred",
  "srm",
  "truncate",
  "rimraf",
  "del",
  "del-cli",
  "trash",
  "trash-put",
]);
// Identifiers that delete in the languages an inline script may be written in.
const INLINE_DELETE =
  /\b(?:rm|rmdir|unlink|unlinkSync|rmSync|rmdirSync|remove|removedirs|rmtree|delete|truncate|shred|rimraf|system|popen|exec|execSync|spawn|spawnSync|subprocess|child_process|shutil|File\.delete|Deno\.remove)\b/i;
// Reserved words that may stand before a command word: `do rm x`, `if rm x; then`, `! rm x`.
const KEYWORD_PREFIXES = new Set([
  "if",
  "then",
  "elif",
  "else",
  "do",
  "while",
  "until",
  "!",
  "coproc",
]);
const WRAPPERS = new Set([
  "command",
  "exec",
  "env",
  "sudo",
  "doas",
  "nohup",
  "time",
  "nice",
  "ionice",
  "timeout",
  "stdbuf",
  "xargs",
  "builtin",
]);

/** Scans a shell command. Never throws. */
export function scanForDelete(command: string): DeleteScanResult {
  // A bound on the daemon's single thread: a longer command is not read at all.
  if (command.length > MAX_SCAN_LENGTH) {
    return {
      deletes: true,
      finding: `could not read the command: longer than ${MAX_SCAN_LENGTH} characters`,
    };
  }
  try {
    // bash removes a backslash-newline before it splits words, inside a word too.
    const joined = command.replace(/\\\n/g, "");
    return mentionIn(joined) ?? braceExpansionIn(command) ?? scanShell(command, 0);
  } catch {
    return { deletes: true, finding: "could not read the command" };
  }
}

const MAX_DEPTH = 8;

function scanShell(text: string, depth: number): DeleteScanResult {
  if (depth > MAX_DEPTH) return { deletes: true, finding: "nested too deeply to read" };
  const nested: string[] = [];
  const commands = tokenize(text, nested);
  for (const simple of commands) {
    const words = [
      ...simple.words,
      ...simple.redirects.flatMap((r) => (r.target ? [r.target] : [])),
    ];
    for (const word of words) {
      if (word.unreadable) return { deletes: true, finding: word.unreadable };
      const mention = mentionIn(word.text);
      if (mention) return mention;
    }
  }
  for (const inner of nested) {
    const result = scanShell(inner, depth + 1);
    if (result.deletes) return result;
  }
  const written = new Set<string>();
  for (const simple of commands) {
    const result = analyse(simple, written, depth);
    if (result.deletes) return result;
    for (const redirect of simple.redirects) {
      if (redirect.target && /^(?:\d*>>?|&>>?|>\|)$/.test(redirect.op)) {
        written.add(basenamePath(redirect.target.text));
      }
    }
  }
  return { deletes: false, finding: null };
}

const NO_DELETE: DeleteScanResult = { deletes: false, finding: null };

// `{a,b}` or `{a..b}` with no space or operator inside: the shell may expand it into any word.
/** Commands longer than this are not scanned and ask; every rule below is linear in length. */
export const MAX_SCAN_LENGTH = 16_384;

const BRACE_STOP = new Set([" ", "\t", "\n", ";", "&", "|", "{"]);

/**
 * Brace expansion anywhere in the text, quoted or not; null when none. One linear pass: a `{`
 * opens a candidate, a space, operator or another `{` drops it, and a `}` after a `,` or `..`
 * inside it is a match.
 */
function braceExpansionIn(text: string): DeleteScanResult | null {
  let open = -1;
  let expands = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === "{") {
      open = i;
      expands = false;
    } else if (open >= 0 && BRACE_STOP.has(char)) {
      open = -1;
    } else if (open >= 0 && (char === "," || (char === "." && text[i + 1] === "."))) {
      expands = true;
    } else if (open >= 0 && char === "}") {
      if (expands) {
        return {
          deletes: true,
          finding: `uses brace expansion: ${text.slice(open, i + 1).slice(0, 80)}`,
        };
      }
      open = -1;
    }
  }
  return null;
}

/** A delete word as a whole token anywhere in the text, case-insensitively; null when none. */
function mentionIn(text: string): DeleteScanResult | null {
  for (const token of text.toLowerCase().split(/[^a-z0-9_-]+/)) {
    if (DELETE_VERBS.has(token)) {
      return {
        deletes: true,
        finding: `mentions ${token}: ${text.replace(/\s+/g, " ").slice(0, 180)}`,
      };
    }
  }
  return null;
}

function found(words: readonly Word[], start = 0): DeleteScanResult {
  return {
    deletes: true,
    finding: words
      .slice(start)
      .map((word) => word.text)
      .join(" ")
      .slice(0, 200),
  };
}

/** The verb a word names: no leading backslash, no path prefix, lower-cased for matching. */
function verbOf(word: Word): string {
  const text = word.text.replace(/^\\+/, "");
  const slash = text.lastIndexOf("/");
  return (slash >= 0 ? text.slice(slash + 1) : text).toLowerCase();
}

function basenamePath(text: string): string {
  return text.replace(/^\.\//, "");
}

function analyse(simple: SimpleCommand, written: Set<string>, depth: number): DeleteScanResult {
  if (simple.definesFunction) return { deletes: true, finding: "defines a shell function" };
  for (const heredoc of simple.heredocs) {
    // A heredoc may be a script for whatever reads it; it is read as shell text too.
    const result = scanShell(heredoc, depth + 1);
    if (result.deletes) return result;
  }
  let index = 0;
  const { words } = simple;
  // Reserved words and assignments in front of the command word.
  while (
    index < words.length &&
    (KEYWORD_PREFIXES.has(words[index]!.text) ||
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!.text))
  ) {
    index++;
  }
  return analyseFrom(simple, index, written, depth);
}

function analyseFrom(
  simple: SimpleCommand,
  start: number,
  written: Set<string>,
  depth: number,
): DeleteScanResult {
  const { words } = simple;
  if (start >= words.length) return NO_DELETE;
  const first = words[start]!;
  if (first.dynamic || first.processSubstitution) {
    return { deletes: true, finding: `runs a command named by an expansion: ${first.text}` };
  }
  // A glob or a character outside printable ASCII in the command word is not read literally.
  if (first.text !== "[" && first.text !== "[[" && /[*?[\]]|[^\x20-\x7e]/.test(first.text)) {
    return { deletes: true, finding: `runs a command word it cannot read: ${first.text}` };
  }
  const verb = verbOf(first);
  if (WRAPPERS.has(verb)) {
    const next = skipWrapperOptions(verb, words, start + 1);
    return analyseFrom(simple, next, written, depth);
  }
  if (DELETE_VERBS.has(verb)) return found(words, start);
  if (verb === "alias") return { deletes: true, finding: "defines a shell alias" };
  if (verb === "function") return { deletes: true, finding: "defines a shell function" };
  if (verb === "eval") return evalScan(words, start, depth);
  if (verb === "source" || verb === ".") return found(words, start);
  if (written.has(basenamePath(first.text))) {
    return { deletes: true, finding: `runs ${first.text}, written earlier in this command` };
  }
  const args = words.slice(start + 1);
  if (SHELLS.has(verb)) return shellScan(simple, start, written, depth);
  if (SCRIPT_INTERPRETERS.has(verb)) return interpreterScan(simple, start, written);
  const rule = VERB_RULES[verb];
  if (rule && rule(args)) return found(words, start);
  if (verb === "find") return findScan(simple, start, written, depth);
  return NO_DELETE;
}

function evalScan(words: readonly Word[], start: number, depth: number): DeleteScanResult {
  const args = words.slice(start + 1);
  if (args.some((word) => word.dynamic)) return found(words, start);
  return scanShell(args.map((word) => word.text).join(" "), depth + 1);
}

function shellScan(
  simple: SimpleCommand,
  start: number,
  written: Set<string>,
  depth: number,
): DeleteScanResult {
  const { words } = simple;
  const args = words.slice(start + 1);
  const inline = args.findIndex((word) => /^-[A-Za-z]*c[A-Za-z]*$/.test(word.text));
  if (inline >= 0) {
    const script = args[inline + 1];
    if (!script || script.dynamic) return found(words, start);
    return scanShell(script.text, depth + 1);
  }
  if (args.some((word) => word.processSubstitution)) return found(words, start);
  const file = args.find((word) => !word.text.startsWith("-"));
  if (file) {
    if (file.dynamic || written.has(basenamePath(file.text))) return found(words, start);
    return NO_DELETE;
  }
  // No script argument: the shell reads its commands from stdin.
  const stdin = { deletes: true, finding: `pipes commands into ${verbOf(words[start]!)}` };
  if (simple.pipelineIndex > 0) return stdin;
  if (simple.redirects.some((redirect) => redirect.op === "<")) return stdin;
  // A heredoc on stdin was already scanned as shell text.
  return simple.heredocs.length > 0 ? NO_DELETE : stdin;
}

function interpreterScan(
  simple: SimpleCommand,
  start: number,
  written: Set<string>,
): DeleteScanResult {
  const { words } = simple;
  const verb = verbOf(words[start]!);
  const args = words.slice(start + 1);
  const inline = inlineCodeVerdict(verb, args);
  if (inline !== null) return inline ? found(words, start) : NO_DELETE;
  const moduleRun = moduleVerdict(args);
  if (moduleRun !== null) return moduleRun ? found(words, start) : NO_DELETE;
  if (args.some((word) => word.processSubstitution)) return found(words, start);
  const file = args.find((word) => !word.text.startsWith("-"));
  if (file && file.text !== "-") {
    return file.dynamic || written.has(basenamePath(file.text)) ? found(words, start) : NO_DELETE;
  }
  // Code from stdin: a heredoc whose text passes, or else a pipe or redirect that cannot be read.
  if (simple.heredocs.length === 0) return found(words, start);
  return simple.heredocs.some((body) => INLINE_DELETE.test(body)) ? found(words, start) : NO_DELETE;
}

/** True or false for inline code (`-c`, `-e` and the like, or awk's program), null if none. */
function inlineCodeVerdict(verb: string, args: readonly Word[]): boolean | null {
  let code: Word | undefined;
  if (verb.endsWith("awk")) {
    code = programOf(args);
  } else {
    const flags =
      verb.startsWith("python") || verb === "osascript"
        ? ["-c", "-e"]
        : ["-e", "-E", "-p", "--eval", "--print", "-r"];
    const at = args.findIndex((word) => flags.includes(word.text));
    if (at < 0) return null;
    code = args[at + 1];
  }
  return !code || code.dynamic || INLINE_DELETE.test(code.text);
}

function programOf(args: readonly Word[]): Word | undefined {
  return args.find((word) => !word.text.startsWith("-"));
}

/** `python -m pip uninstall …` deletes; other modules do not; null when no `-m`. */
function moduleVerdict(args: readonly Word[]): boolean | null {
  const at = args.findIndex((word) => word.text === "-m");
  if (at < 0) return null;
  return (
    args[at + 1]?.text === "pip" && args.slice(at + 2).some((word) => word.text === "uninstall")
  );
}

function findScan(
  simple: SimpleCommand,
  start: number,
  written: Set<string>,
  depth: number,
): DeleteScanResult {
  const { words } = simple;
  for (let index = start + 1; index < words.length; index++) {
    const text = words[index]!.text;
    if (text === "-delete") return found(words, start);
    if (["-exec", "-execdir", "-ok", "-okdir"].includes(text)) {
      let end = index + 1;
      while (end < words.length && words[end]!.text !== ";" && words[end]!.text !== "+") end++;
      const inner: SimpleCommand = {
        words: words.slice(index + 1, end).filter((word) => word.text !== "{}"),
        redirects: [],
        heredocs: [],
        pipelineIndex: 0,
        definesFunction: false,
      };
      const result = analyseFrom(inner, 0, written, depth + 1);
      if (result.deletes) return found(words, start);
      index = end;
    }
  }
  return NO_DELETE;
}

type ArgRule = (args: readonly Word[]) => boolean;

const has = (args: readonly Word[], ...values: string[]) =>
  args.some((word) => values.includes(word.text));
const nonOptions = (args: readonly Word[]) => args.filter((word) => !word.text.startsWith("-"));

const VERB_RULES: Record<string, ArgRule> = {
  git: gitDeletes,
  rsync: (args) => args.some((word) => /^--(?:delete|remove-source-files)/.test(word.text)),
  tar: (args) => has(args, "--remove-files"),
  dd: (args) => args.some((word) => word.text.startsWith("of=")),
  docker: containerDeletes,
  podman: containerDeletes,
  nerdctl: containerDeletes,
  kubectl: (args) => has(nonOptions(args), "delete"),
  oc: (args) => has(nonOptions(args), "delete"),
  brew: (args) =>
    ["uninstall", "remove", "rm", "cleanup", "autoremove"].includes(
      nonOptions(args)[0]?.text ?? "",
    ),
  npm: (args) =>
    ["uninstall", "un", "unlink", "remove", "rm", "r", "prune"].includes(
      nonOptions(args)[0]?.text ?? "",
    ),
  pnpm: (args) =>
    ["uninstall", "un", "remove", "rm", "prune"].includes(nonOptions(args)[0]?.text ?? ""),
  yarn: (args) => ["remove", "autoclean"].includes(nonOptions(args)[0]?.text ?? ""),
  pip: (args) => nonOptions(args)[0]?.text === "uninstall",
  pip3: (args) => nonOptions(args)[0]?.text === "uninstall",
  uv: (args) => has(nonOptions(args), "uninstall", "remove"),
  sed: sedExecutes,
  gsed: sedExecutes,
  terraform: infrastructureDeletes,
  tofu: infrastructureDeletes,
  pulumi: infrastructureDeletes,
  cdk: infrastructureDeletes,
  cdktf: infrastructureDeletes,
  helm: infrastructureDeletes,
  serverless: infrastructureDeletes,
  sls: infrastructureDeletes,
};

/** Destroying, deleting or uninstalling infrastructure or releases. */
function infrastructureDeletes(args: readonly Word[]): boolean {
  return (
    has(args, "-destroy", "--destroy") ||
    has(nonOptions(args), "destroy", "delete", "uninstall", "remove", "rm")
  );
}

/**
 * sed runs shell commands through the `e` command or the `e` flag of `s`, so either makes it an
 * interpreter; a script read from a file cannot be checked.
 */
function sedExecutes(args: readonly Word[]): boolean {
  if (args.some((word) => /^(?:-f|--file)/.test(word.text))) return true;
  const scripts: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const text = args[index]!.text;
    if (text === "-e" || text === "--expression") scripts.push(args[++index]?.text ?? "");
    else if (text.startsWith("--expression=")) scripts.push(text.slice("--expression=".length));
  }
  if (scripts.length === 0) {
    const first = args.find((word) => !word.text.startsWith("-"));
    if (first) scripts.push(first.text);
  }
  return scripts.some(sedScriptExecutes);
}

function sedScriptExecutes(script: string): boolean {
  // The `e` command, at the start of a command.
  if (/(?:^|[;\n{}])\s*(?:\d+|\$|\/[^/]*\/)?\s*e(?:\s|;|$)/.test(script)) return true;
  // `s` with an `e` among its flags, for any delimiter.
  const substitution = /s(.)(?:\\.|(?!\1)[^\\])*\1(?:\\.|(?!\1)[^\\])*\1([a-zA-Z0-9]*)/g;
  for (const match of script.matchAll(substitution)) if (match[2]!.includes("e")) return true;
  return false;
}

function containerDeletes(args: readonly Word[]): boolean {
  return has(nonOptions(args), "rm", "rmi", "prune", "kill");
}

// Git options that take a separate value before the subcommand.
const GIT_GLOBAL_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);

const GIT_SUBCOMMANDS: Record<string, ArgRule> = {
  clean: () => true,
  rm: () => true,
  restore: () => true,
  "filter-branch": () => true,
  "filter-repo": () => true,
  worktree: (rest) => has(rest, "remove", "prune"),
  branch: (rest) => has(rest, "--delete") || rest.some((word) => /^-[a-zA-Z]*[dD]/.test(word.text)),
  tag: (rest) => has(rest, "-d", "--delete"),
  push: (rest) =>
    has(rest, "-d", "--delete", "--prune", "--mirror") ||
    rest.some((word) => word.text.startsWith(":")),
  reset: (rest) => has(rest, "--hard", "--merge", "--keep"),
  checkout: (rest) => has(rest, "--", "-f", "--force", ".", "-p"),
  switch: (rest) => has(rest, "--discard-changes", "-f", "--force"),
  stash: (rest) => has(rest, "drop", "clear"),
  "update-ref": (rest) => has(rest, "-d"),
  gc: (rest) => rest.some((word) => word.text.startsWith("--prune")),
  reflog: (rest) => has(rest, "delete", "expire"),
};

function gitDeletes(args: readonly Word[]): boolean {
  // An alias can run any shell command (`!...`) and is defined and run in one command line.
  if (args.some((word) => /^alias\./i.test(word.text))) return true;
  let index = 0;
  while (index < args.length && args[index]!.text.startsWith("-")) {
    index += GIT_GLOBAL_WITH_VALUE.has(args[index]!.text) ? 2 : 1;
  }
  const rule = GIT_SUBCOMMANDS[args[index]?.text ?? ""];
  return rule ? rule(args.slice(index + 1)) : false;
}

/** Skips a wrapper's own options; returns where the wrapped command word starts. */
function skipWrapperOptions(verb: string, words: readonly Word[], start: number): number {
  let index = start;
  const withValue: Record<string, string[]> = {
    sudo: ["-u", "-g", "-C", "-h", "-p", "-U", "-r", "-t", "-D"],
    doas: ["-u", "-C"],
    nice: ["-n"],
    ionice: ["-c", "-n", "-p"],
    timeout: ["-s", "-k", "--signal", "--kill-after"],
    stdbuf: ["-i", "-o", "-e"],
    xargs: ["-I", "-n", "-P", "-L", "-d", "-E", "-s", "-a", "--max-args", "--max-procs"],
    exec: ["-a"],
  };
  while (index < words.length) {
    const text = words[index]!.text;
    if (verb === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(text)) {
      index++;
      continue;
    }
    if (!text.startsWith("-") || text === "-" || text === "--") {
      if (text === "--") index++;
      break;
    }
    index += withValue[verb]?.includes(text) ? 2 : 1;
  }
  // timeout's first operand is the duration.
  if (verb === "timeout" && index < words.length) index++;
  return index;
}

// ---------------------------------------------------------------------------------------------
// Tokenizer

const OPERATOR_START = new Set([";", "&", "|", "(", ")", "{", "}", "\n"]);

/**
 * Splits shell text into simple commands. Nested shell text (substitutions, process
 * substitutions) is appended to `nested` for its own scan. Throws Untokenizable on unbalanced
 * quotes, substitutions or heredocs.
 */
function tokenize(text: string, nested: string[]): SimpleCommand[] {
  return new ShellTokenizer(text, nested).run();
}

const REDIRECT = /^(?:\d*<<<|\d*<<-?|&>>?|\d*>&|\d*<&|\d*>>|\d*>\||\d*<>|\d*>|\d*<)/;

class ShellTokenizer {
  private readonly commands: SimpleCommand[] = [];
  private current = newCommand(0);
  private pipelineIndex = 0;
  private readonly pendingHeredocs: Array<{
    delimiter: string;
    strip: boolean;
    command: SimpleCommand;
  }> = [];
  private i = 0;

  constructor(
    private readonly text: string,
    private readonly nested: string[],
  ) {}

  run(): SimpleCommand[] {
    while (this.i < this.text.length) this.step();
    if (this.pendingHeredocs.length > 0) throw new Untokenizable();
    this.finish(0);
    return this.commands;
  }

  private step(): void {
    const char = this.text[this.i]!;
    if (char === " " || char === "\t") {
      this.i++;
    } else if (char === "\\" && this.text[this.i + 1] === "\n") {
      this.i += 2;
    } else if (char === "\n") {
      this.newline();
    } else if (char === "#") {
      while (this.i < this.text.length && this.text[this.i] !== "\n") this.i++;
    } else if (!this.redirect() && !this.operator(char)) {
      const [word, next] = readWord(this.text, this.i, this.nested);
      if (!word) throw new Untokenizable();
      this.current.words.push(word);
      this.i = next;
    }
  }

  private newline(): void {
    this.i++;
    if (this.pendingHeredocs.length > 0) {
      this.i = readHeredocBodies(this.text, this.i, this.pendingHeredocs);
    }
    this.finish(0);
  }

  /** Redirections, including here-strings and heredocs. */
  private redirect(): boolean {
    const rest = this.text.slice(this.i);
    const match = REDIRECT.exec(rest);
    if (!match || rest.startsWith("<(") || rest.startsWith(">(")) return false;
    const op = match[0].replace(/^\d+/, "");
    this.i += match[0].length;
    while (this.text[this.i] === " " || this.text[this.i] === "\t") this.i++;
    const [target, next] = readWord(this.text, this.i, this.nested);
    this.i = next;
    if (op === "<<" || op === "<<-") {
      if (!target) throw new Untokenizable();
      this.pendingHeredocs.push({
        delimiter: target.text,
        strip: op === "<<-",
        command: this.current,
      });
    } else if (op === "<<<") {
      if (target) this.nested.push(target.text);
    } else {
      this.current.redirects.push({ op, target });
    }
    return true;
  }

  private operator(char: string): boolean {
    if (!OPERATOR_START.has(char)) return false;
    const next = this.text[this.i + 1];
    if (char === "(" && next === ")") {
      // `name() {`: a function definition.
      this.current.definesFunction = true;
      this.i += 2;
      return true;
    }
    if (char === "|") {
      this.i += next === "|" || next === "&" ? 2 : 1;
      this.finish(next === "|" ? 0 : this.pipelineIndex + 1);
      return true;
    }
    const doubled = (char === "&" && next === "&") || (char === ";" && next === ";");
    this.i += doubled ? 2 : 1;
    this.finish(0);
    return true;
  }

  private finish(nextPipelineIndex: number): void {
    const { current } = this;
    if (current.words.length > 0 || current.redirects.length > 0 || current.heredocs.length > 0) {
      this.commands.push(current);
    }
    this.pipelineIndex = nextPipelineIndex;
    this.current = newCommand(nextPipelineIndex);
  }
}

function newCommand(pipelineIndex: number): SimpleCommand {
  return { words: [], redirects: [], heredocs: [], pipelineIndex, definesFunction: false };
}

function readHeredocBodies(
  text: string,
  start: number,
  pending: Array<{ delimiter: string; strip: boolean; command: SimpleCommand }>,
): number {
  let i = start;
  while (pending.length > 0) {
    const { delimiter, strip, command } = pending.shift()!;
    const lines: string[] = [];
    let closed = false;
    while (i <= text.length) {
      const end = text.indexOf("\n", i);
      const line = text.slice(i, end === -1 ? text.length : end);
      i = end === -1 ? text.length + 1 : end + 1;
      if ((strip ? line.replace(/^\t+/, "") : line) === delimiter) {
        closed = true;
        break;
      }
      lines.push(line);
      if (end === -1) break;
    }
    if (!closed) throw new Untokenizable();
    command.heredocs.push(lines.join("\n"));
  }
  return Math.min(i, text.length);
}

interface WordState {
  value: string;
  dynamic: boolean;
  processSubstitution: boolean;
  unreadable?: string;
}

/** Decodes the escapes of a `$'...'` body the way bash does, as far as the scan needs. */
function decodeAnsiC(body: string): string {
  const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b" };
  return body.replace(
    /\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[0-7]{1,3}|c.|.)/g,
    (_match, code: string) => {
      const kind = code[0]!;
      if (kind === "x" || kind === "u" || kind === "U") {
        return String.fromCodePoint(Number.parseInt(code.slice(1), 16));
      }
      if (/[0-7]/.test(kind)) return String.fromCharCode(Number.parseInt(code, 8));
      if (kind === "c") return String.fromCharCode(code.charCodeAt(1) & 0x1f);
      return simple[kind] ?? kind;
    },
  );
}

/** Reads one shell word starting at `start`; returns it and the index after it. */
function readWord(text: string, start: number, nested: string[]): [Word | null, number] {
  const state: WordState = { value: "", dynamic: false, processSubstitution: false };
  let i = start;
  while (i < text.length) {
    const next = readWordPart(text, i, nested, state);
    if (next === null) break;
    i = next;
  }
  if (i === start) return [null, i];
  return [
    {
      text: state.value,
      dynamic: state.dynamic,
      processSubstitution: state.processSubstitution,
      ...(state.unreadable ? { unreadable: state.unreadable } : {}),
    },
    i,
  ];
}

/** Reads one part of a word into `state`; returns the next index, or null at the word's end. */
function readWordPart(text: string, i: number, nested: string[], state: WordState): number | null {
  const char = text[i]!;
  if (" \t\n;&|".includes(char)) return null;
  if ((char === "<" || char === ">") && text[i + 1] === "(") {
    const end = matchParen(text, i + 1);
    nested.push(text.slice(i + 2, end));
    state.value += text.slice(i, end + 1);
    state.processSubstitution = true;
    return end + 1;
  }
  if (char === "<" || char === ">" || char === "(" || char === ")") return null;
  if (char === "\\") {
    // A backslash-newline is a line continuation: bash removes both, joining the word.
    if (text[i + 1] !== "\n") state.value += text[i + 1] ?? "";
    return i + 2;
  }
  if (char === "'") {
    const end = text.indexOf("'", i + 1);
    if (end === -1) throw new Untokenizable();
    state.value += text.slice(i + 1, end);
    return end + 1;
  }
  if (char === "$" && text[i + 1] === "'") {
    const end = findAnsiQuoteEnd(text, i + 2);
    const body = text.slice(i + 2, end);
    // Decoded so the mention check sees what runs; any escape means it is not read literally.
    state.value += decodeAnsiC(body);
    if (body.includes("\\")) state.unreadable = `uses ANSI-C escapes: $'${body.slice(0, 60)}'`;
    return end + 1;
  }
  if (char === '"') {
    return readDoubleQuoted(text, i + 1, nested, (part, isDynamic) => {
      state.value += part;
      if (isDynamic) state.dynamic = true;
    });
  }
  return readUnquotedPart(text, i, nested, state);
}

function readUnquotedPart(text: string, i: number, nested: string[], state: WordState): number {
  const char = text[i]!;
  if (char === "`") {
    const end = findBacktickEnd(text, i + 1);
    nested.push(text.slice(i + 1, end));
    state.value += text.slice(i, end + 1);
    state.dynamic = true;
    return end + 1;
  }
  if (char === "$") {
    const [part, next, inner] = readDollar(text, i);
    if (inner !== null) nested.push(inner);
    state.value += part;
    state.dynamic = true;
    return next;
  }
  state.value += char;
  return i + 1;
}

function readDoubleQuoted(
  text: string,
  start: number,
  nested: string[],
  emit: (part: string, dynamic: boolean) => void,
): number {
  let i = start;
  while (i < text.length) {
    const char = text[i]!;
    if (char === '"') return i + 1;
    if (char === "\\") {
      // Inside double quotes too, bash drops a backslash-newline.
      if (text[i + 1] !== "\n") emit(text[i + 1] ?? "", false);
      i += 2;
      continue;
    }
    if (char === "`") {
      const end = findBacktickEnd(text, i + 1);
      nested.push(text.slice(i + 1, end));
      emit(text.slice(i, end + 1), true);
      i = end + 1;
      continue;
    }
    if (char === "$") {
      const [part, next, isNested] = readDollar(text, i);
      if (isNested !== null) nested.push(isNested);
      emit(part, true);
      i = next;
      continue;
    }
    emit(char, false);
    i++;
  }
  throw new Untokenizable();
}

/** `$(...)`, `$((...))`, `${...}` or `$name`; returns the text, the next index and nested shell. */
function readDollar(text: string, start: number): [string, number, string | null] {
  const next = text[start + 1];
  if (next === "(") {
    const end = matchParen(text, start + 1);
    const inner = text.slice(start + 2, end);
    // `$((...))` is arithmetic, not a command.
    const shell = inner.startsWith("(") && inner.endsWith(")") ? null : inner;
    return [text.slice(start, end + 1), end + 1, shell];
  }
  if (next === "{") {
    const end = text.indexOf("}", start + 2);
    if (end === -1) throw new Untokenizable();
    return [text.slice(start, end + 1), end + 1, null];
  }
  const name = /^[A-Za-z_][A-Za-z0-9_]*|^[0-9@*#?$!-]/.exec(text.slice(start + 1));
  if (!name) return ["$", start + 1, null];
  return [text.slice(start, start + 1 + name[0].length), start + 1 + name[0].length, null];
}

/** The index of the `)` matching the `(` at `open`, skipping quotes and nested parentheses. */
function matchParen(text: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const char = text[i]!;
    if (char === "\\") {
      i += 2;
      continue;
    }
    if (char === "'") {
      const end = text.indexOf("'", i + 1);
      if (end === -1) throw new Untokenizable();
      i = end + 1;
      continue;
    }
    if (char === '"') {
      i = skipDoubleQuoted(text, i + 1);
      continue;
    }
    if (char === "(") depth++;
    if (char === ")") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  throw new Untokenizable();
}

function skipDoubleQuoted(text: string, start: number): number {
  let i = start;
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] === '"') return i + 1;
    i++;
  }
  throw new Untokenizable();
}

function findBacktickEnd(text: string, start: number): number {
  let i = start;
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] === "`") return i;
    i++;
  }
  throw new Untokenizable();
}

function findAnsiQuoteEnd(text: string, start: number): number {
  let i = start;
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] === "'") return i;
    i++;
  }
  throw new Untokenizable();
}
