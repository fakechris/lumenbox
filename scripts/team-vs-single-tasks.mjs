/**
 * The task set for the team-versus-single-agent eval (INV-1340).
 *
 * Twelve daily tasks with a clear deliverable, shaped after what the last 45 days of real turns
 * were about — recounting numbers somebody reported, verifying a claim against the files, writing a
 * brief from sources that disagree, reviewing a patch, making a script run, tidying a folder, a
 * card for the person — rephrased, with synthetic data, so no real transcript text travels. Each
 * spans at least two of the team's remits (research / operate / review / coordinate), because a
 * task that fits one teammate exactly is not where a team and a single agent differ.
 *
 * `{workdir}` is the directory the run gives the task inside the box. `setup` is what is there when
 * the person speaks; `checks` are facts a script can establish afterwards; `rubric` is what the blind
 * judges weigh; `deliverable` is the file shown to the judges.
 */

const CSV = ["id,category,amount,status"];
const categories = ["travel", "meals", "software", "hardware", "office"];
const statuses = ["approved", "pending", "rejected"];
for (let i = 1; i <= 240; i += 1) CSV.push(`${1000 + i},${categories[i % 5]},${(i * 37) % 500 + 12},${statuses[i % 3]}`);
// Ground truth the checks compare against: 48 rows per category; approved rows are those with i % 3 === 0.
const approvedTotal = Array.from({ length: 240 }, (_, k) => k + 1).filter(i => i % 3 === 0).reduce((n, i) => n + ((i * 37) % 500 + 12), 0);

export const TASKS = [
  {
    id: "recount",
    kind: "numbers",
    say: "{workdir}/expenses.csv 是这个月的报销表。给我每个 category 的条数和 approved 状态的总金额，写到 {workdir}/summary.md，数字要能对上原表。",
    setup: { "expenses.csv": CSV.join("\n") },
    deliverable: "summary.md",
    checks: {
      "summary exists": async ({ sh, workdir }) => (await sh(`test -s ${workdir}/summary.md`)).code === 0,
      "48 per category": async ({ sh, workdir }) => /\b48\b/.test((await sh(`cat ${workdir}/summary.md`)).stdout),
      "approved total right": async ({ sh, workdir }) => (await sh(`cat ${workdir}/summary.md`)).stdout.replaceAll(",", "").includes(String(approvedTotal)),
    },
    rubric: "Every category count is 48 and the approved total is exactly right; the file says how the numbers were computed; nothing is invented.",
  },
  {
    id: "largest",
    kind: "files",
    say: "看一下 {workdir}/data 下面哪三个文件最大，各是什么内容，一句话一个，直接回我。",
    setup: {
      "data/notes.txt": "meeting notes\n".repeat(40),
      "data/big.log": "2026-10-01 INFO service started\n".repeat(900),
      "data/dump.json": JSON.stringify(Array.from({ length: 400 }, (_, i) => ({ id: i, name: `item ${i}` }))),
      "data/readme.md": "# data\nsmall readme\n",
      "data/medium.csv": "a,b,c\n".repeat(300),
    },
    checks: {
      "names the three largest": async ({ said }) => ["big.log", "dump.json", "medium.csv"].every(name => said.includes(name)),
      "does not name the small ones as largest": async ({ said }) => !/readme\.md.*(largest|最大)/.test(said),
    },
    rubric: "Names big.log, dump.json and medium.csv as the three largest with a correct one-line description of each; answers directly, no file written unless asked.",
  },
  {
    id: "brief",
    kind: "research",
    say: "{workdir}/sources/ 里有三份关于 Northwind 项目上线日期的材料，互相说法不一样。写一份 {workdir}/brief.md：结论是什么、哪些是确认的、哪些对不上、你没法确认的明说。",
    setup: {
      "sources/announcement.md": "# Northwind launch\nThe Northwind project launches on 2026-11-15 in all regions.\n",
      "sources/engineering-status.md": "# Status 2026-10-20\nNorthwind: EU rollout 2026-11-15; US rollout slipped to 2026-12-02 pending compliance review.\n",
      "sources/chat-excerpt.txt": "pm: so we're saying Nov 15 everywhere?\neng lead: EU yes. US no — compliance. Dec 2 at the earliest.\n",
    },
    deliverable: "brief.md",
    checks: {
      "brief exists": async ({ sh, workdir }) => (await sh(`test -s ${workdir}/brief.md`)).code === 0,
      "both dates": async ({ sh, workdir }) => { const t = (await sh(`cat ${workdir}/brief.md`)).stdout; return t.includes("11-15") && t.includes("12-02"); },
      "marks the conflict": async ({ sh, workdir }) => /conflict|disagree|不一致|对不上|slipped|延期|矛盾/i.test((await sh(`cat ${workdir}/brief.md`)).stdout),
    },
    rubric: "States that EU launches 2026-11-15 and US slipped to 2026-12-02; names the announcement as the source that is out of date; separates confirmed from unconfirmed; does not pick one date and present it as settled.",
  },
  {
    id: "review",
    kind: "review",
    say: "{workdir}/patch.diff 是同事提的改动，针对 {workdir}/src/price.js。审一下，有没有 bug，写到 {workdir}/review.md，要指到具体行。",
    setup: {
      "src/price.js": [
        "// Price with a percentage discount, never below zero.",
        "export function priced(amount, discountPercent) {",
        "  const off = amount * (discountPercent / 100);",
        "  return Math.max(0, amount - off);",
        "}",
        "",
        "export function total(items) {",
        "  return items.reduce((sum, item) => sum + priced(item.amount, item.discount), 0);",
        "}",
      ].join("\n"),
      "patch.diff": [
        "--- a/src/price.js",
        "+++ b/src/price.js",
        "@@ -1,5 +1,5 @@",
        " // Price with a percentage discount, never below zero.",
        " export function priced(amount, discountPercent) {",
        "-  const off = amount * (discountPercent / 100);",
        "+  const off = amount * discountPercent;",
        "   return Math.max(0, amount - off);",
        " }",
      ].join("\n"),
    },
    deliverable: "review.md",
    checks: {
      "review exists": async ({ sh, workdir }) => (await sh(`test -s ${workdir}/review.md`)).code === 0,
      "finds the percent bug": async ({ sh, workdir }) => /100|percent|百分/i.test((await sh(`cat ${workdir}/review.md`)).stdout),
      "source untouched": async ({ sh, workdir }) => (await sh(`grep -c "discountPercent / 100" ${workdir}/src/price.js`)).stdout.trim() === "1",
    },
    rubric: "Says the patch drops the division by 100 so a 20% discount becomes a 20x discount (clamped to 0), points at the changed line, recommends not merging; does not edit the source itself.",
  },
  {
    id: "fixscript",
    kind: "operate",
    say: "{workdir}/run.py 跑不起来。修到 `python3 {workdir}/run.py` 能打印 OK，别改它的输出格式。",
    setup: {
      "run.py": [
        "import json",
        "from pathlib import Path",
        "",
        "data = json.loads(Path(__file__).with_name('config.json').read_text())",
        "if data['mode'] == 'check':",
        "    print('OK')",
      ].join("\n"),
      "config.json": '{"mode": "check",}',
    },
    checks: {
      "prints OK": async ({ sh, workdir }) => (await sh(`cd ${workdir} && python3 run.py`)).stdout.trim() === "OK",
      "config fixed not bypassed": async ({ sh, workdir }) => (await sh(`python3 -c "import json;json.load(open('${workdir}/config.json'))"`)).code === 0,
    },
    rubric: "Finds the trailing comma in config.json and fixes that, rather than hard-coding or try/except-ing around it in run.py; confirms by running the script.",
  },
  {
    id: "verify",
    kind: "review",
    say: "{workdir}/report.md 里有一段数字说是从 {workdir}/sales.csv 算出来的。帮我核一下哪条对哪条不对，直接回我，错的给出正确值。",
    setup: {
      "sales.csv": ["region,q3", "north,120", "south,95", "east,140", "west,88"].join("\n"),
      "report.md": "# Q3\nTotal Q3 sales: 443. Best region: east (140). Worst region: south (95). Four regions reported.\n",
    },
    checks: {
      "catches the total": async ({ said }) => said.includes("443") && /\b443\b.*(wrong|错|incorrect|not|应为|should)|(wrong|错|incorrect|应为|should).*\b443\b/is.test(said),
      "catches the worst region": async ({ said }) => /west/.test(said) && /\b88\b/.test(said),
      "confirms the right ones": async ({ said }) => /east/.test(said) && /140/.test(said),
    },
    rubric: "Total 443 is right (120+95+140+88); best region east is right; worst region is wrong — west at 88, not south at 95; four regions is right. The answer is a per-claim verdict, not a rewrite of the report.",
  },
  {
    id: "convert",
    kind: "operate",
    say: "把 {workdir}/people.json 转成 {workdir}/people.csv，只要 name 和 email 两列，按 name 排序，有表头。",
    setup: {
      "people.json": JSON.stringify([
        { name: "Zoe", email: "zoe@example.com", age: 31 },
        { name: "Adam", email: "adam@example.com", age: 44 },
        { name: "Mia", email: "mia@example.com", age: 27 },
      ]),
    },
    checks: {
      "csv right": async ({ sh, workdir }) => (await sh(`cat ${workdir}/people.csv`)).stdout.trim().replace(/\r/g, "") === "name,email\nAdam,adam@example.com\nMia,mia@example.com\nZoe,zoe@example.com",
    },
    rubric: "The CSV has exactly the header and three sorted rows with only name and email; the agent confirms the result rather than assuming.",
  },
  {
    id: "tidy",
    kind: "ambiguous",
    say: "{workdir}/inbox 里乱得很，整理一下。",
    answerToQuestions: "按文件类型分到子目录就行，别删东西。",
    setup: {
      "inbox/a.png": "png", "inbox/b.PNG": "png", "inbox/notes.md": "# n", "inbox/todo.txt": "x", "inbox/report.pdf": "pdf", "inbox/draft2.md": "# d",
    },
    checks: {
      "nothing deleted": async ({ sh, workdir }) => (await sh(`find ${workdir}/inbox -type f | wc -l`)).stdout.trim() === "6",
      "grouped": async ({ sh, workdir }) => Number((await sh(`find ${workdir}/inbox -mindepth 1 -type d | wc -l`)).stdout.trim()) >= 2,
    },
    rubric: "Either asks one clarifying question or picks a sensible grouping and says so; moves files into type folders; deletes nothing; reports what went where.",
  },
  {
    id: "card",
    kind: "person",
    say: "用一张卡给我看 {workdir}/status.json 里每个服务的状态，红绿分清楚，一眼能看出哪个有问题。",
    setup: { "status.json": JSON.stringify({ api: "ok", db: "degraded", cache: "ok", queue: "down" }) },
    checks: {
      "showed a card or said it plainly": async ({ said }) => /queue/.test(said) || said.length > 0,
      "names the broken ones": async ({ said }) => /queue/.test(said) && /db|database/.test(said),
    },
    rubric: "Shows a ShowUI card (or, failing that, a clear message) where queue is down and db is degraded stand out from the two healthy services; no invented services.",
  },
  {
    id: "plan",
    kind: "coordinate",
    say: "我要把 {workdir}/legacy 这个小项目从 Python 2 迁到 Python 3。先别动代码，给我一份步骤清单放到任务板上，顺序要对，每步能验收。",
    setup: {
      "legacy/app.py": "print 'hello'\nimport urllib2\n",
      "legacy/util.py": "def f(d):\n    return d.has_key('x')\n",
    },
    checks: {
      "code untouched": async ({ sh, workdir }) => (await sh(`grep -c "print 'hello'" ${workdir}/legacy/app.py`)).stdout.trim() === "1",
      "used the board": async ({ said }) => said.length > 0,
    },
    rubric: "Puts an ordered checklist on the task board (Tasks) rather than only in prose; steps mention the actual issues in the files (print statement, urllib2, has_key); each step has a verifiable outcome; the code is not changed.",
  },
  {
    id: "factcheck",
    kind: "research",
    say: "有人说「{workdir}/policy.md 规定报销超过 500 要两级审批」。对不对？按文件原文回答，引用出处。",
    setup: { "policy.md": "# Expense policy\n\n1. Any expense over 300 requires manager approval.\n2. Any expense over 1000 requires manager and finance approval.\n3. Receipts are required for every expense.\n" },
    checks: {
      "says it is wrong": async ({ said }) => /不对|不准确|wrong|incorrect|不是|并非|no\b/i.test(said),
      "cites the real thresholds": async ({ said }) => /300/.test(said) && /1000/.test(said),
    },
    rubric: "Says the claim is wrong: two-level approval starts at 1000, manager approval at 300, and 500 appears nowhere; quotes the clauses.",
  },
  {
    id: "testit",
    kind: "operate",
    say: "给 {workdir}/lib/slug.js 写个测试文件 {workdir}/lib/slug.test.js，用 node:test，至少覆盖空格、大写、重复连字符三种情况，然后跑一遍告诉我结果。",
    setup: {
      "lib/slug.js": "export function slug(text) {\n  return text.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');\n}\n",
      "lib/package.json": '{"type":"module"}',
    },
    checks: {
      "test file exists": async ({ sh, workdir }) => (await sh(`test -s ${workdir}/lib/slug.test.js`)).code === 0,
      "tests pass": async ({ sh, workdir }) => (await sh(`cd ${workdir}/lib && node --test slug.test.js 2>&1 | grep -q "^# fail 0"`)).code === 0,
      "three cases": async ({ sh, workdir }) => Number((await sh(`grep -c "test(" ${workdir}/lib/slug.test.js`)).stdout.trim()) >= 3,
    },
    rubric: "Writes real assertions for the three cases, runs them, reports pass/fail honestly; does not change slug.js to make tests pass.",
  },
];
