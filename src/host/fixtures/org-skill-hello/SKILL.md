---
name: Hello tool
description: Use when the person asks who they are signed in as at Hello, or for anything the hello command line does.
install: sh scripts/install.sh
installed: test -x "$LUMENBOX_WORK/.tools/bin/hello"
sign_in: Hello
sign_in_start: "$LUMENBOX_WORK/.tools/bin/hello" login
signed_in: test -s "$LUMENBOX_WORK/.tools/hello/session"
---

# Hello tool

An example of a skill that brings its own tool (INV-2222, docs/93 §2a). `hello` is a small
command-line program that works only once its person has signed in.

## Using it

Run `$LUMENBOX_WORK/.tools/bin/hello whoami`. If it says "not signed in", the person has to sign
in first (below); do not go on without it.

## Installing

`sh scripts/install.sh`, in this directory. It puts the program in the work volume
(`$LUMENBOX_WORK/.tools/bin`), which an image update keeps. It installs nothing with the
system's package manager and needs no sudo.

## Signing in

The sign-in is the person's. Run `$LUMENBOX_WORK/.tools/bin/hello login`: it prints an address
and a one-time code. Give both to the person in the conversation and wait; they open the address
on their own device and enter the code there. Never ask for their password and never type one.
What it stores is in `$LUMENBOX_WORK/.tools/hello/`, in the work volume too.
