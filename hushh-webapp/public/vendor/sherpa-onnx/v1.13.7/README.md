# Pinned sherpa-onnx browser runtime

This directory contains the reviewable JavaScript and WebAssembly runtime
assets from the sherpa-onnx `v1.13.7` English streaming ASR release.

Source release:
https://github.com/k2-fsa/sherpa-onnx/releases/tag/v1.13.7

The model data file is intentionally not present here. Agent One downloads it
as a signed, expiring model pack, verifies its SHA-256 checksum, and supplies
it to the Emscripten preloaded-package hook inside the worker. The base app
therefore ships runtime code but no ASR model weights.

Pinned SHA-256 values:

- `sherpa-onnx-asr.js`: `d51ae8e8b756ee5e53423ffada0c9702973f154f561aca7984fe0b12f4060178`
- `sherpa-onnx-wasm-main-asr.js`: `fd9e40cb7f871a94132fd722bde8a18aeb41a7e8cb95eee81a55b510e621c20a`
- `sherpa-onnx-wasm-main-asr.wasm`: `d0c15c3042fd61ca2a158a1eeb8b8c2099201f7580945efc8f729d2830cf746d`

The upstream project is Apache-2.0 licensed. Keep this notice with the
vendored files and review the upstream license before changing the pinned
release.
