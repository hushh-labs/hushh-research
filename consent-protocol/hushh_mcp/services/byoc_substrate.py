"""Ensure per-owner substrate through the existing bootstrap and retain bounded receipts.

The provisioning service resolves an ensurer for every target. User-cloud targets
invoke ``UserGcpBootstrap``; targets without substrate use ``NoSubstrateRequired``.
Provider credentials remain transient and provider response bodies are not persisted.

Receipts retain the planned typed inventory, plan digest and qualified creation
observations. Only bucket and service-account identity fields currently have
validators. Successful bootstrap may adopt existing resources, so neither ``applied``
nor a resource name authorizes deletion. Creation observations are also insufficient
without lifecycle admission and current-incarnation checks. Interrupted bootstrap
before receipt persistence remains unqualified for automatic cleanup.

The ensurer stays behind the provider-neutral provisioning boundary. It is not a
second infrastructure state store or a fleet-wide authority over owner projects.
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


def _bucket_creation_identity(value: Any, expected_name: str) -> dict[str, str] | None:
    """Select bounded identity fields, never copy a provider response into a receipt."""
    from datetime import datetime

    if not isinstance(value, dict) or value.get("name") != expected_name:
        return None
    for key in ("generation", "projectNumber"):
        field_value = value.get(key)
        if (
            not isinstance(field_value, str)
            or not 1 <= len(field_value) <= 20
            or not field_value.isascii()
            or not field_value.isdigit()
            or int(field_value) <= 0
        ):
            return None
    created = value.get("timeCreated")
    if not isinstance(created, str) or len(created) > 64:
        return None
    try:
        if datetime.fromisoformat(created.replace("Z", "+00:00")).tzinfo is None:
            return None
    except ValueError:
        return None
    return {key: value[key] for key in ("name", "generation", "projectNumber", "timeCreated")}


def _service_account_creation_identity(value: Any, expected_email: str) -> dict[str, str] | None:
    if not isinstance(value, dict) or value.get("email") != expected_email:
        return None
    project = expected_email.partition("@")[2].removesuffix(".iam.gserviceaccount.com")
    uid = value.get("uniqueId")
    if (
        not project
        or value.get("projectId") != project
        or not isinstance(uid, str)
        or not 1 <= len(uid) <= 32
        or not uid.isascii()
        or not uid.isdigit()
        or int(uid) <= 0
        or value.get("name")
        not in {
            f"projects/{project}/serviceAccounts/{expected_email}",
            f"projects/{project}/serviceAccounts/{uid}",
        }
    ):
        return None
    return {key: value[key] for key in ("name", "email", "projectId", "uniqueId")}


@dataclass(frozen=True)
class SubstrateReceipt:
    """Applied substrate identifiers, including resources adopted during bootstrap.

    Deliberately carries no resource ATTRIBUTES. A reader can tell that
    ``one-pod-<slug>-key`` exists; it cannot learn the key, the bucket's configuration,
    or any seeded secret. That boundary is the reason this type exists rather than a
    stashed copy of the plan. A successful receipt does not establish exclusive
    creation or authorize deletion: bootstrap can accept existing resources, and
    project membership alone does not prove this pod owns them. Cleanup requires
    separately retained typed inventory and resource-specific ownership evidence.

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
    planned_resources: list[dict[str, str]] = field(default_factory=list)
    resource_observations: list[dict[str, Any]] = field(default_factory=list)

    @property
    def failed_steps(self) -> list[dict[str, Any]]:
        """Genuine failures, excluding steps skipped because a prerequisite failed."""
        return [s for s in self.steps if not s.get("ok", True) and not s.get("skipped")]

    def as_record(self) -> dict[str, Any]:
        """The persisted form. Identifiers only -- never attributes, never key material."""
        record: dict[str, Any] = {
            "version": RECEIPT_VERSION,
            "tenantRef": self.tenant_ref,
            "resourceIds": list(self.resource_ids),
            "planDigest": self.plan_digest,
            "grantRef": self.grant_ref,
            "applied": self.applied,
        }
        if self.planned_resources:
            # Preserve types for future reconciliation, never provider bodies or
            # a claim that a planned resource was exclusively created.
            record["plannedResources"] = [
                {"type": item["type"], "id": item["id"]} for item in self.planned_resources
            ]
        observations = []
        planned = {(item["type"], item["id"]) for item in self.planned_resources}
        validators = {
            "gcs_bucket": _bucket_creation_identity,
            "service_account": _service_account_creation_identity,
        }
        for observation in self.resource_observations:
            if (
                not isinstance(observation, dict)
                or not isinstance(observation.get("type"), str)
                or observation["type"] not in validators
                or observation.get("disposition") != "created"
                or not isinstance(observation.get("id"), str)
                or (observation["type"], observation["id"]) not in planned
            ):
                continue
            identity = validators[observation["type"]](
                observation.get("identity"), observation["id"]
            )
            if identity:
                observations.append(
                    {
                        "type": observation["type"],
                        "id": observation["id"],
                        "disposition": "created",
                        "identity": identity,
                    }
                )
        if observations:
            record["resourceObservations"] = observations
        return record


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
        except Exception:
            logger.warning("byoc_substrate.plan_failed")
            return SubstrateReceipt(False, tenant_ref, detail="bootstrap plan unavailable")

        resources = plan.get("resources") if isinstance(plan, dict) else None
        if not isinstance(resources, list) or any(
            not isinstance(item, dict)
            or not isinstance(item.get("type"), str)
            or not item["type"].strip()
            or not isinstance(item.get("id"), str)
            or not item["id"].strip()
            for item in resources
        ):
            return SubstrateReceipt(
                False, tenant_ref, detail="bootstrap resource inventory invalid"
            )
        planned_resources = [{"type": item["type"], "id": item["id"]} for item in resources]
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
                    # Impersonation refusal cannot distinguish "grant revoked"
                    # from "the project itself is gone" (both answer the same
                    # way), so the detail names both rather than misdiagnosing a
                    # deleted project as a revoked grant (audit finding,
                    # 2026-08-21).
                    detail=(
                        "hushh could not act in the target project: the bootstrap "
                        "grant is missing or revoked, or the project no longer "
                        "exists. Check the project in Google Cloud, or switch to "
                        "a different project in Setup."
                    ),
                )

        factory = self._bootstrap_factory or UserGcpBootstrap
        try:
            bootstrap = factory(
                project=self._project,
                region=self._region,
                token=token,
                bootstrap_sa=self._bootstrap_sa,
            )
            # The spec's substrate observer rides through to_thread as a kwarg. The
            # applier's loop is synchronous on that worker thread, which is exactly
            # why the observer contract is sync -- see PodSpec.on_substrate_step.
            outcome = await asyncio.to_thread(
                bootstrap.apply,
                plan,
                dry_run=self._dry_run,
                on_step=getattr(spec, "on_substrate_step", None),
            )
        except BootstrapError:
            return SubstrateReceipt(
                False,
                tenant_ref,
                resource_ids=ids,
                plan_digest=digest,
                detail="bootstrap configuration unavailable",
            )
        except Exception:
            logger.warning("byoc_substrate.apply_failed")
            return SubstrateReceipt(
                False,
                tenant_ref,
                resource_ids=ids,
                plan_digest=digest,
                detail="bootstrap execution unavailable",
            )

        if not isinstance(outcome, dict):
            return SubstrateReceipt(
                False,
                tenant_ref,
                resource_ids=ids,
                plan_digest=digest,
                grant_ref=grant_ref,
                detail="bootstrap result unavailable",
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
                planned_resources=planned_resources,
                detail="dry run: nothing was created",
                steps=list(outcome.get("steps") or []),
            )

        raw_steps = outcome.get("results", outcome.get("steps"))
        valid_steps = (
            isinstance(raw_steps, list)
            and bool(raw_steps)
            and all(
                isinstance(step, dict) and isinstance(step.get("step"), str) and step["step"]
                for step in raw_steps
            )
        )
        steps = raw_steps if valid_steps else []
        failures = [step for step in steps if step.get("ok") is not True or step.get("skipped")]
        applied = (
            outcome.get("dryRun") is False
            and outcome.get("ok") is True
            and outcome.get("project") == self._project
            and valid_steps
            and not failures
        )
        receipt = SubstrateReceipt(
            applied=applied,
            planned_resources=planned_resources,
            tenant_ref=tenant_ref,
            resource_ids=ids,
            plan_digest=digest,
            grant_ref=grant_ref,
            steps=steps,
            resource_observations=[
                step["resourceObservation"]
                for step in steps
                if isinstance(step.get("resourceObservation"), dict)
            ],
            detail="" if applied else "bootstrap completion unconfirmed",
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
            first = failures[0] if failures else {}
            logger.error(
                "byoc_substrate.incomplete hushh_id=%s tenant=%s first_failure=%s",
                hushh_id,
                tenant_ref,
                first.get("step", "<unknown>"),
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
