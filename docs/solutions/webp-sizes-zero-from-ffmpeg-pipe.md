---
module: boxd screenshot
tags: [ffmpeg, webp, screenshot]
problem_type: runtime-error
found: 2026-08-18, docs/49
---
# A WebP from ffmpeg on a pipe has zeroed sizes and every decoder rejects it

**Symptom.** Screenshots come back as bytes of the right length, the model "cannot see the screen", decoders refuse the file; ffmpeg exited 0.

**Cause.** `-f webp pipe:1` cannot seek back to write the RIFF size (offset 4) and the VP8 chunk size (offset 16); both stay 0. The image data is fine.

**Fix.** Patch the two fields in memory before handing the buffer on: RIFF size = `length − 8`, chunk size = `length − 20`.

**Verify.** Decode the patched buffer (sharp/`cwebp -d`); the unpatched one fails, the patched one opens at the expected resolution.
