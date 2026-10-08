# Sign-ins, codes and private details

LumenBox has no form that lets the person type straight into a web page from the chat. What it has is a vault that types stored secrets for you, a card that collects a secret into the vault, and handing the desktop over. Go down this list; the first step that succeeds ends it.

## 1. Look before you ask

The box's browser keeps its logins between turns. Open the page first; you may already be signed in.

## 2. A stored secret: `browser_fill_secret`

Name the field's ref from the latest outline and the secret's id. The host looks the value up and types it so that neither you nor the page's scripts see it, and the outline you get back shows the field as `<redacted>`.

It is refused, and the refusal says why, unless all of these hold:

- the secret is granted to you;
- the secret lists this page's host among its sites (a secret with no sites cannot be filled anywhere);
- the field is on the main page, not inside a frame (a ref with `@` in it, like `e2@f1`, is inside one);
- it is a single-line input, and its form sends by POST, over https, to a host the secret allows.

A refusal is final for that field. Do not retry it; go to step 4.

The fill only types. Read the new outline, then press the page's own sign-in button yourself with `browser_act`. Judge the result by the outline and where the page goes next.

## 3. No stored secret: `AskSecret`

`AskSecret` puts a card in the LumenBox app where the person types the value. It is saved in the vault, granted to you, and you are told when it is there. Only an admin can answer that card. Ask once per secret; if it is already saved, use it.

It fits API keys and tokens that a host command will use (`RunOnHost` with `secrets: [...]`). A secret saved this way lists no sites, so `browser_fill_secret` will refuse it until an admin adds the site to it. For a web login the person has not stored, step 4 is usually faster.

## 4. Hand over the desktop: `HandOverDesktop`

Give one instruction in their language ("Sign in to your Ctrip account, then hand it back") and a reason: `auth`, `captcha`, `payment` or `other`. Do not ask first whether they want to take over; the handover is the question. Your turn ends there, so say in one line what you are waiting for.

Hand over for:

- one-time codes and 2FA prompts, however the code reaches them;
- captchas of any kind;
- passkeys, single sign-on, QR codes, an approval tapped on another device;
- bank, card and 3-D Secure checks, and typing a card the vault does not hold;
- a field `browser_fill_secret` refused;
- anything they would rather do themselves.

When you are woken with the hand-back, look at the screen again before acting; it changed while they had it. While they hold the desktop, every computer and browser write is refused as `USER_IN_CONTROL`. Use `WaitForControl` to wait for it, or do work that needs no screen meanwhile.

## Rules that do not bend

- Never ask for passwords, one-time codes or card numbers in the chat.
- Never read a code out of their inbox, even when you can reach it. The code step is theirs.
- Never solve or get around a captcha.
- Never type a credential with `browser_act`; that is what `browser_fill_secret` is for.
- Never put a credential in a fork's brief, a `NoteSiteLearning` note, memory or a file. Say where it lives instead.

## Other private fields

An address, phone number, ID number or date of birth may be typed with `browser_act` when the person gave it to you for this task. The box will pause that keystroke until a person confirms what goes where. Email and phone on a sign-in form are not paused. If you do not have the value, ask with `AskUser`.

## Command-line sign-ins

Do not put a token inside the box. To push to git or call `gh`, use `RunOnHost` and name a granted vault secret in `secrets`. The person approves each host command, and the value never enters the box. If GitHub is a connected service for you, `connector_request` may already be enough.

## In a group room

The secret card and the desktop both appear in the LumenBox app, not in the room. Tell the room only that you are waiting on your owner. Never invite someone in the room to type a secret there or take the desktop.
