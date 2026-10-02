"""Compute contracts for the private agent.

``user_gcp`` provisions in the owner's Google Cloud project; ``user_azure`` in the
owner's own Azure subscription (dev workspace only until its admission gates in
``docs/reference/architecture/byoc-azure.md`` carry live evidence); ``gcp`` serves
the gated Hussh-managed tier. ``NullBackend`` is an inert unconfigured state, not a
deployment provider. Live provisioning still requires explicit configuration and
owner authority. The backend protocol keeps lifecycle, identity and recovery
contracts independent of provider adapters.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from dataclasses import field as dataclass_field
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
BACKEND_USER_GCP = "user_gcp"  # BYOC: the pod runs in the USER's own GCP project.
BACKEND_USER_AZURE = "user_azure"  # BYOC: the pod runs in the USER's own Azure subscription.

# Targets whose pod runs in the PERSON's own cloud account (BYOC), on any provider.
# Callers outside this module ask "is this the owner's own cloud?" through
# `is_owner_cloud_target` instead of spelling a provider id, so adding a provider
# is one entry here rather than a new branch at every call site. Ordered, so the
# SQL fragment and its bind names are deterministic.
OWNER_CLOUD_TARGETS: tuple[str, ...] = (BACKEND_USER_GCP, BACKEND_USER_AZURE)

# WHICH coordinates make an owner cloud reachable, per target. Read through
# `owner_cloud_coordinates_complete` so the readiness gate in user_cloud_service
# never spells a provider. An Azure location rides the neutral region coordinate.
_OWNER_CLOUD_REQUIRED_COORDINATES: dict[str, tuple[str, ...]] = {
    BACKEND_USER_GCP: ("project",),
    BACKEND_USER_AZURE: ("tenant_id", "subscription_id", "resource_group", "region"),
}


def is_owner_cloud_target(target: object) -> bool:
    """True when ``target`` places the pod in the person's own cloud account."""
    return str(target or "").strip() in OWNER_CLOUD_TARGETS


def owner_cloud_coordinates_complete(target: object, coordinates: Mapping[str, object]) -> bool:
    """True when every coordinate ``target`` needs is present and non-blank.

    An unknown target has no declared coordinates and is never complete, so a new
    provider fails closed until it states what makes it reachable.
    """
    required = _OWNER_CLOUD_REQUIRED_COORDINATES.get(str(target or "").strip())
    if not required:
        return False
    return all(str(coordinates.get(name) or "").strip() for name in required)


def is_known_pod_target(target: object) -> bool:
    """True for any placement a pod may run on: the hosted tier or an owner cloud."""
    return str(target or "").strip() in (BACKEND_GCP, *OWNER_CLOUD_TARGETS)


def owner_cloud_bind() -> dict[str, list[str]]:
    """Bind ``:owner_cloud_targets`` for static SQL: ``deployment_target = ANY(:owner_cloud_targets)``.

    A bound list keeps the provider ids out of the statement text, so registry SQL
    stays provider-neutral without building SQL from strings.
    """
    return {"owner_cloud_targets": list(OWNER_CLOUD_TARGETS)}


# --- the pod's resource profile, in ONE place -------------------------------------
#
# GCP renderers share this baseline. Per-owner configuration may override it.
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
    # The OPAQUE cost-attribution id, not the owner's handle. See
    # personal_agent_identity_service.mint_billing_space_id: this becomes the
    # hussh-billing-space cloud label, so it must disclose nothing on its own.
    # The spaceID handle the owner chooses lives on the registry row, never here.
    billing_space_id: Optional[str] = None
    consent_binding_ref: Optional[str] = None
    runtime_version: Optional[str] = None
    prompt_version: Optional[str] = None
    # Recorded provider incarnation for an in-place upgrade; never inferred from a name.
    expected_service_uid: Optional[str] = None
    # Recorded workload identity and image digest of an EXISTING pod, copied from the
    # registry for adoption; a backend that can read both refuses a pod that differs.
    expected_runtime_principal: Optional[str] = None
    expected_image_digest: Optional[str] = None
    # Opaque binding to the existing registry upgrade reservation.
    upgrade_attempt_id: Optional[str] = None
    # Durable owner approval operation used by the pod lifecycle handoff.
    upgrade_operation_id: Optional[str] = None
    # Immutable image reference captured by the approval record. Providers must
    # execute this value, never re-resolve a mutable deployment tag.
    upgrade_target_image: Optional[str] = None
    provision_attempt_id: Optional[str] = None
    on_provision_ack: Optional[Callable[[dict[str, Any]], None]] = dataclass_field(
        default=None, repr=False, compare=False
    )
    # Called off the event loop after provider acknowledgement, before polling.
    on_upgrade_ack: Optional[Callable[[dict[str, Any]], None]] = dataclass_field(
        default=None, repr=False, compare=False
    )
    # Called after the authenticated pod has produced its bound idle receipt,
    # before any image copy or service replacement begins.
    on_upgrade_idle: Optional[Callable[[dict[str, Any]], None]] = dataclass_field(
        default=None, repr=False, compare=False
    )
    # Present only for a separately approved Files resource/configuration delta.
    files_upgrade_plan: Optional[dict[str, Any]] = dataclass_field(default=None, repr=False)
    # Only a fenced maintenance recovery may supply already-acknowledged steps.
    files_upgrade_completed_steps: Optional[list[dict[str, Any]]] = dataclass_field(
        default=None, repr=False
    )
    on_files_upgrade_checkpoint: Optional[Callable[[str, str, list[dict]], None]] = dataclass_field(
        default=None, repr=False, compare=False
    )

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

    # -- WHERE, precisely: the coordinates of the person's own cloud --------------
    #
    # `deployment_target` says which KIND of place a pod runs in. These say WHICH one.
    # Without them the target was per-person while the destination stayed a
    # process-wide environment variable, so the second person to choose their own
    # cloud had their pod, their bucket and their KMS key built inside the FIRST
    # person's project. That is an isolation failure, not a configuration gap, and it
    # is the reason a target alone was never enough.
    #
    # The bootstrap account is carried rather than derived from the project name for
    # the reason `UserGcpBackend` already gives about identities: a guessed account
    # that happens to exist would be used silently, and the whole point of the grant
    # is that it was deliberately made.
    #
    # `None` means "fall back to the deployment default", which is what every
    # pre-existing caller gets. A target of `user_gcp` with no project is refused
    # rather than defaulted -- a fallback that resolves to "somebody's project" is
    # exactly the failure these fields exist to remove.
    user_cloud_project: Optional[str] = None
    user_cloud_region: Optional[str] = None
    user_cloud_bootstrap_sa: Optional[str] = None
    # The same "which one" for an Azure subscription: directory (tenant), subscription
    # and the resource group the person's own setup created. The Azure location rides
    # `user_cloud_region`, so one coordinate never has two columns. Deployment topology,
    # recorded by the setup job, never inferred: a `user_azure` spec missing any of
    # them is refused by `resolve_compute_backend_for_spec`.
    user_cloud_tenant_id: Optional[str] = None
    user_cloud_subscription_id: Optional[str] = None
    user_cloud_resource_group: Optional[str] = None
    # Frozen owner setup selection; a fleet flag cannot grant this capability.
    files_library_enabled: bool = False

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

    # -- the fourth axis: who may dial THIS person's pod --------------------------
    #
    # `hub`: the pod is reachable by the hub alone (internal ingress, one invoker),
    # which is every pod today. `direct`: the owner's app and device dial the pod
    # themselves (public ingress, `allUsers` invoker, a request timeout long enough
    # for a local model), and the pod's in-process ingress policy is the lock that
    # keeps its machine routes hub-only. Deployment topology, so it lives here and
    # on the registry row (`backend_metadata.ingress`), never in the pod's
    # configuration record, which is about behaviour.
    #
    # `None` means `hub`. `direct` is refused by the renderer outside the dev lane.
    ingress: Optional[str] = None

    # -- narrative callbacks: how a stage says it happened ------------------------
    #
    # OPAQUE callables, injected by the provisioning service, defaulting to None.
    # This is the seam that keeps the compute backends DB-free: `gcp_backend`
    # imports no database and PodSpec carries no user_id (deliberately -- a pod
    # spec that named its person would leak identity into every render), so the
    # backends cannot write narrative themselves. They fire a callback that knows
    # nothing about where the story goes.
    #
    # Both fire ON WORKER THREADS (`_run()` and the bootstrap loop run under
    # asyncio.to_thread), so the supplied closures must be synchronous and must
    # never raise -- the emitters in pod_lifecycle_log honor both. Excluded from
    # comparison and repr: two specs describing the same pod are the same spec
    # regardless of who is listening, and a repr must never print a closure.
    on_stage: Optional[Any] = dataclass_field(default=None, compare=False, repr=False)
    on_substrate_step: Optional[Any] = dataclass_field(default=None, compare=False, repr=False)

    def emit_stage(self, stage: str) -> None:
        """Fire on_stage, swallowing everything. Narrative must never break a build."""
        if self.on_stage is None:
            return
        try:
            self.on_stage(stage)
        except Exception:  # noqa: BLE001 - a listener's bug is not the pod's problem
            pass


def adoption_expectations(metadata: object) -> dict[str, Optional[str]]:
    """What a registry row recorded about its pod, as the PodSpec fields adoption checks.

    Copied, never inferred: a backend that can read a pod's workload identity and
    image refuses to adopt one that differs. Malformed metadata records nothing.
    """
    recorded = metadata if isinstance(metadata, dict) else {}
    return {
        "expected_runtime_principal": str(recorded.get("runtime_principal_id") or "") or None,
        "expected_image_digest": str(recorded.get("image_digest") or "") or None,
    }


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


class PodBootFailedError(RuntimeError):
    """The platform returned a DEFINITIVE verdict that the pod's revision failed to
    start (e.g. Cloud Run Ready==False). Distinct from a slow boot, which times out
    with no verdict and stays retryable. Lives here, not in a provider module,
    because the provisioning service must classify it for the user-safe failure
    reason and Layer 1 may not name a cloud (test_deployment_boundary_holds).
    """


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


# Optional lifecycle capabilities, outside the five methods every provider owes: the
# shared layer asks isinstance(backend, <capability>), never a provider id or getattr.


@runtime_checkable
class RestartableBackend(Protocol):
    """Heal in place with standing authority; never a re-provision."""

    async def restart(self, spec: PodSpec) -> dict[str, Any]: ...


@runtime_checkable
class OwnerAccessErasableBackend(Protocol):
    """Erase where the hub holds no delete authority: the pod crypto-erases (``crypto_erase``,
    the hub's proof call), access is revoked, the hub's own last; returns the receipt."""

    backend_id: str

    async def observe_erasure_target(self, spec: PodSpec) -> dict[str, str]: ...

    async def erase_owner_access(
        self, spec: PodSpec, *, crypto_erase: Callable[[], Awaitable[dict]]
    ) -> dict[str, Any]: ...


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
    """Resolve configured GCP hosting; empty/null remains safely unconfigured."""
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
    if chosen == BACKEND_USER_GCP:
        from hushh_mcp.services.user_gcp_backend import UserGcpBackend

        # BYOC: renders the pod + a keyless impersonation bootstrap plan for the USER's project.
        # Plan-mode by default; live raises until the owner bootstrap exists.
        user_gcp: ComputeBackend = UserGcpBackend()
        return user_gcp
    # `user_azure` is deliberately absent: it has no deployment-wide destination, so it
    # resolves only per person, through `resolve_compute_backend_for_spec`.
    raise NotImplementedError(
        f"compute backend '{chosen}' is not recognized (expected: null | gcp | user_gcp)"
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
    target = (spec.deployment_target or "").strip() or None
    if target == BACKEND_USER_AZURE:
        return _owner_azure_backend(spec)
    if target != BACKEND_USER_GCP:
        return resolve_compute_backend(target)

    # The tenant-bearing branch. `resolve_compute_backend` constructs its backends with
    # no arguments, which is right for every target whose destination is a property of
    # the deployment -- and exactly wrong for the one whose destination is a property of
    # the PERSON. Routing this branch through the generic resolver is what put two
    # people's pods in one project.
    if not (spec.user_cloud_project or "").strip():
        raise ValueError(
            "a user_gcp pod needs the person's own project on its spec, and it is never "
            "inferred. Falling back to HUSSH_USER_GCP_PROJECT here would build this "
            "person's pod inside whichever project that variable happens to name -- "
            "which, with more than one BYOC person, is somebody else's cloud."
        )

    from hushh_mcp.services.user_gcp_backend import UserGcpBackend

    tenant: ComputeBackend = UserGcpBackend(
        user_project=spec.user_cloud_project,
        user_region=spec.user_cloud_region or None,
        bootstrap_sa=spec.user_cloud_bootstrap_sa or None,
    )
    return tenant


def _owner_azure_backend(spec: PodSpec) -> ComputeBackend:
    """The person's own Azure subscription, from their spec alone. Fails closed.

    There is no deployment default for this target at all: a subscription is never a
    property of the hub, so a missing coordinate is refused rather than defaulted, for
    the same reason the GCP branch refuses a missing project.
    """
    coordinates = {
        "tenant_id": spec.user_cloud_tenant_id,
        "subscription_id": spec.user_cloud_subscription_id,
        "resource_group": spec.user_cloud_resource_group,
        "region": spec.user_cloud_region,
    }
    if not owner_cloud_coordinates_complete(BACKEND_USER_AZURE, coordinates):
        missing = sorted(name for name, value in coordinates.items() if not (value or "").strip())
        raise ValueError(
            "a user_azure pod needs the person's own tenant, subscription, resource group "
            f"and location on its spec, and none is ever inferred (missing: {missing})."
        )

    from hushh_mcp.services.user_azure_backend import UserAzureBackend

    azure: ComputeBackend = UserAzureBackend(
        tenant_id=str(spec.user_cloud_tenant_id).strip(),
        subscription_id=str(spec.user_cloud_subscription_id).strip(),
        resource_group=str(spec.user_cloud_resource_group).strip(),
        location=str(spec.user_cloud_region).strip(),
        recorded_principal=spec.expected_runtime_principal or "",
        recorded_digest=spec.expected_image_digest or "",
    )
    return azure
