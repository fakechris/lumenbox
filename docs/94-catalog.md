<!-- doc: 94-catalog
     title: The catalog: experts, crews, connectors and shelf templates
     family: spec
     status: current
     domain: catalog
     updated: 2026-11-05
-->
# The catalog: experts, crews, connectors and shelf templates

This is the one home of what the catalog is. The rows are `src/host/catalog.ts` and the files
beside it in `src/host/catalog-data/`; the format they install through is `src/host/template.ts`
(`TEMPLATE_FORMAT = "lumenbox-template/1"`, docs/29). Where this page and the code disagree,
the code is right and this page is the bug.

## 1. What the catalog is

**The catalog is the first-party shelf**: the agents LumenBox ships ready to install, and
honest statements of what it can connect to. It is data, not machinery — a catalog row is
installed the way any template is, so there is one pipeline for our bots and everyone
else's (docs/29 §6).

- **Installable, not seeded.** A fresh box starts with the starter team of four
  (`orchestrator.ts`); catalog rows are added only when someone asks. An existing roster is
  never touched.
- **Personas are ours; skill packages are copied.** An expert's persona is rewritten as
  standing identity — no identity theatre, no invented KPIs, no frozen tool names. The skill
  packages it is written to use are standard skill-hub packages, copied as-is
  (`catalog-data/SOURCE.md`).

## 2. The four kinds of entry

| kind | defined in | what it is |
|---|---|---|
| **expert** | `CATALOG_EXPERTS`; persona text in `catalog-data/experts/<slug>.md` | One standing persona: `slug`, `domain` (`engineering`, `media`, `data`, `product`), `name`, `title`, `summary` (one line for menus and `CreateAgent`), `description` (the persona, re-read every turn), `tools` (a tool tier) and `skills` (the skills the persona's routing table says when to read). |
| **crew** | `CATALOG_CREWS` | Several experts, not one persona wearing many hats: `slug`, `domain`, `name`, `summary`, and `members` — expert slugs in the order they are added. Installing a crew installs each member. |
| **connector** | `CATALOG_CONNECTORS` | Not an install — a statement of how an outside system exists here: `slug`, `name`, `summary`, and `how`, which is honest about the missing halves. A template names the connectors its work needs by these slugs (`feishu`, `dingtalk`, `browser`, `mcp:<server>`). |
| **shelf template** | `shelfTemplates()` reads `catalog-data/templates/*.lumenbox-template.json` | A whole working bot in the template format: persona, memory, skills with their full `SKILL.md`, routines, connectors. This is what a person means by "a template". |

**Tool tiers.** `DESK_TOOLS` (files, tasks, memory, teammates, the box's MCP services),
`WEB_TOOLS` (desk plus the browser and web search), `CODE_TOOLS` (desk plus `Delegate`) and
`TEAM_TOOLS` (desk plus creating and adjusting agents). A new agent's tools are the row's tier
cut down to what its creator holds (`intersectTools`); an expert never gets more than the
agent or person who installed it.

**Skills an expert names are not bound to it.** The hub packages are seeded globally into
every box (docs/93 §3), so an expert's `skills` list is what its persona routes to, not a
grant. That is also why `catalogTemplate(expert)` names no skills.

## 3. How an entry is installed and read

- **`GET /api/catalog`** returns `{ experts, crews, connectors }`: each expert with `slug`,
  `domain`, `name`, `title`, `summary`, `description`, `tools`, `skills`; each crew with
  `slug`, `domain`, `name`, `summary` and `members` as `{ slug, name, title }`; the connectors
  as defined.
- **`POST /api/catalog/install`** `{ slug, boxId? }` installs one expert or every member of a
  crew (`profilesFor`), skipping — and naming — any whose name is already taken in that box.
  Answers `{ slug, created, skipped }`; an unknown slug is a 404.
- **`GET /api/catalog/template?slug=`** downloads an expert as a `lumenbox-template/1` file:
  `catalogTemplate(expert)` — the profile and the tool tier, with no memory, skills, routines
  or connectors to install. A person can hand that file to another installation.
- **`GET /api/templates/shelf`** lists everything a person can stamp into a box in one list:
  their own staged templates, imported ones, `catalog` (experts and crews) and `marketplace`
  (the shelf templates). **`POST /api/templates/stamp`** stamps one, with `catalogSlug` or
  `templateSlug` (or a staged version of an agent's own).
- **`CreateAgent` with `from: <slug>`** is the agent's way in; `catalogMenu()` is the menu its
  tool description carries, and agents are told to prefer a catalog row over inventing a
  similar persona.

Every install goes through `importTemplate`, so the new agent's profile says where it came from
(`importedFrom`: `catalog:<slug>` for an expert, `shelf:<slug>` for a shelf template) and its
first turn is the same template setup turn any imported bot gets (docs/29).
