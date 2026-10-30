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

### Performance: slow generation, high RAM
The on-device path is functional but **not optimized**.
- Throughput is roughly ~1 word / 2–3 s (well below cloud).
- The engine uses **several GB of RAM** while a model is loaded (~3–5 GB).
- **Root cause (hardware, not a bug):** autoregressive decode on this model is
  memory-bandwidth-bound, not compute-bound — the NPU sits mostly idle between
  short compute bursts, so NPU utilization reads low (~5–6%) even at full tilt.
  This is a hard floor of the current model/hardware combo.
- **Empirically ruled out** as levers this session: KV-cache/context-size
  reduction (no measurable memory change), `max_tokens` capping (no wall-clock
  change), and adding RAM headroom (still slow with 12 GB free).
- **Only real lever:** a smaller/faster NPU-compiled model. None currently exist
  freely for this chipset — smaller Qwen/Llama variants are either CPU-only
  (no QAIRT) or licensing-gated (Meta manual export). Tracked as a future item.
- The UI labels this feature **Experimental** with an explicit slow/RAM warning.

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
