# Browser tasks: native cloud models and owner control

## Status

**Implementation in progress — updated 2026-10-20; integration baseline `468c0206c0`.**
Browser is the P0 capability. Both adapters remain disabled until
their own acceptance passes. Preserve the infrastructure branch, owner resources,
selected configuration and concurrent work. Broader release-plan changes follow
actual Browser implementation evidence, not this proposed design.

The approved execution order is Azure whole-deployment qualification, Browser production composition
and owner control, all-family One scheduling, lifecycle corrections, then one
combined dev candidate. Scheduled actions retain their existing confirmation
requirements. Preserve economy scale-to-zero: no always-on wake service or artificial
keepalive. Cold response under thirty seconds is an optimization goal, not a release
gate. Reuse prior timings; after relevant changes, measure three cold and three warm
turns per cloud without claiming a new percentile.

## Immediate MVP — critical path first

This section narrows the immediate Browser milestone. The fuller design below
remains the follow-on scope, not a prerequisite for demonstrating the MVP.
Neither cloud is currently Browser-qualified. Complete one vertical journey
through the existing runtime before expanding capabilities.

| Order | Deliverable | Acceptance |
| --- | --- | --- |
| 1 | Protected browser in the existing pod image | Sandboxed Chromium loads one approved synthetic public page and produces a frame. Browser cannot read pod secrets, inspect One, obtain workload tokens or bypass the broker. Teardown is verified. |
| 2 | One delegates a public research task | Existing ADK specialist observes, navigates, clicks and scrolls within approved origins; it returns a bounded outcome through the approved result boundary. No cloud/model fallback. |
| 3 | Owner can watch and intervene | View browser, Take control, Resume agent and Stop share the same task. Mouse, touch, scroll and keyboard map to the displayed frame. Takeover fences autonomous actions and model observations; handback requires a fresh observation. |
| 4 | Reconnect and failure are truthful | Refresh discovers the same live task without resubmitting the goal. Interrupted execution is reported explicitly. Stop terminates owned browser work; idle teardown releases resources. |

Use one page and one active task, with the existing 60-action/15-minute bound.
Start with a fixed remote viewport scaled responsively to the preview container;
explicit remote resizing is a follow-on capability. Preview streaming remains
separate from model calls. Retain current owner consent, incarnation checks,
revocation, model-processing disclosure and bounded error states.

The first fixture is public research: open an approved site, find a stated fact,
watch progress, take control, hand back, refresh and stop. Qualify that same
journey independently on GCP and Azure with their actual model connections.
One cloud's result cannot enable the other. Resolve the measured execution
prerequisite before repeating its probe. GCP's successful synthetic execution
and broker evidence can be reused; installed owner acceptance remains separate.

**Defer from this milestone:** remembered login/Forget UI, PKM autofill, Files
upload/download, scheduled browsing, multi-page/SSO support, automatic recovery
across pod replacement and advanced viewport presets. Keep existing source
foundations; do not expose deferred controls as available.

Autonomous sending, submitting, purchasing, deletion and other consequential
effects remain unavailable in this MVP. Existing broker policy must enforce
that restriction, including transmissions through autosaving fields; hiding
controls is insufficient. Owner input must retain its current authority and
disclosure checks. Real manual-login acceptance follows the public fixture and
requires verified observation suppression; remembered state remains off.

Verify only this changed journey and its essential negatives: wrong owner or
incarnation, revoked authority, denied destinations, stale input after takeover,
duplicate start/reconnect and terminal cleanup. Reuse existing unchanged tests.
This smaller milestone does not establish full Browser or main readiness.

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

The owner approved Browser inside the existing pod service and image, replacing
the earlier requirement to use provider-managed sandbox products. Use a separate
unprivileged browser identity, Chromium's sandbox, verified filesystem/syscall
restrictions and the existing private broker. The owner has final control over
One and the browser. This packaging choice does not establish isolation or permit
access to the agent's keys, workload identity or private endpoints.

## Visual Context

The [architecture index](../../reference/architecture/README.md) provides the
platform context and canonical maps.
The [private browser runtime map](../../../consent-protocol/docs/reference/private-browser-runtime.md#visual-map)
owns existing authority and execution boundaries. Source includes native Gemini
and Azure adapters under one authored specialist, ADK task lifecycle, control
authority, action ledger and recovery owner. Installed acceptance remains open.

## Documented integration and models

| Cloud | Initial qualification target | Integration |
| --- | --- | --- |
| GCP | Owner-authorized Gemini 3.8 Flash through the verified owner-project connection | ADK task-mode `LlmAgent`, `ComputerUseToolset`, existing `PodComputer(BaseComputer)` |
| Azure | Qualify an owner-authorized `gpt-6-luna` Computer Use deployment | Same ADK task lifecycle, browser-specific native Responses `BaseLlm` adapter and provider toolset adaptation over existing `BrowserControl` |

Google documents [ComputerUseToolset/BaseComputer](https://adk.dev/integrations/computer-use/)
and lists Gemini 3.8 Flash among [supported browser models](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/computer-use#supported-models).
Microsoft lists Computer Use for GPT-6 Luna and GPT-6.1 Sol in its
[Azure model catalog](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure).
Its [native Computer Use guide](https://learn.microsoft.com/en-us/azure/foundry-classic/openai/how-to/computer-use)
documents Responses actions, screenshots and safety checks. Catalog support does
not prove entitlement, region capacity or a functioning owner deployment.
The current owner deployment remains `one-chat`, `gpt-5-mini` version
`2025-08-07`. Its actual workload identity received HTTP 400 for a native
`computer` tool request. A temporary `gpt-6-luna` deployment in the same account
returned a `computer_call` through that identity: HTTP 200 in 1.843 seconds,
838 input and 20 output tokens. The deployment was deleted and absence confirmed;
the owner's chat selection was unchanged. The corrected native ADK adapter then
completed a two-call synthetic screenshot continuation in **2.022 / 1.309 seconds**
through the same identity, preserving exact call identity and low reasoning.
The second temporary deployment was also removed. This proves model transport,
not a composed owner Browser journey or model availability in the VM.

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

Chromium stays headless in the selected owner's pod service. A visible
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

## Built-in execution qualification

Prove the existing pod service can start separate unprivileged agent/browser
processes. Install irreversible restrictions before browser imports, threads or
private payloads. Pass only a connected Unix stream to the existing broker;
remove inherited credentials and unrelated descriptors. Deny direct networking,
process-memory access and unrelated filesystem reads; allow writes only to
verified task tmpfs. Require the actual Chromium sandbox and a real frame.

Reuse the successful disposable ordinary Cloud Run execution. Container Apps'
required namespace operation remains refused. The latest approved Azure candidate
is a disposable whole-owner Linux VM, initially `Standard_B2als_v2` in westus2,
2 vCPU / 4 GiB host with the application constrained to 1 vCPU / 2 GiB.
That synthetic VM now renders public documentation/search through the real broker
with Chromium's sandbox retained. Stop, container removal, deallocation, power
restart and resource absence pass. Exact timings, image and security configuration
are in the [runtime evidence](../../../consent-protocol/docs/reference/private-browser-runtime.md#built-in-process-qualification--2026-10-20-utc).
The full packaged pod image also passes protected execution, disabled bootstrap
and teardown. A rebuilt image preserves synthetic encrypted identity and recovery
records through VM deallocation/start using its real workload identity, Blob
storage and Key Vault. Disposable normal-entrypoint Gunicorn TLS startup,
authenticated drain and same-key restart are also recorded in the runtime evidence.
Installed-owner Browser composition, active-task control/reconnect and customer
wake remain separate acceptance requirements.
Bind receipts to source, immutable image and configuration. Qualify each cloud
independently and fail closed; there is no privileged browser or `--no-sandbox`
retry. The VM must qualify the whole deployment's recovery, external wake,
deallocation, updates and deletion before an owner-visible hosting offer. Existing
owners remain on their selected configuration. Retained disk/network costs and
burst credits are separate from application CPU limits.

### Azure VM hosting proposal — qualification only

Keep the existing `ComputeBackend`, Azure setup mutation journal, update
admission and erasure reservation as the authorities. A VM requires explicit
persisted host selection; it cannot masquerade as an ACA revision.

The reviewed implementation boundary is an owner-selected Azure host kind and
region, carried through authenticated authorization, the setup job, registry
publication and `PodSpec`. Existing Azure rows retain Container Apps as their
default. A mutable provider observation must not choose the host. The current
setup's fixed `eastus2` region cannot silently select a VM qualified elsewhere.
Read-only retained-host routing is implemented. Customer host selection,
approval, publication and exact-key attachment are not offered yet.
The recovery probe moved to `northcentralus` only after `westus2` returned
`AllocationFailed` and fresh quota, SKU and pinned-OS checks passed there.
That diagnostic selection does not change the user's selected hosting region.

| Boundary | Required implementation and proof |
| --- | --- |
| Identity / custody | VM IMDS transport, host binding and synthetic Key Vault/Blob recovery pass. Compose them into the owner setup's user-assigned identity, exact tags and actual application startup; do not synthesize ACA platform variables |
| Private ingress | Stable HTTPS endpoint with the existing signed owner/pod admission and CORS checks. The probe's deny-all inbound policy is not customer ingress |
| Wake / idle | Scope start/deallocate permission to the selected VM through the existing control plane. Coalesce concurrent requests. Persist scheduled work before wake; admit it only after authenticated recovery. Drain browser and relay before deallocation; verify provider power state |
| Update / transition | Exact owner hosting offer, immutable image, predecessor recovery, old-writer fence and installed-digest readback. Preserve keys/storage; do not automatically move current ACA owners |
| Erasure | Inventory VM, disks, network, identity, registry and custody through existing cleanup authority; retain repairable state until absence/retention is established |

The image-update preparation now retains exact request-body commitments, installed
configuration/updater hashes, placement and key identities. It does not export the
VM environment. Import targets `pod`; the final tag action uses Azure's
[resource-scoped Merge](https://learn.microsoft.com/en-us/rest/api/resources/tags/update-at-scope?view=rest-resources-2021-04-01).
Current SQL961 intentionally refuses this new intent. Add forward admission and
read-only reconciliation in the same setup journal before wiring execution.
Persist the authenticated idle cursor and epoch through the existing upgrade CAS.
After target recovery, publish the image/configuration/installation together and
retire a terminal old power cycle without relabeling its historical receipts.
Pending power cycles remain fenced. Dev ledger readback on 20 October confirms
961 applied, with 967 and 968 unused; no migration was applied during this review.

The source VM wake coordinator now adopts a dedicated registry power operation,
verifies current session authority, and reconciles the original provider dispatch
before releasing its exact sealed fence. The normal installer has controlled
HTTPS/recovery proof; the customer offer, external grant and live wake/idle
acceptance remain prerequisites. Exact VM start/deallocate
permission alone does not prove long-running-operation polling access: qualify
[the required operation-status permission](https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/async-operations#permission-for-tracking-async-status)
without silently broadening the Container Apps observer role.
Deletion of a sleeping VM must first recover the existing cryptographic-erasure
path, or remain repairable. A provider DELETE alone is not that receipt.

**Unattended wake design:** a deallocated VM cannot receive direct push or consume
its queue. Retain the direct pod subscription and existing Files work queue. A
separate owner-cloud Azure Function with zero ready instances receives wake
signals; its dedicated queue contains identifiers only. The Function requests
the existing hub power operation using its verified Entra workload identity and
exact installation binding. It receives no VM control permission. The hub never
receives Gmail notification contents. A second authenticated Gmail subscription
targets the owner Function solely for waking; actual processing stays in the pod.

Persist wake publication intent beside the existing sealed job, reconcile lost
publication replies, and tolerate duplicate identifiers through the current
power cycle. Never bind a Function trigger to the Files work queue: that trigger
could claim or delete work before the pod wakes. Delayed scheduled delivery needs
bounded seven-day checkpoints and authenticated worker dispatch after recovery.
Idle deallocation must defer active work; an idle candidate cannot authorize
cancelling a newly admitted turn. These paths are not implemented or qualified.
The visible offer must include Function host storage, its queue and narrow
identity grants, the additional subscription/DLQ, and metered execution/storage.
No always-ready instances or artificial keepalive are proposed. References:
[Functions Flex Consumption](https://learn.microsoft.com/azure/azure-functions/flex-consumption-plan),
[queue trigger settlement](https://learn.microsoft.com/en-us/azure/azure-functions/functions-bindings-storage-queue-trigger),
[queue delay bounds](https://learn.microsoft.com/en-us/rest/api/storageservices/put-message),
[authenticated Pub/Sub push](https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions).

**Cost assumptions, 2026-10-20, westus2 USD retail:** Linux B2als_v2 host
**2 vCPU / 4 GiB**, app **1 vCPU / 2 GiB**, single worker. The observed 30 GiB
Standard SSD maps to the 32 GiB E4 tier. At 730 calendar hours, retained disk
($2.40), one Standard IPv4 ($3.65) and owner Basic ACR (~$5.07) create an
approximately **$11.12/month retained infrastructure floor**. VM compute adds
$0.0376 per billed hour, including startup and idle grace.

| Billed VM hours/month | Compute | Retained disk + IP + registry | Infrastructure subtotal |
| ---: | ---: | ---: | ---: |
| 30 | $1.13 | $11.12 | $12.25 |
| 120 | $4.51 | $11.12 | $15.63 |
| 730 | $27.45 | $11.12 | $38.57 |

This is not an all-inclusive price: add Files/recovery storage and operations,
Key Vault, queues, egress, monitoring, model calls and allocated control-plane
cost. Reusing the owner's existing registry avoids a second registry, not its
existing bill. No artificial keepalive is proposed. B2als_v2 has a 30% base CPU
performance threshold and burst credits; the short probes do not establish
sustained equivalence to Container Apps. Deallocation removes VM compute charges,
not retained resources. Sources: [Azure retail API](https://prices.azure.com/api/retail/prices),
[B-series specifications](https://learn.microsoft.com/en-us/azure/virtual-machines/sizes/general-purpose/basv2-series)
and [billing states](https://learn.microsoft.com/en-us/azure/virtual-machines/states-billing).

### Historical provider-managed sandbox probes

The earlier provider-managed sandbox adapters are superseded by the approved
built-in Browser design. Their failed identity/namespace probes and immutable
receipts remain in the [runtime history](../../../consent-protocol/docs/reference/private-browser-runtime.md#historical-provider-managed-qualification).
Those failures do not invalidate the newer protected VM/Cloud Run execution
receipts, and neither set establishes installed-owner acceptance.

## Full capability follow-on order

Execute the immediate MVP above first. The following table retains the broader
completion requirements for subsequent slices; it must not expand the first
acceptance window.

| Stage | Deliverable | Exit proof |
| --- | --- | --- |
| 1. Built-in execution | Qualified separate-UID Chromium and private bridge in each owner cloud service | Real frame, process/filesystem/network negative controls, immutable source and teardown receipts |
| 2. Native model contracts | Gemini verified; Azure model/toolset adapter and exact action mapping | Extend existing browser/Responses suites for images, instructions, call correlation, safety review, focused typing and unsupported-action negative controls |
| 3. Cloud execution | Qualified in-pod launcher and private bridge per cloud | Actual Chromium, controlled network and teardown receipts |
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

## Full completion and later release handoff

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
