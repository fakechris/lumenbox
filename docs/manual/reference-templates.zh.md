<!-- doc: reference-templates.zh
     title: 参考：模板货架
     family: manual
     status: current
     covers: reference-templates
     updated: generated
     generated: true
-->
# 参考：模板货架

[English](reference-templates.md) · 中文。本页由 `scripts/docs-reference.mjs` 生成，来源：`shelfTemplates()`、`CATALOG_EXPERTS`、`CATALOG_CREWS` 和 `CATALOG_CONNECTORS`（src/host/catalog.ts）。
本页与来源不一致时 `npm test` 会失败；改来源，然后运行 `node scripts/docs-reference.mjs --write`。

## 模板

55 个现成模板（`lumenbox-template/1`，src/host/catalog-data/templates）：每个都是一个完整可用的 agent——人设、记忆、skill、例行任务、连接器。名称和说明来自目录，保持原文。

| slug | 名称 | 标题 | skill | 例行任务 | 连接器 | 记忆 |
|---|---|---|---|---|---|---|
| `ad-spend-watch` | Ad Spend Watch | Ad Spend Watch | 12 | 0 | mcp:slack, mcp:notion, mcp:linear, mcp:datadog, mcp:sentry, mcp:figma, mcp:gmail, mcp:google-sheets | 9 |
| `ai-search-visibility` | AI Search Visibility | AI Search Visibility | 10 | 0 | mcp:slack, mcp:notion, mcp:linear, mcp:google-sheets | 9 |
| `alfred` | Alfred | Alfred | 6 | 3 | — | 15 |
| `apple-search-ads-review` | Apple Search Ads Review | Apple Search Ads Review | 9 | 0 | mcp:slack, mcp:notion, mcp:linear, mcp:gmail, mcp:google-sheets | 8 |
| `bot-boss` | Bot Boss | Bot Boss | 0 | 3 | mcp:gmail, mcp:google-calendar, mcp:slack | 0 |
| `call-follow-ups` | Call Follow-Ups | Call Follow-Ups | 10 | 0 | mcp:slack, mcp:notion, mcp:linear, mcp:gmail, mcp:google-calendar | 10 |
| `chief-health` | Chief Health | Chief Health | 0 | 2 | — | 0 |
| `clip-bot` | Clip Bot | Clip Bot | 8 | 0 | mcp:slack, mcp:notion, mcp:linear, mcp:figma | 7 |
| `company-docs-q-a` | Company Docs Q&A | Company Docs Q&A | 0 | 0 | mcp:slack, mcp:notion | 6 |
| `cooper` | Cooper | Cooper | 0 | 3 | mcp:slack | 8 |
| `copy-humanizer` | Copy Humanizer | Copy Humanizer | 8 | 0 | mcp:notion, mcp:slack, mcp:figma, mcp:linear, mcp:gmail | 6 |
| `credit-card-max` | Credit Card Max | Credit Card Max | 0 | 1 | — | 1 |
| `critiquito-design-critique` | Critiquito: Design Critique | Critiquito: Design Critique | 8 | 0 | mcp:figma, mcp:slack, mcp:notion, mcp:linear | 6 |
| `deal-hunting` | Deal Hunting | Deal Hunting | 0 | 2 | — | 2 |
| `dr-eggbot` | dr eggbot | dr eggbot | 4 | 2 | — | 9 |
| `event-producer` | Event Producer | Event Producer | 11 | 0 | mcp:slack, mcp:notion, mcp:linear, mcp:figma, mcp:gmail, mcp:google-calendar, mcp:google-sheets | 7 |
| `event-request-desk` | Event Request Desk | Event Request Desk | 11 | 0 | mcp:slack, mcp:notion, mcp:linear, mcp:figma, mcp:gmail, mcp:google-calendar, mcp:google-drive, mcp:google-sheets | 8 |
| `figma-bro` | figma bro | figma bro | 10 | 0 | mcp:figma, mcp:notion, mcp:linear, mcp:slack | 6 |
| `frank` | frank | frank | 0 | 4 | mcp:google-calendar, mcp:gmail, mcp:slack, mcp:notion, mcp:google-sheets | 14 |
| `game-art-director` | Game Art Director | Game Art Director | 8 | 0 | mcp:figma, mcp:notion, mcp:slack, mcp:linear | 7 |
| `gtm-loop-closer` | GTM Loop Closer | GTM Loop Closer | 6 | 0 | mcp:gmail, mcp:google-calendar, mcp:slack, mcp:notion, mcp:google-sheets | 23 |
| `haggle-bot` | Haggle Bot | Haggle Bot | 6 | 2 | mcp:google-sheets, mcp:gmail, mcp:slack, mcp:notion, mcp:google-drive | 30 |
| `imogen` | Imogen | Imogen | 0 | 0 | — | 2 |
| `jev-router` | Jev router | Classification & Routing Specialist | 3 | 1 | — | 7 |
| `last30days` | last30days | last30days | 1 | 0 | — | 8 |
| `lead-pipeline-desk` | Lead Pipeline Desk | Lead Pipeline Desk | 9 | 0 | mcp:slack, mcp:notion, mcp:linear, mcp:gmail, mcp:google-sheets | 10 |
| `lingxi-s-engineer-bot` | Lingxi's Engineer Bot | Lingxi's Engineer Bot | 1 | 0 | mcp:notion | 24 |
| `love` | Love ❤️ | Love ❤️ | 0 | 3 | mcp:google-calendar | 2 |
| `lumenbox-bridge` | LumenBox Bridge | LumenBox Bridge | 0 | 1 | — | 2 |
| `meeting-recap-deck` | Meeting Recap Deck | Meeting Recap Deck | 10 | 0 | mcp:figma, mcp:notion, mcp:slack, mcp:linear, mcp:gmail, mcp:google-calendar | 9 |
| `nightly-audit-engineer` | Nightly Audit Engineer | Nightly Audit Engineer | 0 | 1 | — | 7 |
| `office-ops-desk` | Office Ops Desk | Office Ops Desk | 10 | 0 | mcp:slack, mcp:notion, mcp:linear, mcp:gmail, mcp:google-calendar, mcp:google-sheets | 7 |
| `openseo` | OpenSEO | OpenSEO | 1 | 0 | browser | 2 |
| `outbound-prospecting` | Outbound Prospecting | Outbound Prospecting | 11 | 0 | mcp:slack, mcp:notion, mcp:linear, mcp:gmail, mcp:google-sheets | 9 |
| `overheard` | Overheard | Overheard | 0 | 1 | mcp:slack | 10 |
| `paid-media-report-desk` | Paid Media Report Desk | Paid Media Report Desk | 9 | 0 | mcp:slack, mcp:notion, mcp:linear, mcp:gmail, mcp:google-sheets | 10 |
| `pipeline-pulse` | Pipeline Pulse | Pipeline Pulse | 4 | 0 | mcp:gmail, mcp:slack, mcp:notion, mcp:google-sheets | 23 |
| `product-idea-stress-test` | Product Idea Stress Test | Product Idea Stress Test | 3 | 0 | — | 12 |
| `projects-manager` | Projects Manager | Projects Manager | 0 | 0 | mcp:notion, mcp:slack | 0 |
| `recruiting-coordinator` | Recruiting Coordinator | Recruiting Coordinator | 15 | 0 | mcp:slack, mcp:notion, mcp:linear, mcp:figma, mcp:gmail, mcp:google-calendar, mcp:google-sheets | 10 |
| `researchy` | Researchy | Researchy | 1 | 0 | — | 5 |
| `sales-call-coach` | Sales Call Coach | Sales Call Coach | 10 | 0 | mcp:notion, mcp:slack, mcp:linear, mcp:google-calendar | 8 |
| `seo-aeo-desk` | SEO & AEO Desk | SEO & AEO Desk | 10 | 0 | mcp:notion, mcp:slack, mcp:linear, mcp:google-sheets | 8 |
| `site-audit` | Site Audit | Site Audit | 0 | 2 | — | 1 |
| `stills-clips-desk` | Stills & Clips Desk | Stills & Clips Desk | 7 | 0 | mcp:slack, mcp:notion, mcp:figma, mcp:linear | 6 |
| `talent-discovery` | Talent Discovery | Talent Discovery | 11 | 0 | mcp:slack, mcp:notion, mcp:linear, mcp:figma, mcp:gmail, mcp:google-sheets | 10 |
| `tech-demos` | Tech Demos | Tech Demos | 1 | 1 | — | 9 |
| `tradbot` | Tradbot | Tradbot | 0 | 5 | mcp:gmail, mcp:google-calendar, mcp:slack | 9 |
| `video-edit-desk` | Video Edit Desk | Video Edit Desk | 7 | 0 | mcp:slack, mcp:notion, mcp:linear, mcp:figma | 7 |
| `webby` | Webby | Webby | 2 | 5 | — | 14 |
| `writing-bot` | Writing Bot | Writing Bot | 1 | 0 | — | 0 |
| `x-brief` | X Brief | X Brief | 8 | 0 | mcp:slack, mcp:notion, mcp:linear | 7 |
| `x-ops-expert` | X Ops Expert | X Ops Expert | 1 | 0 | mcp:x | 3 |
| `下载专家` | 下载专家 | 下载专家 | 3 | 0 | — | 1 |
| `推特运营方法论` | 推特运营方法论 | 推特运营方法论 | 1 | 0 | mcp:x | 3 |

## 目录里的 agent

| slug | 领域 | 名称 | 标题 | 简介 | 工具 | skill |
|---|---|---|---|---|---|---|
| `designer` | engineering | 设计 | 组队者 | Interviews you, proposes a small team with clear lanes, creates it on your yes, then stays quiet. | team | grill-me, deep-research |
| `lin` | engineering | Lin | 工程师 | Writes and verifies code; small changes by hand, large ones through a coding engine. | code | diagnose, fullstack-dev, grill-me, code-review |
| `heng` | engineering | Heng | 审查 | Reviews a change for correctness and security; writes the review, does not rewrite the repo. | 20 tools | code-review, diagnose, fullstack-dev |
| `mo` | product | Mo | 产品 | Turns a vague wish into a spec someone can build; does not implement it. | 22 tools | grill-me, market-researcher, deep-research |
| `jian` | media | Jian | 主笔 | Long-form writing a person will finish: articles, briefs, explainers. | web | khazix-writer, humanizer, wechat-longform |
| `he` | media | He | 种草 | Xiaohongshu-shaped notes: title, cover line, body, a few variants. | web | xiaohongshu-note, marketing-skills, humanizer, content-repurposer |
| `jing` | media | Jing | 编剧 | Spoken short-video scripts: hook, body, ask. Not footage. | desk | short-video-script, content-repurposer, humanizer |
| `xi` | data | Xi | 分析师 | Turns a table into sentences a person can act on, with sources on every number. | web | data-brief, minimax-xlsx, deep-research, market-researcher |

## 小队

| slug | 领域 | 名称 | 简介 | 成员 |
|---|---|---|---|---|
| `ship` | engineering | 研发小队 | Product specifies, engineering builds, review is a different person. | mo, lin, heng |
| `media-desk` | media | 内容小队 | One source, three forms: long article, Xiaohongshu note, short-video script. | jian, he, jing |

## 连接器

| slug | 名称 | 简介 | 在这里怎么存在 |
|---|---|---|---|
| `feishu` | 飞书 | The Feishu channel, plus reading cloud docs. | A configured Feishu bot receives and sends in groups. ReadFeishuDoc reads docx and wiki; sheets and bitables are not writable from here yet. Not a full office suite. |
| `dingtalk` | 钉钉 | The DingTalk channel. | A configured DingTalk bot receives and sends. Same shape as Feishu: a channel, not a CLI for every DingTalk product. |
| `browser` | 浏览器 | The box browser: open, click, read. | browser_* tools on the agent's desktop. No separate vendor login store; sites that need an account have to be signed in on that display. |
| `mcp` | MCP | External services attached as tools. | Named in config mcpServers. Unconfigured means none — the catalog does not invent GitHub, Notion or 1688. Adding a server is an operator act, not a specialist's. |
