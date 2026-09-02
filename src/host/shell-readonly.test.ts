import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyShell } from "./shell-readonly.ts";

test("commands that only read are said to, and everything uncertain is not", () => {
  for (const command of [
    "ls -la",
    "cat README.md | head -50",
    "git status && git log --oneline -5",
    "git diff HEAD~1 -- src/",
    "grep -rn 'TODO' src | wc -l",
    "find . -name '*.ts' -newer package.json",
    "sed -n '1,20p' file.txt",
    "docker ps -a; docker logs agentbox-box",
    "npm ls --depth=0",
    "ps aux | grep node",
    "echo 'a > b in quotes' | tr a-z A-Z",
    "git branch -a",
    "git stash list",
  ]) {
    assert.deepEqual(classifyShell(command), { readOnly: true }, command);
  }
  const notReadOnly: [string, RegExp][] = [
    ["ls > out.txt", /redirection/],
    ["cat $(which node)", /substitution/],
    ["sudo ls", /sudo/],
    ["rm -rf /tmp/x", /rm/],
    ["find . -name '*.log' -delete", /find with an action flag/],
    ["sed -i 's/a/b/' file", /sed -i/],
    ["git push origin main", /git push/],
    ["git branch -D old", /changes refs/],
    ["git checkout -b x", /git checkout/],
    ["docker run -it ubuntu", /docker run/],
    ["npm install left-pad", /npm install/],
    ["node script.js", /running code/],
    ["FOO=1 ls", /environment prefix/],
    ["curl https://example.com", /curl/],
    ["somebinary --flag", /not a known reader/],
    ["ls 'unterminated", /unbalanced quotes/],
    ["awk '{ system(\"rm x\") }' file", /awk/],
    ["echo hi | tee log", /tee/],
    ["", /empty/],
  ];
  for (const [command, why] of notReadOnly) {
    const verdict = classifyShell(command);
    assert.equal(verdict.readOnly, false, command);
    if (!verdict.readOnly) assert.match(verdict.because, why, command);
  }
});
