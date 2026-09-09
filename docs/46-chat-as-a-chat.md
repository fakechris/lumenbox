# 46 · The chat is a chat

*2026-09-09. Why the conversation read as a web page, and the three things every chat people
actually use has that it did not. Follows docs/40 and docs/41, which built the grammar; this is
about the surface.*

## The complaint, and why it was right

> 我们的是 web 样式，而且人和 agent 的样式几乎一样（实际不一样但是人眼看过去差不多，都是浅色一大片）

Exactly so. Both were pale rectangles of the same width, distinguished by a small uppercase
label. Telling who said something required *reading*. Every chat a person already uses answers
that before a word is read, with two devices and no third:

- **Side.** Mine on the right, theirs on the left.
- **Fill.** Mine is a filled bubble, theirs is not.

Codex and Grok Bot both do exactly this, and differ only in whether the agent gets a light bubble
(Grok) or plain text (Codex). Neither is subtle about the person's own words: a black filled
bubble, white text, right-aligned, hugging its content.

## What changed

**The person's message is filled and right.** Near-black in light mode, blue in dark, hugging its
content at 70% of the column. Their own words are now found by shape while scrolling past.

**The agent's is a light bubble on the left**, at 78%, with the corner nearest its side squared —
the detail that makes a bubble read as coming *from* somewhere. Teammates keep their colour bar
and get the same treatment.

**Bubbles hug, except where hugging is worse.** A message containing a code block or a table
widens to 94%: wrapping code to a chat width is the one place the reference designs give up on
bubbles too, and they are right to.

## Search

`Ctrl/Cmd+F`, or `search` in the header. Matches are marked **in place** and the thread scrolls
to each in turn — not filtered into a list of fragments, because a person searching a
conversation is looking for the *moment* something was said, and a list of fragments has thrown
away what makes it findable: what came before and after.

- **Who**: anyone / you / this agent / teammates / tool calls.
- **When**: any time / today / 7 days / 30 days.
- Enter and Shift+Enter step through; the count reads "3 of 17".
- A match inside a folded work step opens the fold, so it can be scrolled to at all.

Ours takes `Ctrl+F` from the browser deliberately: the browser's find cannot see into a closed
fold and cannot filter by who said it.

## Right-click

The menu people expect: copy text, copy as Markdown, quote in a reply, copy link, send again (on
your own messages), find messages like this. It shares one action list with the toolbar under the
message — a person who reaches for the second and finds fewer actions than the first has found a
bug, not a menu. With text selected the browser's own menu is left alone, because that one can
copy exactly what is selected.

## Not done

- **Search is this conversation only.** Across every agent and every thread is the obvious next
  one, and needs a server-side index rather than a walk of the DOM.
- **No jump-to-date.** "When" narrows, but there is no way to land on a particular day.
- **No unread mark** beyond the NEW divider, and no per-message reactions.
