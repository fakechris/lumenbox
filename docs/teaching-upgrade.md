# Teaching draft upgrade

Demonstrations now produce reviewable drafts rather than writing a skill during an
unrestricted model turn. This is a deliberate change to teaching for every user;
it does not require an external integration. An operator reviews the exact draft,
answers clarification questions where necessary, and explicitly publishes it.
Publication validates the captured box/agent/session identity and the reviewed
content digest. A changed draft requires a new review.

A recording captures its agent and optional task at start. Reassigning the display
later does not transfer authorship. Ending an old recording only stops that recording's
identity, never a newer capture on the same display.

Older pending recordings without a captured agent remain in the queue. They are not
automatically assigned to whoever currently occupies the display. Preserve/export
those recordings using the existing recording tools and start a new demonstration
with the intended agent; delete an obsolete recording only after deciding it is no
longer needed. This conservative compatibility behavior avoids silent attribution.

Task detail reads are restricted to the current assignee. Taking or reassigning an
already assigned task now requires its assignee, requester or reviewer. Unassigned
tasks remain available to take. This prevents a task participant from bypassing the
detail restriction by taking somebody else's task.

Tools omitted from an execution context are now also refused if a model nevertheless
requests them. Default profiles retain their existing offered tool set. Tool filtering
is not OS isolation: an allowed shell still has the permissions of its box process.
