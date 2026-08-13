"""The compute-backend seam for the sovereign per-user agent.

One logical agent (HusshID + spaceID + PCHP + the zero-knowledge pod), many
compute backends underneath. This module is the **provider abstraction**: a
``ComputeBackend`` Protocol plus the backend-neutral value types the provisioning
brain speaks (``PodSpec`` / ``BackendHandle`` / ``BackendStatus``), and a
``NullBackend`` no-op default so Phase 0 stays a pure registry stamp with **no
host call**.

Which backend is "primary" is a deployment CHOICE per WORKLOAD CLASS, not a
property of this seam. The current posture (docs/future/personal-agent/
ARCHITECTURE.md §2, ROADMAP.md):

  * ``AnypointBackend`` — **primary for general / mass-market deployments**: a Mule
                         app on CloudHub 2.0 / Runtime Fabric, operated by the
                         dedicated MuleSoft team. Primary here because Hushh holds
                         **pre-purchased Titanium capacity** (already paid for ->
                         best cost at 1B scale); it hosts the pod AND carries the
                         enterprise lane. FedRAMP Moderate (Gov Cloud). Renders the
                         AMC descriptor today; live is gated (raises until wired).
  * ``GcpBackend``      — **primary for the FedRAMP-High / government / regulated
                         tier** (Cloud Run + Confidential Space): GCP carries
                         **FedRAMP High** (vs MuleSoft Government Cloud's Moderate)
                         and is the validated, live-wired backend.
  * ``UserGcpBackend``  — the BYOC sovereign tier (the pod in the user's own GCP).

Every backend implements the same contract, so provisioning, teardown, and the
reconcile loop are uniform across hosts. Selection is by the
``PERSONAL_AGENT_BACKEND`` setting, resolved through ``resolve_compute_backend``:
unset resolves to ``NullBackend``, so a half-configured environment can never
silently attempt a real host call.

Nothing here reaches user data or consent: a backend receives only the opaque
HusshID/spaceID, the HMAC phone hash, the pod's PUBLIC key, and version pins.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional, Protocol, runtime_checkable

# Tiers a pod can run at: a logical stamp against a shared runtime (mass tier, no
# per-user deploy), or a dedicated/attested instance (premium/regulated tier).
TIER_LOGICAL = "logical"
TIER_DEDICATED = "dedicated"

# Resource tiers, distinct from the isolation tiers above: these say how warm a pod is
# kept, not how isolated it is. `_liveness_mode` in gcp_backend derives the same two
# names from minScale, so they are named once here and consumed on both sides rather
# than spelled as literals in each.
RESOURCE_TIER_ECONOMY = "economy"  # minScale 0: scales to zero, silence is healthy
RESOURCE_TIER_WARM = "warm"  # minScale 1: a paid instance is held, silence is a fault
RESOURCE_TIERS = (RESOURCE_TIER_ECONOMY, RESOURCE_TIER_WARM)

# Canonical backend ids (the ``PERSONAL_AGENT_BACKEND`` values).
BACKEND_NULL = "null"
BACKEND_GCP = "gcp"
BACKEND_ANYPOINT = "anypoint"
BACKEND_USER_GCP = "user_gcp"  # BYOC: the pod runs in the USER's own GCP project.

# --- the pod's resource profile, in ONE place -------------------------------------
#
# Both renderers derive from these. They used to be independent literals -- GCP at
# "500m" CPU and Anypoint at "0.1" vCores -- which sized the same pod FIVE TIMES
# differently depending on which backend provisioned it. The parity test did not
# catch it because it only asserted each backend stated *a* size, never that the
# two stated the *same* one. A shared constant makes the disagreement impossible
# rather than merely unlikely.
#
# The numbers are measured, not guessed (MULTI-POD-DEV-SIMULATION.md): 211.9 MB
# idle, 212.7 MB after 150 requests, 3.94 s cold start of which 58% is `google.adk`
# importing. So the pod is memory-flat and CPU-bound only at boot -- which is what
# makes a small steady-state CPU honest, paired with startup-cpu-boost.
#
# 1Gi against a 212 MB footprint is deliberate headroom, not waste: the JVM-less
# Python runtime has no ballast to trim, and OOM in a per-user pod is a person's
# agent dying rather than a request retrying.
POD_CPU_MILLIS = 500
POD_MEMORY = "1Gi"
POD_CPU = f"{POD_CPU_MILLIS}m"


def pod_vcores(cpu_millis: int | None = None) -> str:
    """The same size expressed the way CloudHub asks for it.

    CloudHub 2.0 sizes a replica in vCores where 1 vCore is one vCPU, so the
    conversion is a unit change and not a policy decision -- which is exactly why
    it belongs in a function next to the constant rather than as a second literal
    in the Anypoint renderer.

    Rendered to 2dp because CloudHub's replica sizes are discrete; a value that
    does not land on one is a deploy-time rejection, and rounding here at least
    makes the intended size legible in the descriptor.

    ``None`` reads ``POD_CPU_MILLIS`` *at call time*, deliberately. Writing the
    constant as a default argument would bind it when this module is imported, so
    changing the profile would move the GCP renderer and silently leave this one
    behind -- reintroducing the exact divergence the shared constant exists to
    remove. A test that reloads the modules catches this; a test that only reads
    today's values does not.
    """
    millis = POD_CPU_MILLIS if cpu_millis is None else cpu_millis
    return f"{millis / 1000:.2f}".rstrip("0").rstrip(".")


@dataclass(frozen=True)
class PodSpec:
    """Backend-neutral request to stand up one user's agent instance (a spaceID).

    Carries only opaque/derived identifiers and version pins -- never a raw phone
    number, never a private key, never user data.
    """

    hushh_id: str
    phone_e164_hash: str
    pod_pubkey: str
    region: Optional[str] = None
    tier: str = TIER_LOGICAL
    space_id: Optional[str] = None
    consent_binding_ref: Optional[str] = None
    runtime_version: Optional[str] = None
    prompt_version: Optional[str] = None

    # -- the two axes, per person -----------------------------------------------
    #
    # WHERE this person's pod runs, and WHOSE model credential it uses. Until these
    # existed here, both were process-wide environment variables, so every pod in a
    # deployment necessarily ran on the same target with the same credential class
    # and neither was expressible for one person.
    #
    # That is the gap the north star names as the FIRST change: "the first change is
    # not credentials or IAM: it is putting both axes on PodSpec and on a per-user
    # column, after which the rest becomes possible." It is also the deployment-
    # agnostic test in concrete form — moving a pod to someone else's project must be
    # setting a value, not editing code.
    #
    # It matters more now than when it was written: BYOC is the production path and
    # the hussh-managed tier is strictly simulation, so "which target" is a per-person
    # production fact, not a deployment-wide one.
    #
    # `None` means "use the deployment default", which is what every existing caller
    # gets and why this is additive. `resolve_compute_backend` reads the target when
    # one is set; the registry records both so a later read can tell what a pod was
    # actually built as rather than what the environment happens to say today.
    deployment_target: Optional[str] = None
    model_credential_mode: Optional[str] = None

    # -- the third axis: how warm THIS person's pod is kept -----------------------
    #
    # Same defect as the two above, one layer down. `HUSSH_POD_MIN_INSTANCES` is read
    # once when the backend is constructed, so every pod a process provisions gets the
    # same `minScale` -- "economy by default, warm when someone needs it" was not
    # expressible for one person, only for a whole deployment.
    #
    # It is not merely a cost knob. The liveness evaluator reads a warm pod's silence
    # as a FAULT and an economy pod's silence as its healthy steady state, so the tier
    # decides whether auto-heal restarts a pod that is working perfectly. Getting it
    # wrong for one person is a restart loop for that person.
    #
    # `None` means "use the deployment default", which is what every existing caller
    # gets and why this is additive.
    resource_tier: Optional[str] = None


@dataclass(frozen=True)
class BackendHandle:
    """What a backend returns after provisioning: how to reach + identify the host.

    All fields default to ``None`` so a logical/mass-tier stamp (no dedicated
    deploy) is expressible as an empty handle, and the registry keeps its schema
    NULLs. ``backend`` records which provider produced the handle.
    """

    external_agent_id: Optional[str] = None
    a2a_route: Optional[str] = None
    status: str = TIER_LOGICAL
    backend: Optional[str] = None
    backend_metadata: Optional[dict[str, Any]] = None
    attestation_ref: Optional[str] = None


@dataclass(frozen=True)
class BackendStatus:
    """Health/liveness of a provisioned host, for the reconcile loop."""

    external_agent_id: Optional[str]
    status: str
    healthy: bool


@runtime_checkable
class ComputeBackend(Protocol):
    """A pluggable host for a user's agent. Every backend speaks this contract."""

    backend_id: str

    async def provision(self, spec: PodSpec) -> BackendHandle: ...

    async def deprovision(self, external_agent_id: str) -> None: ...

    async def get(self, external_agent_id: str) -> BackendStatus: ...

    def render_deploy_config(self, spec: PodSpec) -> dict[str, Any]: ...

    async def health(self) -> bool: ...


class NullBackend:
    """The inert default: provisions nothing, tears down nothing, calls out nowhere.

    ``provision`` returns an empty, logical handle, so the provisioning brain
    records exactly what it recorded in Phase 0 -- a registry stamp with NULL host
    fields. ``deprovision``/``get`` are no-ops. This is what keeps the seam inert
    until a real backend is implemented and explicitly selected.
    """

    backend_id = BACKEND_NULL

    async def provision(self, spec: PodSpec) -> BackendHandle:
        # An all-None handle: nothing to persist, so a NullBackend-provisioned row
        # keeps its schema NULLs -- behavior identical to an unthreaded Phase-0 stamp.
        return BackendHandle(status=TIER_LOGICAL)

    async def deprovision(self, external_agent_id: str) -> None:
        return None

    async def get(self, external_agent_id: str) -> BackendStatus:
        return BackendStatus(
            external_agent_id=(external_agent_id or None), status="unknown", healthy=False
        )

    def render_deploy_config(self, spec: PodSpec) -> dict[str, Any]:
        # No host to deploy -> no artifact.
        return {}

    async def health(self) -> bool:
        return True


def resolve_compute_backend(backend_id: Optional[str] = None) -> ComputeBackend:
    """Map the ``PERSONAL_AGENT_BACKEND`` setting to a backend instance.

    Unset / empty / ``null`` / ``none`` -> ``NullBackend`` (inert), so a
    half-configured env can never silently attempt a real host call. The primary is
    chosen per workload class: ``anypoint`` is **primary for general / mass-market
    deployments** (CloudHub 2.0 / Runtime Fabric; primary because of Hushh's
    pre-purchased Titanium capacity; FedRAMP Moderate; dedicated MuleSoft team);
    ``gcp`` is **primary for the FedRAMP-High / regulated tier** (Cloud Run +
    Confidential Space; FedRAMP High, and the validated, live-wired backend);
    ``user_gcp`` is the BYOC sovereign tier. Each is built but starts in
    plan/dry-run mode — it renders the deploy artifact + handle and makes NO live
    call until explicitly enabled with credentials. ``backend_id`` overrides the
    setting (used by tests).
    """
    from hushh_mcp.runtime_settings import personal_agent_backend

    chosen = (backend_id if backend_id is not None else personal_agent_backend()).strip().lower()
    if chosen in ("", BACKEND_NULL, "none"):
        return NullBackend()
    if chosen == BACKEND_GCP:
        from hushh_mcp.services.gcp_backend import GcpBackend

        # Defaults to inert plan/dry-run mode: it renders deploy artifacts + handles
        # but makes NO live GCP call until explicitly enabled with credentials.
        gcp: ComputeBackend = GcpBackend()
        return gcp
    if chosen == BACKEND_ANYPOINT:
        from hushh_mcp.services.anypoint_backend import AnypointBackend

        anypoint: ComputeBackend = AnypointBackend()
        return anypoint
    if chosen == BACKEND_USER_GCP:
        from hushh_mcp.services.user_gcp_backend import UserGcpBackend

        # BYOC: renders the pod + a keyless WIF bootstrap plan for the USER's project.
        # Plan-mode by default; live raises until the WIF bootstrap exists.
        user_gcp: ComputeBackend = UserGcpBackend()
        return user_gcp
    raise NotImplementedError(
        f"compute backend '{chosen}' is not recognized "
        "(expected: null | gcp | anypoint | user_gcp; see docs/future/personal-agent/ROADMAP.md M4/M6/M7)"
    )


def resolve_compute_backend_for_spec(spec: PodSpec) -> ComputeBackend:
    """Pick the backend for ONE person, from their own spec.

    `resolve_compute_backend()` answers "what does this deployment run?" — a
    process-wide question, and the only one that could be asked while both axes lived
    in environment variables. This answers "where does THIS person's pod run?", which
    is the question BYOC actually poses: their pod runs in their project whatever the
    hub happens to be configured for.

    Falls back to the deployment default when the spec names no target, so this is a
    superset of the existing behaviour rather than a second, competing resolver. An
    unrecognised target still raises through `resolve_compute_backend` — a person
    whose stored target is a typo must fail loudly, not silently land on the hub's
    default, which for a BYOC user would mean provisioning into hushh's project
    instead of their own. That is the one failure mode worth being noisy about.
    """
    return resolve_compute_backend(spec.deployment_target or None)
