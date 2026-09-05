# 37 — Getting started, every way in

What a person does on day one, path by path. The README says the short version; this is the
whole of it. Product name LumenBox; the command line still says `agentbox`.

## What you need

- **A Mac with Apple Silicon** for the app (0.2.0). An Intel build follows; Windows and Linux
  builds exist in the tooling but have not been produced or tested yet — say so if you want one.
- **A model key.** Any of the built-in providers (Anthropic, MiniMax, DeepSeek, Zhipu, Moonshot,
  OpenAI, and the OpenAI-compatible endpoints). One key is enough; the Settings page lists them.
- **A box** — one Linux computer the agents work in, with a desktop, a browser and a shell.
  Three ways to get one, below. You need at least one.

## 1. Install the app

Download `LumenBox-<version>-<arch>.dmg` from the
[releases page](https://github.com/fakechris/lumenbox/releases), open it, drag LumenBox to
Applications.

**The first launch on macOS.** The app is signed with a Developer ID but not notarized, so
Gatekeeper says it "cannot be checked for malicious software". Either right-click the app in
Applications and choose *Open* (once), or run in Terminal:

```
xattr -dr com.apple.quarantine /Applications/LumenBox.app
```

Then open it normally. It shows a window on `http://127.0.0.1:7777` and sits in the menu bar;
quitting the window keeps the box running.

## 2. First run: the two things it asks for

The Settings dialog opens by itself with a welcome note. It wants:

1. **A provider and a key.** Pick one, paste the key, Save. Keys live in
   `~/.agentbox/config.json`, readable only by you, never inside the box.
2. **A box.** The *Box* section shows whether one is running and offers to start one. Which of
   the three paths applies to you is the next section.

Everything else — agents, chat channels, skills — has defaults and can wait.

## 3. Getting a box

### 3a. Docker on this Mac (the default)

Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) or
[OrbStack](https://orbstack.dev/) and start it. Back in LumenBox Settings, press *Start the
box*: it pulls the image (a few minutes the first time), starts one container named
`agentbox-box`, and the page turns green when the desktop inside it is up. Nothing else to
configure; the box is only reachable from this machine.

If the button says *Cannot reach a Docker engine*, Docker is not running or not installed —
start it and press again. `docker version` in a terminal is the same check.

### 3b. Docker on another machine

If you keep Docker on a server (a NAS, a homelab box, a cloud VM), point the app at it the way
you would point `docker` itself: set `DOCKER_HOST` (for example
`ssh://you@server`) or make a `docker context` and select it, then start LumenBox. The box
runs there; the desktop is streamed to your app over that connection. The operator's guide
(docs/38, "Putting the box on another machine") has the details and the ports.

### 3c. A box somebody else runs — including a Grok Bot's

LumenBox can drive a box it did not start, as long as that box runs the LumenBox daemon and
you can reach it over a private network. Two cases:

- **A Grok Bot box.** Open the *LumenBox Bridge* template —
  https://x.ai/bot/U8xEPyVxQHL_JznVhVotB — and press *Add to Grok Bot*. The bot it creates
  prepares its own box: joins your Tailscale network (it sends you the login link), installs the
  daemon on a desktop of its own, and tells you exactly what to paste into LumenBox → Settings →
  Boxes → Attach. Nothing of the Grok bot's own desktop or files is touched. docs/35 is the whole
  story.
- **Any Linux machine you have a shell on.** Run the same installer there yourself:

  ```
  mkdir -p ~/.lumen/bin && curl -fsSL https://github.com/fakechris/lumenbox/releases/latest/download/lumen-bridge.sh -o ~/.lumen/bin/lumen-bridge.sh && chmod +x ~/.lumen/bin/lumen-bridge.sh
  ~/.lumen/bin/lumen-bridge.sh check
  ~/.lumen/bin/lumen-bridge.sh tailscale     # joins your tailnet with Tailscale SSH on
  ~/.lumen/bin/lumen-bridge.sh install       # daemon + a desktop at :10 + a token
  ~/.lumen/bin/lumen-bridge.sh connect-hint  # what to paste into LumenBox
  ```

  It needs Debian/Ubuntu with `apt`, `sudo` for the Tailscale install, and Node 22 on the box.

An attached box appears in Settings → Boxes beside the Docker one. Agents are created *into* a
box and stay there; each box keeps its own desktops, skills and memory.

## 4. Your first agent, your first message

The app ships a small starter team (Ada coordinates; Bob and Vic help). Type in the team room.
Ada replies first, then works — you can watch her desktop in the *Desktop* tab and take the
mouse yourself at any time. Ask for something real: "open the news site and summarise the
front page", "clone this repo and run the tests". A first-run cue tells each new agent to say
hello and ask one question.

## 5. Talking to it from a chat app

Settings → Channels connects Feishu (飞书) or DingTalk (钉钉): paste the app credentials from
that platform's developer console (docs/38 "Feishu app configuration" walks through the
console side). After that, a message in the chat is a message to the agent, replies come back
in the thread, files go both ways, and long jobs show a card that updates while they run.

## 6. When something is wrong

- **"It did not react to my message."** In a Feishu group, the reply is a thread under your
  message — collapsed until you open it. Look there first. If there is truly nothing, read
  `~/Library/Logs/LumenBox/server.log`: a `catch-up looked at …` line every five minutes means
  the channel is being checked; `replaying …` means a message the socket missed was picked up.

- **The page says the box is unavailable.** Settings → Box → Start; or `agentbox box up` in
  a terminal (the CLI is `dist/cli.js` inside the app bundle, or `npm run agentbox --` from a
  checkout).
- **Docker is fine but the desktop never comes up.** `agentbox box doctor` prints what the
  container sees; docs/38 §5.2.
- **The agent says it has no key.** Settings → provider; keys are per installation, and a
  restart applies them.
- **An attached box went away.** It has to be reachable on the network you attached it over
  (Tailscale, a tunnel); Settings → Boxes shows the last error. A Grok box after a reboot:
  tell the bot "把 LumenBox 桥拉起来".

## 7. Uninstalling

Quit the app; `docker rm -f agentbox-box` and `docker volume rm agentbox-work agentbox-home`
if you want the box's files gone; delete `/Applications/LumenBox.app` and `~/.agentbox` (the
configuration, transcripts and memory — that is the part you might want to keep).
