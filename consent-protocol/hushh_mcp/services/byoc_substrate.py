"""Make a BYOC tenant's infrastructure exist, and keep a receipt rather than a mirror.

WHY THIS MODULE EXISTS

``UserGcpBootstrap`` is a complete applier -- ordered calls, long-running-operation
polling, secret seeding, IAM binding merge, bucket-ownership checks, dependency-aware
per-step results -- and it had **zero callers outside tests**. The only mention of it in
production code was a docstring in ``user_gcp_backend.py`` explaining that live
provisioning depends on it.

That missing call is the whole reason BYO GCP could not be reached.
``UserGcpBackend.provision`` is live-wired and gated on ``HUSSH_USER_GCP_LIVE`` **plus**
a completed bootstrap that nothing ever ran. Not a missing capability -- a missing call,
which is the same shape as every other defect this workstream has found.

RECEIPT, NOT STATE
------------------
This is where the Terraform decision (docs/reference/architecture/deployment-standard.md)
becomes code. Terraform's product is a *state file*: a durable record of every resource
it created **and every attribute of each one**. For a project hushh does not own, holding
that file is not bookkeeping -- it is the inverse of the promise. BYOC mints a
900-second impersonated token and holds nothing afterward; a state file would be a
permanent hushh-held mirror of a sovereign project, and because state records attributes
verbatim it would contain the customer's own pod signing key -- the exact value
``_seed_secret_version`` goes out of its way never even to echo.

So hushh keeps a **receipt**:

    state file  -> resource ATTRIBUTES     (configuration + secrets)
    receipt     -> resource IDENTIFIERS    (names, plan version, grant, timestamp)

Every BYOC resource name is already derived from the HusshID, so the receipt is a short
name list plus a plan digest -- recomputable, not a mirror. It delivers the three things
state was actually wanted for:

  * **teardown inventory** -- the real gap today: nothing records what was created in a
    customer's project, so nothing can clean it up;
  * **audit evidence** -- which plan version reached which tenant, when, under which grant;
  * **drift** -- re-impersonate with a fresh short-lived token, list, diff EXISTENCE.

The residual is honest and deliberate: per-tenant, consent-gated drift, never fleet-wide.
Fleet-wide drift across customer projects would require exactly the standing credential
this tier promises not to have.

STAYING PROVIDER-BLIND
----------------------
The orchestrator must not know which people need substrate -- knowing that means naming a
provider in the common layer, which ``tests/test_deployment_boundary_holds.py`` refuses.
So this follows the ``NullBackend`` pattern: the orchestrator ALWAYS ensures substrate,
and targets with none resolve to :class:`NoSubstrateRequired`.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
from dataclasses import dataclass, field
from typing import Any, Optional, Protocol

logger = logging.getLogger(__name__)

# Receipts are versioned so a later reader can tell which shape it is looking at
# without guessing from the keys present.
RECEIPT_VERSION = "byoc.substrate.receipt.v1"


@dataclass(frozen=True)
class SubstrateReceipt:
    """What was created, named but not described.

    Deliberately carries no resource ATTRIBUTES. A reader can tell that
    ``one-pod-<slug>-key`` exists; it cannot learn the key, the bucket's configuration,
    or any seeded secret. That boundary is the reason this type exists rather than a
    stashed copy of the plan.

    ``steps`` is kept because a half-applied project is a real state a caller has to
    reason about, and the applier goes to some trouble to report which half -- returning
    per-step results instead of raising on the first problem. Collapsing that to a
    boolean would discard the only information that makes a partial bootstrap
    recoverable. It is NOT persisted; only ``as_record()`` is.
    """

    applied: bool
    tenant_ref: str
    resource_ids: list[str] = field(default_factory=list)
    plan_digest: str = ""
    grant_ref: str = ""
    detail: str = ""
    steps: list[dict[str, Any]] = field(default_factory=list)

    @property
    def failed_steps(self) -> list[dict[str, Any]]:
        """Genuine failures, excluding steps skipped because a prerequisite failed."""
        return [s for s in self.steps if not s.get("ok", True) and not s.get("skipped")]

    def as_record(self) -> dict[str, Any]:
        """The persisted form. Identifiers only -- never attributes, never key material."""
        return {
            "version": RECEIPT_VERSION,
            "tenantRef": self.tenant_ref,
            "resourceIds": list(self.resource_ids),
            "planDigest": self.plan_digest,
            "grantRef": self.grant_ref,
            "applied": self.applied,
        }


def plan_digest(plan: dict[str, Any]) -> str:
    """A stable digest of the plan that was applied.

    Digests the resource TYPE and ID only -- not the rest of the plan. Two reasons, and
    the second is the load-bearing one:

      * those are the fields the receipt records, so the digest describes the receipt's
        own subject rather than something wider; and
      * the plan carries descriptive fields (an image reference, an encryption pointer)
        that can change without any resource changing. Digesting them would report drift
        every time a caption moved, which is how a drift signal becomes noise and then
        gets ignored.
    """
    identity = sorted(
        (str(r.get("type", "")), str(r.get("id", "")))
        for r in (plan.get("resources") or [])
        if isinstance(r, dict)
    )
    return hashlib.sha256(json.dumps(identity, separators=(",", ":")).encode()).hexdigest()[:16]


def resource_ids(plan: dict[str, Any]) -> list[str]:
    """Every resource identifier the plan would create, in a stable order."""
    return sorted(
        str(r["id"]) for r in (plan.get("resources") or []) if isinstance(r, dict) and r.get("id")
    )


class SubstrateEnsurer(Protocol):
    """Bring a tenant's substrate up, idempotently, and say what exists."""

    ensurer_id: str

    async def ensure(self, spec: Any, *, grant_ref: str = "") -> SubstrateReceipt: ...


class NoSubstrateRequired:
    """For every target whose infrastructure is not per-tenant.

    The hushh-managed tier shares one project whose substrate ships with the hub, and
    Anypoint's is an environment provisioned in AMC. Neither has anything to create per
    person, so this keeps the orchestrator's unconditional ``ensure`` free -- and keeps
    the conditional out of the common layer, where a provider name may not appear.
    """

    ensurer_id = "none"

    async def ensure(self, spec: Any, *, grant_ref: str = "") -> SubstrateReceipt:
        return SubstrateReceipt(
            applied=True,
            tenant_ref="",
            detail="this deployment target has no per-tenant substrate",
        )


class HushhFederatedSubstrate:
    """Hushh federates into the user's project, applies their plan, keeps a receipt.

    Keyless by construction: the token is minted by impersonating the USER's own
    bootstrap service account and is short-lived. ``mint_bootstrap_token`` fails loudly
    rather than falling back to hushh's identity, because a silent fallback would let
    this keep working after the user revoked their grant -- which is precisely the
    control being relied on.
    """

    ensurer_id = "hushh_federated"

    def __init__(
        self,
        *,
        project: str,
        region: str = "us-central1",
        bootstrap_sa: str = "",
        plan_renderer: Any = None,
        bootstrap_factory: Any = None,
        token_minter: Any = None,
        dry_run: Optional[bool] = None,
    ) -> None:
        self._project = project
        self._region = region
        self._bootstrap_sa = bootstrap_sa
        self._plan_renderer = plan_renderer
        self._bootstrap_factory = bootstrap_factory
        self._token_minter = token_minter
        # Dry-run is the DEFAULT, matching UserGcpBootstrap.apply. Creating durable
        # resources in someone else's cloud is opt-in at every layer, and a caller that
        # forgot to say so gets a plan rather than resources.
        self._dry_run = True if dry_run is None else bool(dry_run)

    def _render_plan(self, spec: Any) -> dict[str, Any]:
        if self._plan_renderer is not None:
            return self._plan_renderer(spec)
        from hushh_mcp.services.user_gcp_backend import UserGcpBackend  # noqa: PLC0415

        return UserGcpBackend(
            user_project=self._project, user_region=self._region
        ).render_bootstrap_plan(spec)

    async def ensure(self, spec: Any, *, grant_ref: str = "") -> SubstrateReceipt:
        from hushh_mcp.services.user_gcp_bootstrap import (  # noqa: PLC0415
            BootstrapError,
            UserGcpBootstrap,
            mint_bootstrap_token,
        )

        hushh_id = getattr(spec, "hushh_id", "") or "<none>"
        tenant_ref = f"{self._project}/{self._region}"

        try:
            plan = self._render_plan(spec)
        except Exception as exc:
            logger.exception(
                "byoc_substrate.plan_failed hushh_id=%s tenant=%s", hushh_id, tenant_ref
            )
            return SubstrateReceipt(False, tenant_ref, detail=f"plan render failed: {exc}")

        ids, digest = resource_ids(plan), plan_digest(plan)

        token = None
        if not self._dry_run:
            minter = self._token_minter or mint_bootstrap_token
            try:
                token = await asyncio.to_thread(minter, bootstrap_sa=self._bootstrap_sa)
            except Exception as exc:
                # The expected failure of a keyless design: the grant was never
                # completed, or it was revoked. It must read as that rather than as a
                # hushh outage, because the remedy is the user's, not ours.
                logger.warning(
                    "byoc_substrate.impersonation_refused hushh_id=%s tenant=%s "
                    "bootstrap_sa=%s err=%s",
                    hushh_id,
                    tenant_ref,
                    self._bootstrap_sa or "<unset>",
                    type(exc).__name__,
                )
                return SubstrateReceipt(
                    False,
                    tenant_ref,
                    resource_ids=ids,
                    plan_digest=digest,
                    grant_ref=grant_ref,
                    detail="the bootstrap grant is missing or revoked in the target project",
                )

        factory = self._bootstrap_factory or UserGcpBootstrap
        try:
            bootstrap = factory(
                project=self._project,
                region=self._region,
                token=token,
                bootstrap_sa=self._bootstrap_sa,
            )
            outcome = await asyncio.to_thread(bootstrap.apply, plan, dry_run=self._dry_run)
        except BootstrapError as exc:
            return SubstrateReceipt(
                False, tenant_ref, resource_ids=ids, plan_digest=digest, detail=str(exc)
            )
        except Exception as exc:
            logger.exception(
                "byoc_substrate.apply_failed hushh_id=%s tenant=%s", hushh_id, tenant_ref
            )
            return SubstrateReceipt(
                False,
                tenant_ref,
                resource_ids=ids,
                plan_digest=digest,
                detail=f"apply failed: {exc}",
            )

        if outcome.get("dryRun"):
            # `applied` stays False so a caller cannot read a plan as a result. The
            # identifiers are still returned: knowing what WOULD be created is the
            # point of a dry run.
            return SubstrateReceipt(
                applied=False,
                tenant_ref=tenant_ref,
                resource_ids=ids,
                plan_digest=digest,
                grant_ref=grant_ref,
                detail="dry run: nothing was created",
                steps=list(outcome.get("steps") or []),
            )

        steps = list(outcome.get("results") or outcome.get("steps") or [])
        failures = [s for s in steps if not s.get("ok", True) and not s.get("skipped")]
        receipt = SubstrateReceipt(
            applied=not failures,
            tenant_ref=tenant_ref,
            resource_ids=ids,
            plan_digest=digest,
            grant_ref=grant_ref,
            steps=steps,
        )
        if receipt.applied:
            logger.info(
                "byoc_substrate.applied hushh_id=%s tenant=%s resources=%d plan=%s",
                hushh_id,
                tenant_ref,
                len(ids),
                digest,
            )
        else:
            # Name the FIRST failure only. The applier already marks everything
            # downstream of it "not attempted", so listing them all reports one cause
            # as several problems -- the exact noise its dependency tracking exists to
            # prevent.
            first = failures[0]
            logger.error(
                "byoc_substrate.incomplete hushh_id=%s tenant=%s first_failure=%s detail=%s",
                hushh_id,
                tenant_ref,
                first.get("step", "<unknown>"),
                str(first.get("detail") or "")[:200],
            )
        return receipt


def resolve_substrate_ensurer(spec: Any) -> SubstrateEnsurer:
    """The substrate ensurer for THIS person's deployment target.

    Mirrors ``resolve_compute_backend_for_spec``: the same per-person question asked of
    the other half of the lifecycle. Anything without per-tenant infrastructure resolves
    to :class:`NoSubstrateRequired`, so the orchestrator calls ``ensure`` unconditionally
    and never branches on a provider name.
    """
    from hushh_mcp.runtime_settings import user_gcp_substrate_apply_enabled  # noqa: PLC0415
    from hushh_mcp.services.compute_backend import BACKEND_USER_GCP  # noqa: PLC0415

    if (getattr(spec, "deployment_target", None) or "").strip() != BACKEND_USER_GCP:
        return NoSubstrateRequired()

    # From the SPEC, not the environment. These three used to be process-wide reads,
    # which made per-tenant infrastructure single-tenant: the bucket, the KMS key, the
    # signing secret and the pod service account were all created in whichever project
    # HUSSH_USER_GCP_PROJECT named, for every person. Env survives only as the
    # single-tenant dev fallback, and only when the spec is silent.
    project = (
        getattr(spec, "user_cloud_project", None) or os.getenv("HUSSH_USER_GCP_PROJECT") or ""
    ).strip()
    if not project:
        # Refused rather than defaulted. An empty project previously built a substrate
        # pointed at "", and provisioning then raised SubstrateNotReadyError naming a
        # STEP -- so the error described the symptom and never the cause.
        raise ValueError(
            "a user_gcp substrate needs the person's own project, and it is never "
            "inferred. There is no safe default here: the fallback would apply this "
            "person's infrastructure inside another person's cloud."
        )

    return HushhFederatedSubstrate(
        project=project,
        region=(
            getattr(spec, "user_cloud_region", None)
            or os.getenv("HUSSH_USER_GCP_REGION")
            or "us-central1"
        ).strip(),
        bootstrap_sa=(
            getattr(spec, "user_cloud_bootstrap_sa", None)
            or os.getenv("HUSSH_USER_GCP_BOOTSTRAP_SA")
            or ""
        ).strip(),
        dry_run=not user_gcp_substrate_apply_enabled(),
    )
