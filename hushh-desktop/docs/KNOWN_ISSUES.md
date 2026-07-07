# Hushh Desktop — Known Issues & Limitations

A living record of known bugs, limitations, and deliberate trade-offs in the
`hushh-desktop` sub-project. Kept honest on purpose — if something isn't solved,
it's listed here rather than implied to work.

**Scope:** `hushh-desktop/` only. **Target platform:** Windows 11 ARM64 (Snapdragon).
**Last reviewed:** Beta v1.0 (built from `b7d56e4a6`).

Severity legend: 🔴 blocker for wider distribution · 🟠 significant · 🟡 minor / cosmetic · 🔵 known trade-off (by design)

---

## 🔴 Security / distribution

### Secrets are shipped inside the installer
`package.json` `build.files` bundles `backend/.env` and `frontend/.env*` into
every packaged copy, and `asar: false` leaves them as plaintext files on disk
under `resources/app/`. `backend/.env` contains live credentials (DB password,
Firebase admin, Google/Vertex keys, Alpaca/Plaid/Gmail secrets, vault & signing
keys).

- **Impact:** Anyone with a copy of the build can read production secrets. This
  is why the executable is **not** shared publicly.
- **Acceptable only** for solo/internal review builds on trusted machines.
- **Planned fix (deferred):** split into a thin local orchestration service
  (talks only to GenieX on `localhost`, holds no secrets) plus a remotely-hosted
  backend that owns all sensitive integrations. GenieX is `localhost`-bound, so
  the on-device orchestration must stay local — this has to be a split, not a
  lift-and-shift.

---

## 🟠 On-device AI (GenieX / NPU)

### Superseded: switched runtime from QAIRT/NPU (Qwen3-4B) to llama.cpp (Llama-3.2-1B)
Everything below this note describes the original QAIRT-native setup and the
RAM-sensitivity/crash saga around it. That work is kept for history, but the
actual served model changed this session:

- **Why:** the on-device goal is local-only inference, not NPU-exclusivity.
  QAIRT context binaries are compiled ahead-of-time for one target backend
  (HTP/NPU only) with no runtime CPU/GPU fallback and no smaller
  genuinely-QAIRT-compatible model available (Qualcomm AI Hub's smaller Qwen3
  sizes, and Qwen3.5, are llama.cpp-runtime only; the only smaller
  QAIRT-native options are Llama-3.2-1B/3B, which are gated + require a local
  export using host tooling that has no aarch64 Linux build, blocking it on
  this machine). GenieX's own CLI (`geniex infer --compute cpu|gpu|npu|hybrid`)
  already supports a llama.cpp runtime internally, so this was a model/config
  swap, not a new tool.
- **Model:** `unsloth/Llama-3.2-1B-Instruct-GGUF:Q4_0`, ~773MB resident
  (previously `unsloth/Llama-3.2-3B-Instruct-GGUF`, ~1.9GB; before that
  `qualcomm/qwen3_4b_instruct_2507` QAIRT, ~3.2GB). Chosen after a direct
  side-by-side this session: 1B measured 56.2 tok/s vs 3B's 24.5 tok/s
  (hybrid compute) at less than half the resident size, with comparable
  general reasoning quality on a real test prompt.
- **RAM/crash picture changes fundamentally:** no more QAIRT memory-mapping/
  paging behavior, no more `0xc0000005` native crashes observed with this
  runtime (though not exhaustively tested). `MIN_FREE_RAM_BYTES` and the
  working-set pin in `registry.js` are scaled down proportionally to this
  model's much smaller footprint, but — unlike the old model's exhaustively
  measured 0.78-vs-16 tok/s RAM curve — these new thresholds are a
  conservative scale-down from one spot-check, not an exhaustively
  characterized cliff.
- **One real quality gap found and fixed:** the 1B model's tool-calling
  sometimes echoes the tool's own JSON-schema shape into its arguments (e.g.
  `{"parameters": {"properties": {"location": "Paris"}}}` instead of
  `{"location": "Paris"}`) — a failure mode the 3B model didn't show.
  `local_bridge/tool_calling.py`'s `_unwrap_schema_echo` now detects and
  unwraps that one specific pattern; live-tested end-to-end afterward
  (`open_app_surface` with `{"surface": "consent_center"}`) with a
  correctly-shaped result.
- **Not yet done:** the sections below (RAM-sensitivity curve, QAIRT crash
  recovery, bridge streaming/tool-calling validation) all predate this switch
  and describe the old model's behavior specifically. They haven't been
  re-validated against the new runtime beyond the spot-checks noted above.
- **First live run through the actual Electron app (not just manual
  `geniex serve`/bridge processes) confirmed real completions succeeding**
  (GenieX GIN log: 24.3s, 11.0s, 5.5s, 7.1s, 8.7s for real chat turns) — but
  also caught the tool-calling path's 15s (bridge) / 20s (client) timeout,
  retuned in the section below for the old QAIRT crash profile, now clipping
  *healthy* in-flight completions on this runtime (one call was still given
  up on at 15s when GenieX itself logged its 200 at 24.3s). **Retuned to
  40s (bridge) / 45s (client)** to match this runtime's actual 5-25s range
  instead of the old model's "it's either fast or hung for minutes" profile.
  The 90s/100s→15s/20s saga documented below is now itself superseded by
  this same reasoning, one runtime later.
- **3B live A/B test, reverted:** tried switching the served model from 1B to
  3B (`unsloth/Llama-3.2-3B-Instruct-GGUF`) to fix the 1B's tendency to
  deflect open-ended opinion questions into reflective paraphrasing instead
  of answering. Reverted after live testing found worse problems instead:
  no reliable sub-minute turn latency (measured 39s-2min GenieX time
  depending on reply length), and confidently WRONG multi-step arithmetic
  (a compounding-interest question came back $57,320 vs a real answer of
  ~$33-35k, with fabricated step-by-step math that contradicted its own
  stated formulas). Also tried merging the action-plan and reply-generation
  calls into one (full context + tools + real generation settings, single
  call) specifically to cut 3B's latency — reverted too: short turns got
  faster (~39s) but longer/reasoning-heavy turns got WORSE, since a
  timed-out merged call still paid for a full separate stream_response()
  fallback afterward (measured one turn at ~2 minutes total). Both the model
  swap and the merge are fully reverted; `agent_chat_service.py` and
  `registry.js` are back to the 1B model with the original separate
  action-plan/reply-generation calls.
- **1B also hallucinates on the same math, differently:** direct testing via
  `geniex infer` (outside the app) confirmed this isn't 3B-specific. The 1B
  handles small single-step arithmetic correctly (15+27, 340-128 both
  right), but gets larger numbers wrong (847+2,356 answered as 5,702, actual
  3,203) and produces self-contradictory multi-step math on the same
  compounding question (three different intermediate "totals" within one
  response, none of which agreed with each other). It did *not* fabricate a
  specific stock price when asked for one it couldn't know, appropriately
  redirecting to real data sources instead — so the failure is specifically
  multi-step/large-number calculation, not blanket hallucination. Added a
  local-mode-only system-prompt guardrail (`_build_local_bridge_messages` in
  `agent_chat_service.py`) instructing the model to give only a rough,
  clearly-labeled estimate for multi-step financial math and redirect the
  user to a calculator or Kai's Portfolio/Analysis tools instead of
  presenting a fabricated precise figure as fact.

### Switched again: llama.cpp (Llama-3.2-1B) to llama.cpp (Qwen3.5-2B)
Same-session follow-up: ran a live four-way comparison (1B, 3B, Phi-4-mini,
Qwen3.5-2B) on the same arithmetic/compounding/hallucination battery used
above, via direct `geniex infer`/`geniex serve` testing outside the app.

- **Why switch again:** Qwen3.5-2B was the most internally-coherent reasoner
  of the four — on the 3-year compounding test, it got the lump-sum
  component exactly right and made one identifiable formula-substitution
  error on the annuity component (landing ~53% low), versus 1B's
  self-contradictory intermediate totals or 3B's ~70%-high fabrication. Only
  Phi-4-mini got a compounding test fully correct end-to-end, but was
  0-for-3 on trivial single-step addition in the same session (e.g. answered
  "8439" for 847+2,356) — an unreliable enough basic-arithmetic pattern to
  rule it out despite the one strong result.
- **Real RAM cost is higher than it looks on paper:** HuggingFace's own file
  listing implies ~1.13GiB for the Q4_0 GGUF, but the actual cached weight
  size after pulling is **2.4GiB** — larger than the 3B's 1.9GB, not smaller.
  `MIN_FREE_RAM_BYTES`/working-set constants in `registry.js` are scaled
  proportionally from the 1B's confirmed ratios onto this real 2.4GiB figure
  (~4.8GB free-RAM gate), not independently spot-tested at that floor.
- **GenieX misdetects this repo as a "vlm" (vision-language model)** despite
  it being text-only, which is fatal for a persistent server: the first
  request to `geniex serve` always succeeds, every request after it fails
  with `SDKError(Multimodal generation failed)` — confirmed reproducible on
  a clean process, twice, unrelated to any specific input. Invisible in
  one-shot `geniex infer` testing since each invocation is a fresh session.
  **Fixed** by pulling with `--model-type llm` (`registry.js`'s
  `GENIEX_MODEL_TYPE`), which forces correct detection.
- **Thinking mode is on by default, with no reliable request-level
  control:** this checkpoint emits a genuine `<think>...</think>` reasoning
  trace via the plain `/v1/chat/completions` API with no special flag
  needed — good, since "thinking enabled" was the ask. But there's no
  confirmed way to *disable* it per-request: passing `"think": false` in the
  JSON body throws `SDKError(Multimodal generation failed)`, and the Qwen
  `/no_think` suffix convention isn't honored — it instead triggered a
  **2,000+ token runaway repetition loop** ("Wait, I should check if I
  should say X... Okay, I will say X...") that never reached a clean answer
  and was hard-truncated by `context_length_exceeded`. Don't attempt either
  workaround; both request/reply-generation payloads now budget generously
  (`max_completion_tokens` 700/1200 — see next finding) to give the
  always-on thinking trace room to complete instead.
- **Separately, and more broadly: `max_tokens` is silently ignored by this
  GenieX install's HTTP API.** The GenieX docs themselves show `max_tokens`
  as the correct field, but confirmed via direct testing (both raw GenieX
  on :18181 and through `local_bridge` on :18182, the app's actual code
  path) that a request capped at `max_tokens: 256` came back with 1,258
  completion tokens — and this reproduced on the **currently-shipping 1B
  model**, not just Qwen3.5-2B. `max_completion_tokens` is the field that's
  actually honored. This was silently in effect for the entire session's
  worth of latency investigation into "why do some calls take 5s and others
  90s+" — an uncapped generation length is a more direct explanation than
  the prefill-cost theory pursued earlier, and probably deserves more
  credit for that variance than anything else found this session. **Fixed**
  in both `agent_chat_service.py` payloads (`stream_response`:
  `max_completion_tokens: 1200`; `_plan_action_via_bridge`:
  `max_completion_tokens: 700`, up from 200 specifically to give the
  always-on thinking trace room before the tool-call output).
- **Timeouts bumped alongside the token-budget change:** `local_bridge`'s
  tools-calling internal timeout 40s→60s, `_plan_action_via_bridge`'s client
  timeout 45s→70s — sized for a real 700-token completion at this model's
  observed 27-29 tok/s (~25s) plus GenieX's single-request-lock queuing.
- **Not yet live-tested in the actual Electron app** — all of the above was
  validated via direct `geniex infer`/`geniex serve` calls and manual curl
  against the bridge, per a standing instruction this session to keep the
  app itself stopped. Should be smoke-tested end-to-end (a plain chat turn,
  a PKM-add turn, and a math question) the next time the app is run.

### Real Hermes Agent round-trip test: hard context-window incompatibility (by design, not a bug)
Directly tested this session: pointed a real, locally-installed `hermes-agent`
CLI at the bridge (`http://localhost:18182/v1`, `provider: custom`) instead
of its default cloud provider, to validate the actual claim that this local
adapter can serve as a backend behind the Hermes/One runtime boundary.

- **Result: Hermes refuses to run at all.** Exact error: `"Model ... has a
  context window of 4,096 tokens, which is below the minimum 64,000 required
  by Hermes Agent. Choose a model with at least 64K context."` This is a
  hard-coded floor in Hermes Agent itself, not a bridge bug or a config
  issue — confirmed by first fixing two other real, separate problems along
  the way:
  1. Hermes's default toolset (40+ tools) alone blew GenieX's 4096-token
     context 5x over (19,142 prompt tokens) on a trivial prompt — the exact
     risk flagged as unresolved when the bridge's tool-schema-trimming was
     originally deferred. Reducing to one minimal toolset (`-t clarify`) got
     it to 2,782 tokens, still comfortably under 4096.
  2. Even then, it still overflowed — because the bridge doesn't expose
     GenieX's real context size via `/v1/models`, Hermes auto-detected (and
     over-assumed) a much larger window than 4096 and budgeted its own
     output request accordingly. Setting `model.context_length: 4096`
     explicitly in Hermes's config (a real, documented field for exactly
     this case) is what surfaced the true 64K-minimum refusal above, instead
     of a softer overflow error.
- **Why this doesn't actually contradict the "align with One/Hermes, don't
  build a parallel stack" direction:** the test as run asked whether
  Hermes's own generalist agent loop (long context, 40+ tools, the full CLI
  product) could run entirely on top of a 4096-context on-device model —
  that was never the right shape for on-device inference to begin with.
  Hermes is explicitly built to delegate (`Task Delegation` is one of its
  own built-in toolsets), and the on-device-inference direction elsewhere
  describes exactly this pattern: narrow, fast, local, single-purpose tasks
  (intent classification, privacy-rule gating), not a full agent loop. The
  correct integration shape is Hermes's main loop staying on a real
  large-context model and **delegating** specific narrow steps — intent
  routing, PKM capture — to this bridge, which is the scope
  `local_role_scope` (`_build_local_bridge_messages` in
  `agent_chat_service.py`) already narrows this model to, and is now
  documented there as the deliberate architectural role, not just a
  quality-driven workaround.
- **Test config was fully reverted** — Hermes's `config.yaml` is back to its
  original cloud (Nous) provider; nothing about this test is left live.
- **Still open:** whether GenieX's context window can be raised at all under
  `geniex serve` (no `--nctx`-equivalent flag is exposed there, unlike
  `geniex infer`) hasn't been investigated — moot for the delegate framing
  above, but would matter if a future need called for a larger on-device
  context.

### RAM gate corrected from a scaled guess to a real measured curve
The `MIN_FREE_RAM_BYTES` figure above (4.8GB, scaled from the 1B's own
ratio) was never independently validated for Qwen3.5-2B, and turned out to
be dramatically over-conservative — caught live when a real smoke test's
GenieX spawn was refused at 4.3GB free, well above what the model actually
needs.

- **Real curve, measured via controlled memory pressure** (a small allocator
  touching every page to force genuine physical commit, not just reserved
  virtual memory, at each target free-RAM level): tok/s held flat at
  23.1–26.7 across every level from 4.27GB down to 0.56GB free (including a
  full 2000-token generation, not just short completions). The first real
  degradation — 23→17 tok/s, ~27% — only appeared at 0.49GB free. The
  actual cliff sits between 0.56GB and 0.49GB.
- **This model does not share the old QAIRT Qwen3-4B's RAM-paging profile.**
  That model degraded gradually starting well above 5GB free (20x collapse
  by 1.3GB). Qwen3.5-2B on llama.cpp shows no gradual decline at all — flat
  performance right up to near-total system memory exhaustion — almost
  certainly because plain memory-mapped GGUF weights behave very
  differently under pressure than QAIRT's compiled NPU context binaries.
- **Fixed:** `MIN_FREE_RAM_BYTES` lowered from 4.8GB to 1GB (real headroom
  above the measured 0.49GB cliff, without needlessly refusing to spawn
  under conditions that actually perform fine). `GENIEX_MIN_WORKING_SET_BYTES`
  /`GENIEX_MAX_WORKING_SET_BYTES` set to 2.75GB/4GB — sized to the model's
  real 2.4GiB weight footprint plus overhead, no longer scaled from the 1B's
  ratio, since that ratio doesn't track this model's actual resilience.
- **Caveat:** this is one real curve on one device, not an exhaustively
  characterized floor across hardware. Re-measure if this model or the
  GenieX version changes.
- **Superseded below: Qwen3.5-2B itself was reverted** after live in-app
  testing (not just the isolated CLI/RAM-curve work above) surfaced a worse
  problem than any RAM tuning could fix. The RAM-curve methodology and the
  `max_completion_tokens` fix both remain valid and are kept; the model
  choice specifically rolled back to the 1B.

### Qwen3.5-2B reverted: live in-app testing broke the classifier and produced incoherent replies
Everything above this note (the four-way model comparison, the vlm-crash
fix, the thinking-mode findings, the RAM curve) was validated via isolated
CLI/curl calls, per the standing instruction to keep the app itself stopped
for most of this session. Once that hold was lifted and the swap was
actually smoke-tested live in the running Electron app, it broke in ways
the isolated tests didn't surface:

- **The action-plan classifier call fails on nearly every turn.** Directly
  reproduced with a minimal, isolated repro of the exact same payload the
  app sends: even with `max_completion_tokens` set to a bare minimum of 5,
  GenieX still returned `context_length_exceeded` at only **1,858 prompt
  tokens** — nowhere near the 4096-token window this whole session assumed
  (that figure came from `geniex infer`'s documented CLI default, never
  independently verified for `geniex serve`). The fixed overhead alone
  (system prompt + this app's 9 tool schemas) is enough to break the
  classifier regardless of user message length or chat history — confirmed
  failing identically across multiple different live chat turns, including
  a completely fresh chat with no prior history.
- **The reply itself was incoherent and truncated live in the app.** One
  observed reply hallucinated an unrelated financial question that was
  never asked, then cut off mid-sentence — consistent with the always-on
  `<think>` reasoning trace consuming the `max_completion_tokens` budget
  before ever reaching a real answer. A cleaner, fresh-chat retry produced
  more sensible reasoning (correctly referencing real PKM context and the
  math guardrail) but was still many paragraphs of exposed internal
  monologue before reaching any answer, and was still visibly truncated
  mid-thought — a poor chat experience even when the reasoning itself
  wasn't wrong.
- **Reverted:** `registry.js`'s `GENIEX_MODEL_ID` and both model-ID strings
  in `agent_chat_service.py` (`stream_response`, `_plan_action_via_bridge`)
  back to `unsloth/Llama-3.2-1B-Instruct-GGUF`. `MIN_FREE_RAM_BYTES` /
  `GENIEX_MIN_WORKING_SET_BYTES`/`MAX` back to the 1B's original 1.5GB/1GB/2GB.
  `_plan_action_via_bridge`'s `max_completion_tokens` back to 200 (from
  700) and its timeout back to 45s (from 70s); `local_bridge/server.py`'s
  tools-branch timeout back to 40s (from 60s). The 1B has no always-on
  reasoning trace, so none of these budget/timeout increases are needed for
  it.
- **Kept regardless of model:** the `max_completion_tokens` fix itself
  (GenieX's HTTP API silently ignores `max_tokens` — confirmed on the 1B
  too, not just Qwen3.5-2B), the math/reasoning guardrail in
  `_build_local_bridge_messages`, the `--model-type llm` pull-time fix
  pattern (in case a future model gets similarly misdetected), and the RAM
  curve measurement methodology (controlled memory-pressure allocator,
  real tok/s measurement) for whenever a future model candidate is
  evaluated.
- **Lesson for next time:** isolated CLI/curl testing did not surface
  either failure mode above — both only appeared once the real app's
  actual system prompts, tool schemas, and PKM-context assembly were
  exercised live. A candidate model should be smoke-tested in the actual
  app, not just via `geniex infer`/`geniex serve` in isolation, before its
  RAM/timeout constants are tuned or it's considered a serious candidate.

### Hybrid model split: Qwen3.5-2B reply generation + 1B tool-calling classifier
After the full revert above, the user asked to bring Qwen3.5-2B back for its
better reasoning quality specifically, while keeping the 1B's already-solid
tool-calling behavior. Since the classifier's `context_length_exceeded`
failure only triggers when `tools` are attached to a request, and the
reply-generation call never attaches `tools` (the classifier already
resolved `action_plan` separately), the two calls can safely run on
different models:
- **Classifier** (`_plan_action_via_bridge`) stays on
  `unsloth/Llama-3.2-1B-Instruct-GGUF` — no always-on reasoning trace, no
  `tools`-attachment bug.
- **Reply generation** (`stream_response`) moved to
  `unsloth/Qwen3.5-2B-GGUF` — better reasoning for plain conversational
  replies, never attaches `tools` so it never hits the classifier's failure
  mode.
- `registry.js` now pulls/verifies/deletes **both** models
  (`GENIEX_MODEL_ID` for reply, `GENIEX_CLASSIFIER_MODEL_ID` for the
  classifier); `MIN_FREE_RAM_BYTES`/working-set constants were raised
  (1.5GB / 3.5GB / 5.0GB) to account for both potentially being resident in
  one turn.
- Live-verified: a full chat turn now correctly makes two GenieX calls (one
  per model) when the classifier needs to resolve an action, or one call
  (reply only) when `plan_action_with_gemini` resolves a frontend/blocked
  action and returns a templated receipt without ever calling the reply
  model (`agent_chat.py`'s `action_plan is not None` early-return path).

### Qwen3.5-2B reply generation was showing raw `<think>` reasoning as the answer
The hybrid split above fixed the classifier, but live testing immediately
surfaced a second, separate defect in the reply-generation half: every
reply-generation call succeeded (HTTP 200, no errors), but the **visible
chat message was the model's raw internal reasoning trace**
("Thinking Process: 1. Analyze the User's Request...") cut off mid-sentence,
never reaching real answer text. Root cause, confirmed by direct probing of
the bridge endpoint:
- Qwen3.5-2B always reasons before answering, closing that block with a
  literal `</think>` marker (no opening tag is emitted — it starts directly
  in reasoning mode). Nothing in `agent_chat_service.py`, `local_bridge/`,
  or the frontend ever stripped this marker — the raw content was piped
  straight to the chat window.
- The real production message (full `AGENT_SYSTEM_PROMPT` plus the turn
  context, relevance reminder, math guardrail, and role-scope text all
  stacked into the user turn) needs a **much** larger thinking budget than
  assumed: 1200 and even 3000 `max_completion_tokens` were both exhausted
  before the model ever reached `</think>`. Verified directly (same
  endpoint, same message construction) that **6000** is enough for the
  model to close the block and produce a complete, coherent answer.
- **Fix, both halves required together:**
  1. `stream_response`'s local-mode streaming loop now buffers deltas and
     only starts yielding text after `</think>` is seen in the accumulated
     buffer — the reasoning text itself is never shown.
  2. `max_completion_tokens` raised to 6000 so the model actually reaches
     `</think>` instead of getting cut off mid-thought.
  3. If the stream ends without ever seeing `</think>` (budget still not
     enough for some prompt shape), a clear fallback message is yielded
     ("Sorry, that took too long to think through — please try again.")
     instead of either silence or a raw partial-reasoning dump.
- **Tradeoff:** worst-case reply latency rises substantially (6000-token
  budget vs. 1200) — accepted, since a slow-but-real answer is strictly
  better than a fast, incoherent one. Not yet measured end-to-end in the
  packaged app under real usage; only verified via a direct call to
  `stream_response` against a live GenieX/bridge instance outside the
  running Electron app.
- **Caution for future test scripts:** calling the bridge/GenieX directly
  from an ad-hoc script while the live app is also mid-conversation causes
  real contention — GenieX serializes all requests behind one internal
  lock, so a slow or timed-out test request can back up the live app's own
  requests to 60-90s+ and has been observed to abort an in-flight
  connection. Test against an isolated GenieX instance (a second `geniex
  serve` process is fine — the app's own instance and a manually-spawned
  one on the same port are interchangeable) rather than the app's live one
  whenever the app is actively in use.

### Superseded: reply generation moved from Qwen3.5-2B to Qwen3-4B-Instruct-2507 (llama.cpp)
The `</think>`-buffering fix above worked as designed (no leaked reasoning
text, ever) but repeated reliability testing found the underlying problem it
was papering over was worse than it first looked: across 5 trials of the
exact same simple prompt, only 2 succeeded. The other 3 never closed the
`</think>` block even at a 6000-token budget, each burning **4.5-5 minutes**
before falling back to an error message. Raising the budget further would
not have fixed this -- the failures were non-convergent reasoning, not
under-sized budgets.

Tried instead: **Qwen3-4B-Instruct-2507**, the same checkpoint this app
previously served via QAIRT/NPU (see the RAM-sensitivity section below),
now pulled and run through **llama.cpp/GGUF** instead (`geniex pull
unsloth/Qwen3-4B-Instruct-2507-GGUF:Q4_0 --model-hub hf --model-type llm`).
This model has no thinking-mode trace at all (its model card confirms this,
and it was directly reconfirmed here -- zero `<think>` tags across every
trial run). Results, tested both via raw calls to the bridge and via the
actual `stream_response()` code path:
- **8/8 trials succeeded** (plain chat x6, math-guardrail question x2) --
  100%, vs. Qwen3.5-2B's 40%.
- **Replies in 16-27s**, vs. Qwen3.5-2B's up to several minutes.
- **Correctly follows the math guardrail** without prompting changes --
  defers to a rough approximation and points to Kai's cloud tools, matching
  the intended behavior.
- **Measured GenieX process footprint with this model loaded: ~3.2-3.5GB**
  (working set / private memory) -- smaller than the original QAIRT path's
  ~6GB free-RAM gate, since llama.cpp carries no NPU driver/context
  overhead. This was the original hypothesis for trying this combination
  and it held up, though this is a process-RSS snapshot, not the full
  free-RAM/throughput degradation curve methodology used for Qwen3.5-2B --
  worth doing properly before treating `MIN_FREE_RAM_BYTES` as precisely
  tuned rather than a reasonable starting point.
- **Simplification:** the `</think>`-buffering/stripping logic in
  `stream_response` was removed entirely (not just made conditional) -- this
  model never emits the marker, so the buffering logic would have swallowed
  every real reply while waiting for a marker that never arrives.
  `max_completion_tokens` for the reply call dropped from 6000 back to 1500
  (real replies observed at 129-243 completion tokens, no reasoning-trace
  overhead to budget for).
- The classifier stays on the 1B, unchanged -- this swap only affects the
  reply-generation role.

### Performance: throughput is highly sensitive to free system RAM
Superseding an earlier (incorrect) conclusion in this file that this was a hard
hardware floor and that RAM headroom didn't help — a later, apples-to-apples
session measurement disproved that:
- Qualcomm AI Hub's own rated decoding speed for this exact configuration
  (`qwen3_4b_instruct_2507`, W4A16, GenieX-QAIRT, Snapdragon X Elite CRD, 4096
  context) is **23.1 tokens/s**.
- Measured on this device: **~0.78 tok/s with 1.3 GB free RAM** vs **~16 tok/s
  with 5.2 GB free RAM** — identical request, identical `genie_config.json`,
  ~20x difference from free RAM alone.
- **Root cause:** GenieX memory-maps the ~3.2 GB model weights. When free RAM
  is tight, pages get evicted and re-faulted from disk on every decode step
  instead of staying resident — a paging/thrashing problem, not a fixed
  memory-bandwidth ceiling.
- **Ruled out as causes** (tested directly this session, same device): HTP
  burst mode — already the default (`htp_backend_ext_config.json` ships
  `perf_profile: "burst"`); CPU thread/core count — bumping `n-threads`
  3→6 and widening `cpu-mask` to cover more cores made no measurable
  difference (103.9s vs 103.7s for an identical 81-token completion).
  Qwen3-4B-Instruct-2507 also has no thinking-mode tax to disable — the model
  card confirms this checkpoint never generates `<think>` content.
- **Mitigation shipped:** `registry.js` now refuses to spawn the local engine
  when free RAM is below `MIN_FREE_RAM_BYTES` (6 GB, with headroom above the
  5.2 GB point that recovered performance), and surfaces a "Local LLM can't
  run — insufficient RAM available" toast instead of silently running ~20x
  slower with no explanation (`hushh:models:spawn` → `{success, reason}`).
- **Still open:** even at 5.2 GB free we measured ~16 tok/s against a 23.1
  tok/s rating — a real but much smaller (not 20x) residual gap, not yet
  root-caused. Possibly background load/thermal state on the test machine
  rather than anything in our config.
- The UI still labels this feature **Experimental** with a RAM/slowness
  warning — insufficient-RAM is now a clean failure rather than a silent one,
  but the feature is still meaningfully slower than cloud on a loaded machine.

### Local model bridge (Hermes/Open-WebUI compatibility) — built, partially validated
Direction from the maintainer is to fit on-device inference into the Hussh
One / Hermes Agent runtime as a model-backend adapter, rather than growing
the desktop app's own local/cloud branch in `agent_chat_service.py`.
Spiking this (pointing a real Hermes Agent instance at our GenieX server via
its generic `provider: custom` mechanism) surfaced two gaps in GenieX
itself: streamed responses don't reliably carry a `finish_reason`/`[DONE]`
terminator, and GenieX has zero native tool-calling (an OpenAI `tools`
array gets stuffed into the prompt with no enforcement; the model's attempt
at a call comes back as raw unparsed text, `tool_calls` stays `null`).

Since GenieX is closed-source (a Go/Gin binary, per its server logs) and
can't be patched directly, built `hushh-desktop/backend/local_bridge/` — a
small FastAPI service, started in-process by `server.py` on a fixed port
(18182, alongside GenieX's fixed 18181) — that sits between GenieX and any
OpenAI-compatible client:
- Rewrites GenieX's streamed output to guarantee a spec-correct
  `finish_reason` and `[DONE]` terminator.
- Translates `tools` via the Nous/Hermes function-calling convention
  (`<tool_call>{"name", "arguments"}</tool_call>` injected into the system
  prompt), parses the model's completion back into a proper OpenAI
  `tool_calls` array. The model reliably produces correct call JSON but
  doesn't always wrap it in the requested tags, so the parser also accepts
  a bare `{"name", "arguments"}` object as a fallback.
- `agent_chat_service.py`'s local branch now calls the bridge instead of
  GenieX directly, and local-mode action-plan classification
  (`_plan_action_via_bridge`) uses this real tool-calling instead of the
  old regex-only `plan_action()` fallback (which remains as a fallback if
  the model's tool call doesn't resolve to a known action).

**Validated:** direct bridge calls (streaming/non-streaming, with/without
tools) all produce spec-correct responses; a real installed Hermes Agent
instance successfully completes a plain chat call through the bridge;
`agent_chat_service.py`'s new action-planning and chat-streaming paths were
both exercised directly against a live GenieX+bridge pair and produced
correct results (including a correct `open_app_surface` action-plan call
from natural language).

**Known limitation, not yet solved:** Hermes's own default toolset (~40
built-in tools) renders to ~18K tokens of schema text, far past GenieX's
compiled context ceiling (a fixed 4096 tokens for this asset). An external
Hermes instance using its full toolset will hit `context_length_exceeded`
against the bridge; this was only worked around for validation by disabling
most of Hermes's toolsets. Our own app's tool set (~8 declarations from
`_agent_action_tool()`) is far smaller and fits comfortably, so this only
affects the "external Hermes client" half of the story, not the desktop
app's own migrated chat path.

**Observed live in the real app (first end-to-end run):** simple
action-driven prompts ("show my active consents", "open my portfolio")
correctly round-tripped through the bridge's real tool-calling and fired the
right `open_app_surface` action. But an ambiguous, non-actionable prompt
("what can you do, list every function") triggered two back-to-back
`[LocalChat] Action-plan bridge call failed: TimeoutError()` warnings
(60s budget each), immediately followed by a GenieX crash (native access
violation, `0xc0000005`, inside `geniex_llm_generate`) — and this time
`registry.js`'s bounded auto-recovery did not bring GenieX back.
Root-caused as far as this session goes: `local_bridge/server.py`'s own
call to GenieX for the tools path had **no timeout at all**
(`aiohttp.ClientTimeout(total=None)`). GenieX serializes all requests
behind a single internal lock (visible as `middleware.GIL` in the crash
stack), so once one ambiguous/tool-heavy prompt sent GenieX into a
long-or-runaway completion, the bridge kept waiting on it forever, and the
*next* action-plan call queued up behind it and timed out too — right
before GenieX crashed, plausibly from sustained generation under memory
pressure (see the RAM-sensitivity section above).
- **Fixed same session:** bounded the bridge's internal GenieX call to 90s
  (was unbounded) so a stuck request fails cleanly instead of blocking
  everything queued behind it; raised `_plan_action_via_bridge`'s own
  client-side timeout from 60s to 100s.
- **Retested live, a second time, under real RAM pressure** (GenieX spawn
  was refused twice for insufficient free RAM before finally starting):
  the exact same shape recurred -- the bridge's now-bounded 90s call timed
  out, `_plan_action_via_bridge` correctly caught the resulting 500 and
  fell back to `plan_action()`, but GenieX's own GIN log showed the
  underlying request (orphaned server-side once the bridge gave up on it)
  still took **2-5 minutes** to actually return, and GenieX crashed again
  afterward with the same `0xc0000005` access violation. This proved the
  90s/100s budgets were sized on the wrong assumption -- that a slow call
  would eventually succeed if given enough rope. Live evidence says
  otherwise: when this call is slow enough to matter, it doesn't complete
  in any window worth waiting for.
- **Retuned this session:** the tool-calling path's timeout dropped from
  90s/100s to **15s (bridge-internal) / 20s (client-side)**. A short budget
  here isn't cutting off a legitimately-slow-but-succeeding call -- under
  real load this call essentially never succeeds within a reasonable
  window anyway, so failing fast and handing off to the deterministic
  regex fallback immediately beats stalling the whole turn for minutes on
  a call that was never going to help. The general-purpose (no-tools)
  bridge path keeps its original 90s budget, since a real full completion
  from an external client legitimately can take a while.
- **Not fixed, still open:** why GenieX produces a long/runaway completion
  for certain prompts in the first place (whether it's ignoring
  `max_tokens: 200`, or the tool-injected prompt sends this checkpoint into
  a repetition loop under load) is still unverified -- not yet reproduced
  under controlled (healthy-RAM) conditions. Also still open: whether
  `registry.js`'s bounded crash-recovery (`_attemptCrashRecovery`, max 3
  attempts/5 min) is actually firing after these crashes -- not confirmed
  either time, since by the time it's checked the whole app is often
  already down.

### First-run model download is required and large
The ~3.2 GB Qwen3-4B weights are **not** bundled — they download via
`geniex pull` the first time on-device AI is enabled. Needs network + disk +
time on first use. There is no in-app progress polish beyond a toast, and no
resumable-download guarantee if interrupted mid-pull.

### Occasional native QAIRT crash
Under memory pressure the native Qualcomm QAIRT library can crash the GenieX
server process. Mitigated by bounded auto-recovery in `registry.js`
(`_attemptCrashRecovery`, max 3 restarts / 5 min) — recovery is automatic and
confirmed working, but the underlying crash is upstream and not eliminated.

### GenieX runtime is Snapdragon-only
The bundled `resources/geniex` runtime and the QAIRT model target Snapdragon
NPUs. On non-Snapdragon hardware the on-device toggle will fail to spawn the
engine. There is no CPU/GPU fallback path wired up for the desktop chat.

---

## 🟠 Offline behavior

### No offline data staging or sync-back
The "vault logic for offline use" improvement is a **graceful-degradation UX
fix**, not an offline-first data layer. When the backend is unreachable, vault
checks now show a clean "Server Unreachable / Retry" screen instead of an
infinite spinner or retry loop (`VaultNetworkError` in
`frontend/lib/services/vault-service.ts` + `vault-lock-guard.tsx`). This mostly
occurs at boot when the frontend loads before the backend is ready.

**What does not exist:**
- No staging/queue of events generated while offline.
- No sync-back or conflict-resolution when connectivity returns.
- On-device model *generation* works offline (NPU needs no network), but
  *persisting* that chat to history still requires the live backend — offline,
  that write simply fails, it does not queue.

There is an unwired `DB_OFFLINE=1` SQLite scaffold (`backend/db/offline_db.py`)
that swaps Postgres for a local file for a few peripheral services; it is **not
activated** in the desktop build and does not solve reconciliation anyway.

---

## 🟠 Process & lifecycle

### Zombie child processes on ungraceful exit
Backend/frontend run as Electron child processes, torn down via `taskkill /T /F`
on `before-quit`. A forceful kill of Electron itself (Task Manager, IDE crash)
can orphan a child and hold its port. Dynamic port allocation means the next
launch usually just picks another port rather than hard-failing, but a stray
`hushh-backend.exe` / `node` may need a manual `Stop-Process`.

### Full account deletion is broken
`DELETE /api/account/delete` (`AccountService._delete_full_account`) fans out
across ~50 tables and, observed this session, hangs ~5 minutes then fails with
`HeadersTimeoutError` / `UND_ERR_HEADERS_TIMEOUT`. Not fixed — a narrower,
scoped DB cleanup was used instead for testing. True full-account deletion
should be treated as non-functional until reworked. (There is also a stale code
comment claiming chat tables were removed; the active
`agent_chat_conversations` / `agent_chat_messages` tables contradict it.)

---

## 🟡 PKM / chat context

### Fixed: PKM upgrade retry storm on every boot/navigation
`pkm_upgrade_service.py`'s `build_status` considered a domain "stale" (and
therefore worth a fresh upgrade run) purely from manifest/index metadata,
without checking whether the domain actually has any encrypted data behind
it. One user's index had a `professional` domain manifest entry with **no**
underlying data (a scaffold that was never populated) — a domain like that
can never successfully "upgrade," but nothing stopped the system from
trying. The result: every `ensureRunning` call (app boot, vault unlock,
route navigation) created a brand-new `pkm_upgrade_runs` row, immediately
failed in `prepareUpgradeArtifacts` (`No encrypted PKM domain blob found for
professional`), and repeated the whole cycle again on the next trigger —
forever, roughly every 20-40s, hammering the DB and competing for the same
machine's resources as everything else running (including GenieX chat
requests).

**Fixed:** `build_status` now also requires real domain data (via the same
`get_domain_data` check the actual upgrade step already uses, so it can't
disagree with what a real attempt would see) before considering a domain
upgradable. A manifest with no data behind it is excluded rather than
retried forever. Live-verified against the affected account: before the
fix, `upgradable_domains: ['professional']` on every check; after,
`upgrade_status: current`, `upgradable_domains: []`, and the old stuck
failed run is gone.

### Over-eager PKM auto-capture depends on an external LLM
The PKM auto-capture classifier (`pkm_agent_lab_service.py`) calls Gemini
regardless of whether the user is in local or cloud chat mode. When those Gemini
calls fail (see below), it falls back to a cruder heuristic that over-captures —
this produced a recurring garbage "what can you do" PKM note that resurfaced in
nearly every message's context until manually purged.
- Local-mode chat context has since been tightened (history/PKM char limits +
  a relevance reminder) to reduce over-referencing, but the classifier itself
  still always routes through Gemini.

### External Vertex/Gemini billing error
Logs show `Lightning dunning decision is deny for project projects/542956322242`
— an external Google Cloud/Vertex billing-status 403, not present in the
codebase. It causes Gemini calls to fail and triggers the fallback above. Fixing
it is a GCP account-state action, outside this repo.

---

## 🔵 Deliberate trade-offs (not bugs)

- **`asar: false`** — required because `sharp` (native binding) and the spawned
  backend/GenieX executables can't run from inside an asar archive. The
  electron-builder "asar disabled" warning is expected. Cost: many loose files
  on disk.
- **Renderer bundles the full shared webapp** — the desktop frontend is the same
  `hushh-webapp` codebase (Firebase, GSAP, recharts, Capacitor, `firebase-admin`
  in server routes). This inflates the renderer and contributes to idle RAM and
  slower first-navigation vs. a desktop-trimmed build. A slimmed desktop build is
  a future optimization.
- **Internal model id string** is still `"Llama-3.2-3B-Instruct"` across the IPC
  boundary for continuity, even though the served model is Qwen3-4B. Renaming
  requires touching both preload and frontend in lockstep.
- **Dev-mode RAM is not representative** — `npm start` runs `next dev` (HMR
  compiler) + `uvicorn --reload` (StatReload supervisor + worker), so idle RAM in
  dev is much higher than the packaged build. Measure footprint from the packaged
  app, not `npm start`.

---

## ⚠️ Platform / feature gaps (carried from Alpha)

- **Windows ARM64 only** — no macOS/Linux target; no CPU-only AI fallback.
- **No native installer** — portable ZIP only (NSIS/MSI silently drop the exe on
  ARM64). No desktop shortcut, Start Menu entry, or auto-updater.
- **FCM push notifications unsupported** on desktop (harmless VAPID warnings).

---

## Housekeeping reminders

- **Rotate the credentials** that were shared in chat during development
  (Qualcomm API token, WSL password, HF token) if not already done.
- The `hushh-desktop/ai-library/` folder in the repo (old ONNX prototype
  scaffold) is **not referenced by app code** — only `ai-library/geniex` is used
  (bundled via `extraResources`). The rest can be cleaned up.
