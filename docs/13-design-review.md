# What goes to adversarial review before it is built

Written after a single day in which one decision — what identifies a conversation — was
implemented and revised three times, and the prompt's behavioural core four. The
information needed to get the first one right was available before the first attempt: the
SDK's own type declarations list `thread_id`, `root_id` and `parent_id` side by side, and
the question that would have settled it — *which of these does the opening message
carry?* — was never asked.

That is what a hostile review is for. Not to approve a design, but to ask the question the
author did not think to ask.

## The trigger

The day's commits split cleanly in two.

**Landed once and held:** the version handshake, upgrade preflight and volume backup,
image tagging and rollback, waiting for content to settle, the six browser fixes. Every
one of them has an observable success condition — does the box answer, does the backup
exist, did the page render, did the click land on the element.

**Revised three or four times:** what identifies a conversation, what the agent should be,
what "correct" means in a test, where a delivery is owed. Every one of them is a decision
about *meaning*, where being wrong looks exactly like being right until something downstream
behaves oddly.

So the trigger is not size and not risk in the usual sense. It is:

> **Does being wrong here still look correct?**

Concretely, a change needs review before it is built when it does any of:

1. **Defines or changes an identifier** — what a key is made of, what counts as the same
   thing twice. These end up in filenames, on disk, and in every later record.
2. **Changes a persisted format** — anything future processes must still read.
3. **Changes the prompt's structure**, as distinct from its wording. Adding a paragraph is
   wording; changing what arbitrates between paragraphs is structure.
4. **Changes what a test asserts is correct.** A grader that is wrong is worse than a
   missing one, because it is counted as coverage.
5. **Crosses a boundary between two components that each already work** — the failures
   this day produced were mostly here: the prompt naming a directory the server created
   elsewhere, an adapter recording an arrival the manager never settled.

Everything else — a bug with a reproduction, a mechanism with a success condition, a
performance fix that can be measured — is built and then measured. Reviewing those costs
more than it saves.

## What the review must be given

A review that receives only the proposed design will approve the proposed design. It gets:

- **The alternatives already rejected, and why.** Otherwise the review re-proposes them.
- **The revision history, if there is one.** "This is the third attempt, here are the
  first two and what broke them" is the single most useful thing a reviewer can have.
- **The blast radius.** Every place the decision is encoded, and which of them cannot be
  migrated afterwards.
- **A standing instruction to break it**, with concrete inputs. "Enumerate the message
  shapes this can receive and say what key each produces" found in one pass what three
  implementations had missed.

## What it is not

Not a gate on every change, and not a second opinion on taste. A reviewer that is asked
whether a design is good will say something; a reviewer asked *what input makes this
produce the wrong answer* will either find one or fail to, and both are informative.

And the review does not replace the measurement afterwards. Both of the prompt changes
that survived did so because a golden task failed before them and passed after. Review
catches what you did not think to ask; the suite catches what you were wrong about anyway.
