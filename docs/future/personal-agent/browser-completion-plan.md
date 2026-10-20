# Browser tasks: native cloud models and owner control

## Status

**Implementation in progress — 2026-10-19; integration baseline `fd4770c16e`.**
Browser is the P0 capability. Both adapters remain disabled until
their own acceptance passes. Preserve the infrastructure branch, owner resources,
selected configuration and concurrent work. Broader release-plan changes follow
actual Browser implementation evidence, not this proposed design.

The approved execution order is native feasibility, Browser production composition
and owner control, all-family One scheduling, lifecycle corrections, then one
combined dev candidate. Scheduled actions retain their existing confirmation
requirements. Preserve economy scale-to-zero: no always-on wake service or artificial
keepalive. Cold response under thirty seconds is an optimization goal, not a release
gate. Reuse prior timings; after relevant changes, measure three cold and three warm
turns per cloud without claiming a new percentile.

## Product scope: Browser is One's capability

One owns the browser task, progress, owner takeover, continuation and cleanup.
The existing `agent_computer_use` specialist operates websites through ADK's
computer-use tools; this release supplies no operating-system desktop or general
computer control. Browser remains part of the owner's private-agent deployment
and software-update lifecycle.

Use the same browser session for autonomous work and responsive owner input.
Connect downloads/uploads to Files, selected information to consented PKM
exports, and scheduled browser work to the existing occurrence and review
authorities. Each capability keeps its own grants and exact confirmations.

Assess the proposed integrated browser service against those boundaries before
choosing its packaging. A single image or service is not proof that a browser
cannot reach the agent's keys, workload credentials or private endpoints.
The native-only execution gate below remains the current approved baseline;
this product clarification neither enables execution nor proves a replacement.

## Visual Context

The [architecture index](../../reference/architecture/README.md) provides the
platform context and canonical maps.
The [private browser runtime map](../../../consent-protocol/docs/reference/private-browser-runtime.md#visual-map)
owns existing authority and execution boundaries. Its model adapter is currently
Gemini-only. Extend that subsystem for Azure; retain one authored specialist,
ADK task lifecycle, control authority, action ledger and recovery owner.

## Documented integration and models

| Cloud | Initial qualification target | Integration |
| --- | --- | --- |
| GCP | Owner-authorized Gemini 3.8 Flash through the verified owner-project connection | ADK task-mode `LlmAgent`, `ComputerUseToolset`, existing `PodComputer(BaseComputer)` |
| Azure | Owner's verified `gpt-6-luna` Computer Use deployment | Same ADK task lifecycle, browser-specific native Responses `BaseLlm` adapter and provider toolset adaptation over existing `BrowserControl` |

Google documents [ComputerUseToolset/BaseComputer](https://adk.dev/integrations/computer-use/)
and lists Gemini 3.8 Flash among [supported browser models](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/computer-use#supported-models).
Microsoft lists Computer Use for GPT-6 Luna and GPT-6.1 Sol in its
[Azure model catalog](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure).
Its [native Computer Use guide](https://learn.microsoft.com/en-us/azure/foundry-classic/openai/how-to/computer-use)
documents Responses actions, screenshots and safety checks. Catalog support does
not prove entitlement, region capacity or a functioning owner deployment.

Use the two targets first, not another model sweep. Other compatible deployments
are explicit owner choices after qualification. Preserve the working chat model;
never silently select a preview, higher-cost model, another cloud, shared key or
Puppy. Resolve Browser's effective deployment through existing AI configuration.

The verified Python pin is **ADK 2.9.0**. ADK's [OpenAI documentation](https://adk.dev/agents/models/openai/)
distinguishes Python/LiteLLM from Go's native connector; neither establishes this
pilot's Azure browser compatibility. Use the pinned SDK's supported
[`BaseLlm`](https://github.com/google/adk-python/blob/v2.9.0/src/google/adk/models/base_llm.py)
and [`BaseToolset`](https://github.com/google/adk-python/blob/v2.9.0/src/google/adk/tools/base_toolset.py)
extension contracts. The Azure bridge is required Hussh adapter work, not an
ADK-provided Azure Computer Use integration. Retain the Runner and ephemeral
task session; do not fork ADK or add an independent orchestration engine.

## Model and action implementation

- Preserve Gemini native configuration, screenshots, continuation metadata and
  authored instructions through the pinned preprocessing behavior.
- Reuse Azure endpoint validation, workload identity/token renewal and private
  credential custody. Add browser-specific native request/result translation:
  computer calls, call IDs, screenshot parts, safety checks and continuation.
  The existing generic text/function translator explicitly refuses native media and tools; preserve that refusal while adding the separate Browser transport.
- Qualify `store=false` with bounded in-memory continuation; never enable stored
  Responses to repair a failed request. Suppress content telemetry. This setting
  does not establish provider blindness or remove processing disclosure.
- Map coordinate units, buttons, scroll, drag, key combinations and typing
  exactly. Native text-only typing must use a guarded observed-focus operation
  or refuse; never invent coordinates or broaden owner-only input flags.
- Pending provider safety checks require exact owner review. Revalidate authority
  and control epoch before every action in a batch; stop on takeover, revocation,
  unsupported actions, changed terms and uncertain effects. Never auto-acknowledge.
- Replace the Gemini type restriction only with verified provider/model bindings.
  Keep one manifest-owned specialist; regenerate projections through their owners.

## Headless work and responsive takeover

Chromium stays headless in the selected owner's native cloud sandbox. A visible
desktop is unnecessary. Opening the preview displays the same task and page.

| Action | Required behavior |
| --- | --- |
| Ask One to use a website | Start one bounded task and show actual progress or waiting state |
| View browser | Desktop panel or mobile sheet; opening it neither restarts the browser nor transfers control |
| Take control | Fence autonomous inputs and all model observations before acknowledging exclusive owner input |
| Mouse, touch and keyboard | Operate the same page with ordered focus, drag, scrolling and input within the current epoch |
| Fit this screen | Scale the preview; explicit remote-page reflow requires owner control and an acknowledged fresh frame |
| Resume agent | Explicit handback, fresh observation and still-valid processing/action authority |
| Stop or reconnect | Server-side cancellation or rediscovery of the same task; no duplicate submission |

Separate preview frames from model observations. Handle orientation, device-pixel
ratio and letterboxing without corrupting coordinates. Reject stale input after
resize, frame loss and reconnect. Bound frame buffers and input queues. Do not
expose arbitrary CDP, JavaScript, shell, clipboard or local desktop control.

Manual login suppresses screenshots, URLs, page text, tools and errors from model
processing. Preserve explicit Remember/Forget and selected non-secret PKM consent;
no password export or automatic injection. CAPTCHA, rejected sign-in and unsupported
SSO need owner input. App closure may continue a bounded authorized task; waiting
for owner input checkpoints and follows idle teardown rather than inferring forever.

## Native execution prerequisites

| Cloud | Recorded failure | Required next proof |
| --- | --- | --- |
| GCP | Native worker ran as root; required UID/GID changes returned `EPERM`; sandboxed Chromium produced no frame | Provider-supported non-root identity and Chromium namespace compatibility, then the existing native browser-only probe |
| Azure | Workload identity, non-root/zero-capability execution and tmpfs pass. Chromium aborts on restricted namespaces; no frame. Network denial is unqualified | Provider-supported restricted namespace permissions, verified HTTP/TCP/UDP denial and the private memory-only broker bridge |

Retain the owner's native sandbox requirement. No `--no-sandbox`, privileged
process, alternate executor or execution in the private-agent container.
The current [Google sandbox CLI](https://docs.cloud.google.com/run/docs/reference/sandbox-cli)
documents no user selector; IAM grants or image `USER` alone cannot establish a
working mechanism. The [Azure sandbox contract](https://learn.microsoft.com/en-us/azure/container-apps/sandboxes-overview)
requires Entra access; subscription administration does not prove data-plane access.

Use disposable synthetic resources first. Prove Chromium/frame capture, explicit
metadata/private/direct-public denial, broker-only web access, memory-backed scratch,
immutable component provenance and teardown. Timeouts are not network-denial proof.
Azure's current identity/policy probe cannot qualify the private bridge. Admit no
real owner information before the complete cloud boundary passes.

## Implementation and verification order

| Stage | Deliverable | Exit proof |
| --- | --- | --- |
| 1. Native execution | Qualified non-root Chromium and private bridge on each cloud | Native frame, denied network, immutable source and teardown receipts |
| 2. Native model contracts | Gemini verified; Azure model/toolset adapter and exact action mapping | Extend existing browser/Responses suites for images, instructions, call correlation, safety review, focused typing and unsupported-action negative controls |
| 3. Cloud execution | Qualified launcher and private bridge per cloud | Native probes, actual Chromium, controlled network and teardown receipts |
| 4. Runtime composition | Install `browser_task_runtime` with real ledger, exports, storage, model and update ports | Admitted start/reconnect/review/cancel; no fake readiness or duplicate task/effect |
| 5. Owner experience | Headless work, responsive preview and exclusive takeover | Controlled mouse/touch/keyboard, viewport changes, login suppression and explicit fresh handback |
| 6. Installed-image acceptance | Separate GCP and Azure evidence | Research, manual login, reviewed submission, scoped byte-exact Files download, Forget, update drain/recovery and idle wake |

Run focused checks while building; use one core mirror and exact-SHA hosted
verification on the finished candidate. Model checks stay synthetic, bounded and
subject to existing spending controls. Do not retest unrelated models.

Preserve one active task/page, 60 automated actions or 15 active minutes before
explicit continuation, ten-minute idle policy and warning-only spending limits.
Preview keepalives cannot prolong an unattended task. Respect selected pod sizing;
browser resources need an explicit offer rather than a hidden increase for everyone.

Measure native startup, model first action, action-to-frame, first useful progress,
completion, CPU/RAM, preview bandwidth, model tokens and 429/retry outcomes. Keep
the controlled input-to-frame p95 target of 250 ms separate from measured internet
results. Record sample counts and failures; one task is not reliability evidence.

## Completion and later release handoff

Browser is complete only after **both clouds** pass installed-image journeys.
Until then, keep truthful unavailable states for Shared and unqualified pods.
Choosing a cloud never guarantees Browser access. Use the existing
[readiness memo](../../reference/quality/adk-orchestration-docs-audit.md) for
source-complete, dev-verified and blocked results; create no second acceptance ledger.

The user's subsequent execution authorization permits progressing the finished
candidate through governed validation, push and dev deployment. Owner installation
retains the existing exact-release Settings approval. Main merge, UAT/production,
stable publication and automatic owner upgrades remain separate decisions.

## Promotion rule

After verification, fold durable adapters and operating details into the existing
runtime reference and owned skills, update qualified provider paths in its diagram,
evolve the release plan from actual receipts, and remove this completed plan after
carrying forward unique unresolved requirements.
