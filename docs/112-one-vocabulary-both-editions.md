<!-- doc: 112-one-vocabulary-both-editions
     title: One vocabulary and one first screen for the personal and the organisation editions
     family: decision
     status: current
     updated: 2026-11-29
-->
# One vocabulary and one first screen for the personal and the organisation editions

Decided with Chris on 2026-11-29, after the first Admin of an organisation on Kubernetes opened
the page and met three things the screen could not explain. The words are recorded in
`docs/glossary.md` (the vocabulary's owner); this page says why, and what the first screen does.

## 1. What went wrong

1. **A shared box that cannot start.** Every installation has one box of its own. On the
   desktop it is the Docker container on this Mac. On a Kubernetes organisation it is never
   started: the server refuses (`err.shared-box-kubernetes`). On the first page load the
   installation still made the four-agent starter team in that box. The sidebar showed
   "Shared box" with a red sentence about an organisation node, and every agent listed under it
   could not work.
2. **A getting-started list that leads to a refusal.** The list was the desktop's. "Give the
   agents a computer · Offline · Set it up" opened Settings → Computers, which repeated the
   refusal. The Admin's own personal box was already running, but the sidebar hides the box
   switcher when there is one box, so it was not on the screen.
3. **One word, two meanings; one thing, five words.**
   - 成员 named an agent in the Chinese page ("给成员一台电脑", "添加第一个成员", the sidebar's
     heading) and a person in the organisation ("激活成员", member quotas).
   - The same thing was box, Box, 盒子, 电脑 and 机器: 111, 23, 3 and 6 uses in the page's words.
   - "Shared box" meant the Owner's only box on the desktop — which nobody shares — and a box
     for several people in an organisation.
   - "Personal box" existed only in the organisation, although the desktop's box is personal too.

## 2. The words (ASD-STE100: one word, one meaning; one meaning, one word)

| Concept | English | 中文 | Same meaning in both editions |
|---|---|---|---|
| The isolated machine an agent works in | **sandbox** | **沙盒** | Yes. The desktop's runs in Docker on this Mac; the organisation's on its cluster or a VM. The word says what it is, not where it runs. |
| The sandbox that is one person's | **your sandbox** | **你的沙盒** | Yes. The desktop's only sandbox; an organisation member's own. |
| A sandbox several people use | **team sandbox** | **团队沙盒** | Shown only when one exists (organisation, later: INV-1693). |
| An AI that does work | **agent** | **智能体** | Yes. |
| A person in an organisation | **member** | **成员** | Only a person, never an agent. |
| This computer itself, with no sandbox (the native environment) | **this computer** | **本机** | Reserved; not a sandbox, so never called one. |

*Computer* (电脑) and *cloud host* (云主机) were considered and refused: 电脑 collides with this
computer and with a future native environment; 云主机 is wrong for the desktop's sandbox, which
is not in a cloud. *Box* stays in the code, the specs and the CLI (`agentbox box …`); a person
reads *sandbox*.

## 3. Rules for every screen

1. **Show only what can happen here.** A sandbox this installation cannot run is not listed; a
   step that cannot be done here is not on the list.
2. **A button does the thing, or opens the exact place where it is done.** A button never leads
   to a page that refuses.
3. **State words are four:** preparing (准备中), ready (可用), stopped (已停止), failed (出错), and
   *failed* always says why and what to press.
4. **A member's words contain no internal word:** not Kubernetes, backend, pod, node, Box,
   container, image. An Admin's technical detail may name them, on Settings pages only.
5. **One sentence says one thing**, in the active voice, in 20 words or fewer (glossary rule 10
   is 25; the first screen holds itself to 20).

## 4. The first screen

**The sidebar** opens with the person's sandbox as a heading, with its state: "Your sandbox ·
Ready". The agents in it are listed under it. A person with access to more than one sandbox
sees each as a heading; nobody sees a sandbox they cannot use or that cannot run here. There is
no red sentence about what the installation cannot do.

**Getting started** is computed from the person's state, the same list in both editions:

| Step | Shown when | What the person sees |
|---|---|---|
| Model | No model is set | Owner or Admin: "Choose a model" → Settings → Model. A member: "Your Admin has not chosen a model yet." No button. |
| Your sandbox | Always, until ready once | Preparing: progress, no button. Failed: the reason and "Try again". Desktop, not started: "Start it". Ready: a tick. |
| Your agent | Always, until opened once | "Talk to <name>" opens the conversation. |
| Chat channel | Optional | Owner or Admin: "Connect DingTalk or Feishu" → Settings → Channels. |

**An organisation's setup** is the Admin's, and is not on this list: Settings → Organisation
shows the channel app, the public address, and "Activate members", each with its state.

## 5. What changes in the product

1. An organisation whose sandboxes run on Kubernetes has no installation sandbox and no starter
   team. The first Admin is a member like the others: their sandbox and their agent are made
   at their first sign-in (docs/109). The desktop keeps one sandbox and its starter team.
2. The sidebar and the getting-started list follow §3 and §4 in both editions.
3. Every word on the page, in both languages, the manual and the release notes follows §2. The
   glossary's deprecated list grows by the old words as each page is converted, so `npm test`
   keeps them out after.

## 6. Not decided here

The team sandbox's design (INV-1693); the native environment's screens.
