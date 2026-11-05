/**
 * How related a memory is to some text: words, their stems, and what they are about (INV-1580).
 *
 * Plain word overlap missed a memory written in other words: "the deployment region is eu-west-1"
 * did not answer "where do we ship to", "the weekly sync moved to Thursdays" did not answer "my
 * calendar on Thursday", and a Chinese question about 数据库 never met an English note about the
 * database. Recall and the lexical fallback both stopped at the words.
 *
 * Three kinds of term, each weighted, and every term weighted again by how rare it is among the
 * candidates, so a word every note shares counts for little:
 * - **words** as `dedupeKey` cuts them (Han text in bigrams), full weight;
 * - **stems**, so "thursdays" meets "thursday" and "replies" meets "reply";
 * - **concepts**: a small, fixed table of what work notes are commonly about, in English and
 *   Chinese, so "ship" meets "deployment" and 数据库 meets "database".
 *
 * Local, deterministic, no network and no model call, so there is nothing to fall back from; the
 * word-only score (`meaning: false`) is what matching was before, kept as the baseline the fixtures
 * measure against. This is the one notion of relevance for memory: `selectRelevant` (the lexical
 * fallback, the extractor's and the judge's shortlists) and the Recall tool both read it.
 */

import { dedupeKey, type MemoryRecord } from "./memory.ts";

/** What work notes are commonly about. A word in one of these meets every other word in it. */
const CONCEPTS: readonly (readonly string[])[] = [
  ["deploy", "deployment", "deployed", "release", "released", "ship", "shipped", "rollout", "launch", "上线", "发布", "部署", "发版"],
  ["region", "zone", "datacenter", "区域", "地区", "机房", "可用区"],
  ["database", "db", "postgres", "mysql", "sqlite", "rds", "数据库"],
  ["schedule", "calendar", "meeting", "sync", "standup", "appointment", "日程", "日历", "会议", "例会", "开会"],
  ["password", "credential", "credentials", "secret", "token", "apikey", "密码", "凭据", "密钥", "口令"],
  ["timezone", "tz", "时区"],
  ["answer", "answers", "reply", "replies", "response", "respond", "回答", "回复", "答复"],
  ["short", "brief", "concise", "terse", "简短", "简洁", "精简"],
  ["budget", "cost", "costs", "spend", "spending", "price", "预算", "花费", "费用", "成本"],
  ["owner", "owns", "owned", "responsible", "负责", "负责人"],
  ["bug", "issue", "error", "failure", "incident", "故障", "错误", "问题", "事故"],
  ["doc", "docs", "documentation", "runbook", "readme", "wiki", "文档", "手册", "说明"],
  ["branch", "分支"],
  ["email", "mail", "inbox", "邮件", "邮箱"],
  ["invoice", "bill", "billing", "receipt", "发票", "账单"],
  ["test", "tests", "testing", "ci", "测试"],
  ["holiday", "vacation", "leave", "pto", "假期", "休假", "请假"],
  ["user", "person", "customer", "client", "用户", "客户"],
  ["style", "tone", "voice", "format", "风格", "语气", "格式"],
  ["server", "host", "machine", "instance", "服务器", "主机"],
];
const CONCEPT_OF = new Map<string, number>();
CONCEPTS.forEach((words, index) => { for (const word of words) CONCEPT_OF.set(word, index); });
/** Han concept words found inside a run, since Chinese text carries no spaces to split on. */
const HAN_CONCEPTS = [...CONCEPT_OF.keys()].filter(word => /\p{Script=Han}/u.test(word));

const STOP = new Set(["the", "and", "for", "are", "was", "with", "that", "this", "what", "which", "where", "when", "who", "how", "our", "you", "your", "does", "did", "is", "it", "in", "on", "of", "to", "do", "we", "my", "me", "be", "at", "by", "an", "or", "if", "as", "so"]);

/** A light English stem: enough that plurals and tenses meet, not a linguistic claim. */
export function stem(word: string): string {
  if (!/^[a-z]+$/.test(word) || word.length <= 3) return word;
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith("ing") && word.length > 5) return word.slice(0, -3);
  if (word.endsWith("ed") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("ment") && word.length > 6) return word.slice(0, -4);
  if (word.endsWith("es") && word.length > 4 && /(s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

const WORD = 1;
const STEM = 0.8;
const CONCEPT = 0.6;

/** The weighted terms of a text. With `meaning: false`, only its words, as matching was before. */
export function termsOf(text: string, meaning = true): Map<string, number> {
  const terms = new Map<string, number>();
  const add = (term: string, weight: number) => { if ((terms.get(term) ?? 0) < weight) terms.set(term, weight); };
  // The words matching always used: longer than two letters, or any Han bigram (two characters is a whole Chinese word).
  for (const word of dedupeKey(text).split(" ")) {
    if (word === "" || STOP.has(word) || !(word.length > 2 || /\p{Script=Han}/u.test(word))) continue;
    add(`w:${word}`, WORD);
    if (!meaning) continue;
    add(`s:${stem(word)}`, STEM);
    const concept = CONCEPT_OF.get(word) ?? CONCEPT_OF.get(stem(word));
    if (concept !== undefined) add(`c:${concept}`, CONCEPT);
  }
  if (meaning) {
    // Short concept words ("db", "tz", "ci") are below the length gate above, and Han concept words span bigrams.
    for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
      const concept = CONCEPT_OF.get(word);
      if (concept !== undefined) add(`c:${concept}`, CONCEPT);
    }
    for (const word of HAN_CONCEPTS) if (text.includes(word)) add(`c:${CONCEPT_OF.get(word)}`, CONCEPT);
  }
  return terms;
}

export interface Scored {
  record: MemoryRecord;
  score: number;
}

/**
 * Each record's relatedness to the query, best first, only those above nothing; ties go to the
 * newer record, then the text, so the order never depends on input order.
 */
export function rankRelated(query: string, records: readonly MemoryRecord[], options: { meaning?: boolean } = {}): Scored[] {
  const meaning = options.meaning ?? true;
  const wanted = termsOf(query, meaning);
  if (wanted.size === 0) return [];
  const docs = records.map(record => ({ record, terms: termsOf(record.text, meaning) }));
  // Rarer terms count for more: a word in every note says nothing about which note is meant.
  const df = new Map<string, number>();
  for (const { terms } of docs) for (const term of terms.keys()) if (wanted.has(term)) df.set(term, (df.get(term) ?? 0) + 1);
  const idf = (term: string) => Math.log(1 + docs.length / (df.get(term) ?? 1));
  return docs
    .map(({ record, terms }) => {
      let score = 0;
      for (const [term, weight] of wanted) {
        const have = terms.get(term);
        if (have !== undefined) score += Math.min(weight, have) * idf(term);
      }
      return { record, score };
    })
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.record.at.localeCompare(a.record.at) || a.record.text.localeCompare(b.record.text));
}

/**
 * What the Recall tool finds for a search: the records holding every word, as it always did, then
 * the ones related by meaning that hold not every word, best first (at most `related`). An empty
 * search is every record, as before.
 */
export function recallMatches<T extends { record: MemoryRecord }>(search: string, entries: readonly T[], options: { related?: number; meaning?: boolean } = {}): { exact: T[]; related: T[] } {
  const words = search.toLowerCase().split(/\s+/).filter(word => word !== "");
  const exact = entries.filter(({ record }) => words.every(word => record.text.toLowerCase().includes(word)));
  if (words.length === 0 || options.meaning === false) return { exact, related: [] };
  const rest = entries.filter(entry => !exact.includes(entry));
  const ranked = rankRelated(search, rest.map(entry => entry.record));
  const related = ranked.slice(0, options.related ?? 10).map(({ record }) => rest.find(entry => entry.record === record)!);
  return { exact, related };
}
