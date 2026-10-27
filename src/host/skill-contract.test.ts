/** The skill contract (INV-1375): what an agent may change in a skill a person shaped, and how much. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { changedLines, checkSkillDraft, contractRefusal, globMatches, parseSkillContract, skillWriteRefusal } from "./skill-contract.ts";

const YAML = `learnable:
  - path: SKILL.md
    max_bytes: 400
    frontmatter: [name, description]
  - path: scripts/*.py
    max_files: 2
fixed: [constraints.md]
fixed_frontmatter: [allowed-tools]
max_diff_lines: 5
`;
const SKILL = "---\nname: report\ndescription: weekly report\nallowed-tools: bash, WebFetch\n---\nStep one.\nStep two.\n";

test("the contract reads from YAML or JSON, and refuses what it cannot read", () => {
  const contract = parseSkillContract(YAML);
  assert.deepEqual(contract.learnable[0], { path: "SKILL.md", maxBytes: 400, frontmatter: ["name", "description"] });
  assert.deepEqual(contract.learnable[1], { path: "scripts/*.py", maxFiles: 2 });
  assert.deepEqual(contract.fixed, ["constraints.md"]);
  assert.deepEqual(contract.fixedFrontmatter, ["allowed-tools"]);
  assert.equal(contract.maxDiffLines, 5);
  assert.deepEqual(parseSkillContract('{"learnable":["SKILL.md"]}').learnable, [{ path: "SKILL.md" }]);
  assert.throws(() => parseSkillContract("learnable:\n  - path: /etc/passwd\n"), /relative path/);
  assert.throws(() => parseSkillContract("learnable: []\n"), /lists nothing/);
  assert.throws(() => parseSkillContract("learnable:\n  - SKILL.md\nwhatever: 1\n"), /unknown key/);
  assert.ok(globMatches("scripts/*.py", "scripts/a.py") && !globMatches("scripts/*.py", "scripts/x/a.py") && globMatches("docs/**", "docs/a/b.md"));
});

test("each of the five checks refuses its case, and an honest edit passes", () => {
  const contract = parseSkillContract(YAML);
  const ok = SKILL.replace("Step two.", "Step two, carefully.");
  assert.equal(contractRefusal(contract, "SKILL.md", SKILL, ok), undefined);
  assert.match(contractRefusal(contract, "constraints.md", "Never pay.", "Pay freely.") ?? "", /fixed/);
  assert.equal(contractRefusal(contract, "constraints.md", "Never pay.", "Never pay."), undefined, "rewriting a fixed file unchanged is not a change");
  assert.match(contractRefusal(contract, "skill.yaml", YAML, "learnable: [\"**\"]") ?? "", /contract/);
  assert.match(contractRefusal(contract, "notes/x.md", undefined, "x") ?? "", /not among the files/);
  assert.match(contractRefusal(contract, "SKILL.md", SKILL, SKILL + "x".repeat(400)) ?? "", /bytes/);
  assert.match(contractRefusal(contract, "scripts/c.py", undefined, "print(1)", ["scripts/a.py", "scripts/b.py"]) ?? "", /allows 2/);
  assert.match(contractRefusal(contract, "SKILL.md", SKILL, SKILL.replace("description: weekly report\n", "")) ?? "", /description/);
  assert.match(contractRefusal(contract, "SKILL.md", SKILL, SKILL.replace("bash, WebFetch", "bash, WebFetch, RunOnHost")) ?? "", /allowed-tools.*fixed/);
  assert.match(contractRefusal(contract, "SKILL.md", SKILL, `${SKILL}a\nb\nc\nd\ne\nf\n`) ?? "", /changes 6 lines/);
  assert.match(contractRefusal(contract, "SKILL.md", SKILL, `${SKILL}token: ghp_${"a".repeat(36)}\n`) ?? "", /credential/);
  assert.equal(changedLines("a\nb\nc", "a\nB\nc"), 1);
});

test("a multi-file draft keeps what is allowed and reverts the rest to the current version", () => {
  const contract = parseSkillContract(YAML);
  const current = new Map([["SKILL.md", SKILL], ["constraints.md", "Never pay."]]);
  const draft = new Map([["SKILL.md", SKILL.replace("Step two.", "Step 2.")], ["constraints.md", "Pay."], ["scripts/a.py", "print(1)"], ["stray.txt", "x"]]);
  const result = checkSkillDraft(contract, current, draft);
  assert.equal(result.refused, undefined);
  assert.equal(result.files.get("constraints.md"), "Never pay.", "reverted to the person's text");
  assert.equal(result.files.get("SKILL.md"), SKILL.replace("Step two.", "Step 2."));
  assert.equal(result.files.get("scripts/a.py"), "print(1)");
  assert.equal(result.files.has("stray.txt"), false, "a new file outside learnable is dropped");
  assert.deepEqual(result.reverted.map(r => r.path).sort(), ["constraints.md", "stray.txt"]);
  const empty = checkSkillDraft(contract, new Map(), new Map([["SKILL.md", `${SKILL}secret: ghp_${"b".repeat(36)}`]]));
  assert.match(empty.refused ?? "", /no SKILL.md/);
  assert.equal(checkSkillDraft(undefined, new Map(), new Map([["SKILL.md", SKILL], ["any.txt", "x"]])).reverted.length, 0, "no contract: only the credential scan");
});

test("write_file and edit_file consult the box's skill.yaml; no contract means no change in behaviour", async () => {
  const files = new Map([["/home/box/work/skills/report/skill.yaml", YAML], ["/home/box/work/skills/report/SKILL.md", SKILL], ["/home/box/work/skills/free/SKILL.md", SKILL]]);
  const box = {
    readFile: async (path: string) => {
      const content = files.get(path);
      if (content === undefined) throw new Error("does not exist");
      return { content };
    },
    listDir: async (path: string) => ({ entries: [...files.keys()].filter(p => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes("/")).map(p => ({ name: p.slice(path.length + 1), type: "file" })) }),
  };
  const dir = "/home/box/work/skills";
  assert.match((await skillWriteRefusal(box, `${dir}/report/SKILL.md`, SKILL.replace("bash, WebFetch", "bash"))) ?? "", /allowed-tools/);
  assert.equal(await skillWriteRefusal(box, `${dir}/report/SKILL.md`, SKILL.replace("Step two.", "Step 2.")), undefined);
  assert.match((await skillWriteRefusal(box, "~/work/skills/report/skill.yaml", "learnable: [\"**\"]")) ?? "", /contract/);
  assert.equal(await skillWriteRefusal(box, `${dir}/free/anything.sh`, "rm -rf /"), undefined, "a skill without skill.yaml is the agent's, as before");
  assert.equal(await skillWriteRefusal(box, "/home/box/work/report.md", "x"), undefined, "not a skill path");
  files.set(`${dir}/report/skill.yaml`, "learnable:\n  ??? broken\n");
  assert.match((await skillWriteRefusal(box, `${dir}/report/SKILL.md`, SKILL)) ?? "", /cannot be read/);
});
