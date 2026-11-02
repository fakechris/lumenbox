---
module: box image
tags: [chromium, at-spi, accessibility, list_elements, trixie]
problem_type: runtime-error
found: 2026-11-01, INV-1482 (fixed in INV-1494)
---
# Chromium 156 on trixie is not on the accessibility bus with `--force-renderer-accessibility` alone

**Symptom.** A page opened with `box-chrome` is on screen, but `box-ax` says "the active window exposes no accessibility tree", and `list_elements` falls back to "Work from the screenshot" on every web page. Other apps on the same desktop, such as thunar, read fine.

**Cause.** `--force-renderer-accessibility` makes the renderer build its tree, but Chromium 156 on Debian 13 no longer registers with AT-SPI because of that flag. Registering takes `ACCESSIBILITY_ENABLED=1` in its environment. The flag alone was enough for older Chromium, which is why the box worked until the trixie image.

**Fix.** `docker/box/box-chrome` exports `ACCESSIBILITY_ENABLED=1` before it starts the browser, and keeps the flag. The change lives in the image: rebuild it, never patch a running box.

**Verify.** On a box built from the image, `npm run smoke` passes "a page opened with box-chrome has a control tree". By hand: `box-chrome file:///tmp/page.html`, then `box-ax` lists the page's entry and push button.
