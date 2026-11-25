import { describe, expect, test } from "vitest";
import { isAutoAnswerableReason } from "./auto-answer.js";
import { DELETE_SCAN_RULE_VERSION, scanForDelete } from "./delete-scan.js";

// Commands that stopped threads in Bypass mode on Nov 23 and 25 (#659), with paths and names
// replaced. Only the first has no delete; the rest must keep asking.
const ARCHIVE_LOOP = `set -e; A=/work/archive; mkdir -p $A; cd /work/app
for pair in "lab:feat/lab" "buggy:veh/buggy"; do d=\${pair%%:*}; b=\${pair#*:}; t="archive/\${b//\\//-}"; git tag -f "$t" "$b" >/dev/null; W=/work/trees/$d; if [ -n "$(git -C $W status --porcelain)" ]; then git -C $W diff HEAD > $A/$d.tracked.patch; git -C $W ls-files --others --exclude-standard > $A/$d.untracked.txt; sz=$(git -C $W ls-files --others --exclude-standard -z | (cd $W && xargs -0 du -ck 2>/dev/null | tail -1 | cut -f1)); echo "$d dirty: patch $(wc -l < $A/$d.tracked.patch) lines, untracked $(wc -l < $A/$d.untracked.txt | tr -d ' ') files, \${sz}K"; if [ "\${sz:-0}" -lt 200000 ]; then (cd $W && git ls-files --others --exclude-standard -z | tar --null -czf $A/$d.untracked.tgz -T -); echo "  saved"; fi; fi; echo "tagged $t -> $(git rev-parse --short $t)"; done; ls -la $A`;

const RM_AFTER_CD =
  "mkdir -p /tmp/probe/x && cd /tmp/probe/x && rm -rf * && curl -s https://example.org/x > meta.json";

const HEREDOC_SCRIPT = `cd /tmp/verify && cat > run-all.sh <<'EOF'
#!/bin/zsh
V=/tmp/verify
start_server &
rm -f $V/server.pid
EOF
chmod +x run-all.sh`;

const HEREDOCS_THEN_RM = `cd /tmp/verify && cat > repro.mjs <<'EOF'
import { writeFileSync } from "node:fs";
writeFileSync("out.json", "{}");
EOF
node --check repro.mjs && echo ok; rm -f shots/*`;

const LOOP_RM = `W=/work/diag; R=/work; cd $W; for d in before after; do T=$R/copy-$d; find . -name node_modules -type d -prune | while read n; do [ -d "$T/$n" ] && rm -rf "$T/$n"; mkdir -p "$T/$(dirname $n)"; cp -c -R "$n" "$T/$n" || echo FAIL $n; done; done`;

describe("scanForDelete", () => {
  test("a long compound command with no delete passes", () => {
    expect(scanForDelete(ARCHIVE_LOOP)).toEqual({ deletes: false, finding: null });
  });

  test.each([
    ["rm after cd", RM_AFTER_CD],
    ["rm inside a heredoc script", HEREDOC_SCRIPT],
    ["rm after heredocs", HEREDOCS_THEN_RM],
    ["rm in a loop", LOOP_RM],
    ["rm after do", 'for d in a b; do rm -rf "/tmp/$d"; done'],
    ["rm after then", "if true; then rm x; fi"],
    ["rm after else", "if false; then ls; else rm x; fi"],
    ["rm as a condition", "while rm x; do ls; done"],
    ["rm after !", "! rm x"],
    ["rm in braces", "{ rm x; }"],
    ["rm in a subshell", "( rm x )"],
    ["rm in a case branch", "case $a in b) rm x;; esac"],
  ])("%s asks", (_label, command) => {
    expect(scanForDelete(command).deletes).toBe(true);
  });

  test.each([
    ["quoted rm", `"rm" -rf build`],
    ["concatenated rm", "r''m -rf build"],
    ["backslash rm", "\\rm -rf build"],
    ["path to rm", "/bin/rm -rf build"],
    ["rimraf through a path", "./node_modules/.bin/rimraf dist"],
    ["a command word from a variable", "$TOOL -rf build"],
    ["a command word from a substitution", "$(which rm) -rf build"],
    ["a pipe into a shell", "echo 'rm -rf build' | sh"],
    ["a process substitution into a shell", "bash <(echo ls)"],
    ["a file into a shell", "sh < steps.sh"],
    ["find -delete after the paths", "find . -name '*.tmp' -delete"],
    ["find -exec sh -c with rm", `find . -name x -exec sh -c 'rm "$1"' _ {} \\;`],
    ["git with a global option before clean", "git -C repo clean -fdx"],
    ["git reset --hard", "git reset --hard HEAD~1"],
    ["git checkout -- path", "git checkout -- src/app.ts"],
    ["bash -c with rm", `bash -c "rm -rf build"`],
    ["python inline delete", `python3 -c "import shutil; shutil.rmtree('build')"`],
    ["eval", `eval "rm -rf build"`],
    ["xargs rm", "ls | xargs rm"],
    ["sudo before rm", "sudo -u root rm -rf /var/x"],
    ["env before rm", "env FOO=1 rm x"],
    ["timeout before rm", "timeout 10 rm x"],
    ["a script written earlier", "printf 'ls\\n' > steps.sh; bash steps.sh"],
    ["an alias", "alias clean='ls'"],
    ["a function", "tidy() { ls; }; tidy"],
    ["docker prune", "docker system prune -f"],
    ["kubectl delete", "kubectl delete pod web"],
    ["npm uninstall", "npm uninstall left-pad"],
    ["rsync --delete", "rsync -a --delete src/ dest/"],
    ["an unterminated quote", `echo "unterminated`],
    ["an unterminated heredoc", "cat <<EOF\nno end"],
  ])("%s asks", (_label, command) => {
    expect(scanForDelete(command).deletes).toBe(true);
  });

  test.each([
    ["a plain redirect", "echo hi > out.txt"],
    ["mv", "mv a.txt b.txt"],
    ["cp -f", "cp -f a.txt b.txt"],
    ["ln -sf", "ln -sf a b"],
    ["git checkout a branch", "git checkout main"],
    ["git tag -f", "git tag -f v1 HEAD"],
    ["tar -x", "tar -xzf a.tgz"],
    ["unzip -o", "unzip -o a.zip"],
    ["make", "make build"],
    ["npm run", "npm run build"],
    ["a python heredoc without a delete", "python3 - <<'EOF'\nprint(1)\nEOF"],
  ])("%s passes", (_label, command) => {
    expect(scanForDelete(command)).toEqual({ deletes: false, finding: null });
  });

  // The cost direction: a delete word anywhere asks, even where it cannot run.
  test.each([
    ["a quoted mention in a commit message", `git commit -m "rm old file"`],
    ["a mention in an echo", "echo 'run rimraf later' > notes.txt"],
  ])("%s asks", (_label, command) => {
    expect(scanForDelete(command).deletes).toBe(true);
  });

  test("the rule version is recorded", () => {
    expect(DELETE_SCAN_RULE_VERSION).toBe(1);
  });
});

// The automatic answer's own match (#659, part B), separate from the card's display match.
describe("isAutoAnswerableReason", () => {
  test.each([
    "Dangerous rm operation on statically-unresolvable target: /tmp/x/*",
    "Dangerous rmdir operation on statically-unresolvable target: command substitution output",
    "Dangerous rm operation not ruled out \u2014 the shell may read this command differently than it was parsed",
    "Dangerous rm operation not ruled out \u2014 too many command substitutions to analyze (12)",
    "Dangerous rm operation not ruled out \u2014 too many nested command substitutions to analyze",
    "Dangerous rm operation not ruled out \u2014 some nested commands or function substitutions could not be analyzed",
    "This shell -c script runs rm and could not be checked",
  ])("answers %s", (decisionReason) => {
    expect(isAutoAnswerableReason({ decisionReason })).toBe(true);
  });

  test.each([
    // Known dangerous targets always ask.
    "Dangerous rm operation on critical path: /etc",
    "Dangerous rm operation on working directory or its ancestor: /work",
    "Dangerous rm operation on possibly-empty variable path: $D/x (use a literal path: when the expansion is empty this removes /x)",
    "Dangerous rm operation on drive root: \\",
    "Dangerous rm operation on mounted drive path: /Volumes/x",
    // Near misses: a prefix, a second line, a trailing addition, ANSI, another dash.
    "Dangerous rm operation",
    "Dangerous rm operation on statically-unresolvable target: /tmp/x\n/etc",
    "Dangerous rm operation not ruled out \u2014 too many nested command substitutions to analyze.",
    "\u001b[1mDangerous rm operation not ruled out \u2014 too many nested command substitutions to analyze",
    "Dangerous rm operation not ruled out - too many nested command substitutions to analyze",
    "A permission rule denies a command in this shell -c script",
  ])("asks for %s", (decisionReason) => {
    expect(isAutoAnswerableReason({ decisionReason })).toBe(false);
  });

  test("an ask rule, a reason code or another reason type asks", () => {
    const decisionReason = "This shell -c script runs rm and could not be checked";
    expect(isAutoAnswerableReason({ decisionReason, matchedAskRule: { source: "user" } })).toBe(
      false,
    );
    expect(isAutoAnswerableReason({ decisionReason, decisionReasonCode: "memory_paused" })).toBe(
      false,
    );
    expect(isAutoAnswerableReason({ decisionReason, decisionReasonType: "rule" })).toBe(false);
    expect(isAutoAnswerableReason({ decisionReason, decisionReasonType: "safetyCheck" })).toBe(
      true,
    );
  });
});
