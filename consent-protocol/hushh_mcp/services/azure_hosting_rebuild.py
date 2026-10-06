"""Microsoft removed the person's idle Azure hosting space: say so, and rebuild by adoption.

Microsoft deletes a Container Apps environment that stays idle for more than 90 days
("Azure Container Apps environments", section *Policies*, learn.microsoft.com, page
dated 2026-02-26). Idle is "no active container apps or jobs running in the
environment"; the page does not say whether an app scaled to zero counts, and our
agent scales to zero, so treat it as exposed. The deletion takes the environment and
the agent inside it. The resource group, the agent identity, the Key Vault (key and
signing secret) and the storage account are separate resources and survive it, so
the person's memory and keys are intact.

TWO READS, TWO AUTHORITIES (byoc-azure.md trust matrix)
* Standing, ``hosting_state``: Hussh's observer reads only the agent and its
  environment. A 404 on both is ``hosting_reclaimed``. A 403 on both is
  ``hosting_unconfirmed``: the owner removed Hussh's access, OR the observer grants
  were deleted with the environment they were scoped to. Which one happens live is
  NOT measured, so both offer the same owner-approved check-and-rebuild.
* Just in time, ``survey_custody``: under the person's own sign-in and before any
  write, the rebuild reads the resource group (its setup binding), the environment
  and agent, the agent identity, the vault with its key and signing secret, and the
  storage account with its container. Only "environment gone, everything else
  present" proceeds; anything else is a typed refusal with nothing written.

THE REBUILD ADOPTS, IT NEVER MINTS. It reruns the owner-approved setup with the
group's own setup nonce, so every resource name is the same, and the applier in
adopt mode reads and keeps the identity, vault, key, secret, storage account and
container instead of writing them (``SetupApplier(adopt=True)``). Only the
environment, the agent and their grants are created again.

THE REBUILD RESTORES THE AUTHORIZATION. The hand-off to adoption flips the row to
``needs_reinit`` and, in the same fenced write, sets ``user_cloud_authorized_at``,
because the owner has just approved a fresh sign-in for this group. Clearing it the
way the confirmed-gone writer does would block every later update of the agent.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from hushh_mcp.services.azure_agent_observation import (
    AGENT_UNREADABLE,
    GONE_ACCESS_REMOVED,
    GONE_ENVIRONMENT_DELETED,
    GONE_OWNER_DELETED_AGENT,
    AzureAgentObservation,
    AzureAgentUnreadable,
)
from hushh_mcp.services.azure_arm_client import API_VERSIONS, ArmClient
from hushh_mcp.services.azure_setup_applier import AzureSetupRefused
from hushh_mcp.services.azure_setup_plan import (
    NONCE_TAG,
    PlanInputs,
    Scopes,
    group_id,
    resource_group_name,
    resource_names,
)

logger = logging.getLogger(__name__)

HOSTING_PRESENT = "present"
#: Environment and agent both 404: Microsoft's idle policy (or the owner) removed it.
HOSTING_RECLAIMED = "hosting_reclaimed"
#: Environment and agent both refused: access removed, or grants deleted with them.
HOSTING_UNCONFIRMED = "hosting_unconfirmed"
#: The environment is there and only the agent is gone: the owner deleted it.
HOSTING_AGENT_REMOVED = "agent_removed"
#: The agent read was refused while its environment reads (grants settling).
HOSTING_AGENT_UNREADABLE = "agent_unreadable"
HOSTING_UNKNOWN = "unknown"

#: States whose one action is the owner-approved check-and-rebuild.
REBUILDABLE: frozenset[str] = frozenset({HOSTING_RECLAIMED, HOSTING_UNCONFIRMED})

_STATE_BY_GONE_REASON: dict[str, str] = {
    GONE_ENVIRONMENT_DELETED: HOSTING_RECLAIMED,
    GONE_ACCESS_REMOVED: HOSTING_UNCONFIRMED,
    GONE_OWNER_DELETED_AGENT: HOSTING_AGENT_REMOVED,
    AGENT_UNREADABLE: HOSTING_AGENT_UNREADABLE,
}

#: Every rebuild failure is recorded under this prefix, so the hosting card can tell
#: a failed rebuild from a failed update on the same setup-job record.
REBUILD_CODE_PREFIX = "REBUILD_"
#: The first stage a rebuild writes, before it is spawned, so a RUNNING record can be
#: told from a setup's or an update's on the same row. The hosting card follows only
#: a running record that carries it.
REBUILD_STAGE = "rebuilding"


def is_rebuild_job(job: Optional[dict]) -> bool:
    """Whether this setup-job record is a rebuild's (it reported ``REBUILD_STAGE``)."""
    stages = [str(job.get("stage") or "")] if job else []
    stages += [str((entry or {}).get("stage") or "") for entry in (job or {}).get("stages") or []]
    return REBUILD_STAGE in stages


_NOTHING_CHANGED = "Nothing was changed."
_CUSTODY_MISSING = (
    "Part of your agent's storage or keys is no longer in your Azure subscription, so it "
    "cannot be rebuilt without starting a new agent. " + _NOTHING_CHANGED
)


def hosting_state(observation: AzureAgentObservation) -> str:
    """What the standing observer's two reads say about the hosting space."""
    if observation.present:
        return HOSTING_PRESENT
    return _STATE_BY_GONE_REASON.get(observation.gone_reason, HOSTING_UNKNOWN)


@dataclass(frozen=True)
class CustodySurvey:
    """What survived, read under the person's sign-in: the binding nonce and identity."""

    nonce: str
    principal_id: str


def _refuse(code: str, message: str) -> AzureSetupRefused:
    return AzureSetupRefused(message, code=code)


def _read(arm: ArmClient, path: str, api: str) -> Optional[dict[str, Any]]:
    found: Optional[dict[str, Any]] = arm.get_or_none(
        path, api_version=API_VERSIONS[api], op="rebuild_survey"
    )
    return found


def _bound_group(arm: ArmClient, *, subscription_id: str, hushh_id: str) -> str:
    """The setup nonce of THIS person's group; a missing or foreign group refuses."""
    from hushh_mcp.services.azure_agent_setup import binding_is_valid  # noqa: PLC0415

    group = _read(arm, group_id(subscription_id, resource_group_name(hushh_id)), "resources")
    if group is None:
        raise _refuse("REBUILD_GROUP_MISSING", _CUSTODY_MISSING)
    if not binding_is_valid(group.get("tags"), hushh_id):
        raise _refuse(
            "RESOURCE_GROUP_FOREIGN",
            "A resource group with your agent's name exists but was not created by "
            "Hussh's setup for you. " + _NOTHING_CHANGED,
        )
    return str(group["tags"][NONCE_TAG])


def _require_hosting_gone(arm: ArmClient, scopes: Scopes) -> None:
    if _read(arm, scopes.app, "container_apps") is not None:
        raise _refuse(
            "REBUILD_NOT_NEEDED",
            "Your agent is still in your Azure subscription. " + _NOTHING_CHANGED,
        )
    if _read(arm, scopes.environment, "container_apps") is not None:
        raise _refuse(
            "REBUILD_AGENT_REMOVED",
            "Your agent's hosting space is still there; only the agent was removed. "
            + _NOTHING_CHANGED,
        )


def _surviving_principal(arm: ArmClient, scopes: Scopes, recorded_principal: str) -> str:
    identity = _read(arm, scopes.identity, "managed_identity")
    principal = str(((identity or {}).get("properties") or {}).get("principalId") or "")
    if not principal:
        raise _refuse("REBUILD_IDENTITY_MISSING", _CUSTODY_MISSING)
    if recorded_principal and principal != recorded_principal:
        raise _refuse(
            "REBUILD_IDENTITY_CHANGED",
            "Your agent's identity in Azure is not the one Hussh recorded. " + _NOTHING_CHANGED,
        )
    return principal


def survey_custody(
    arm: ArmClient, *, subscription_id: str, hushh_id: str, recorded_principal: str
) -> CustodySurvey:
    """Read-only, under the person's token: proceed only when just the hosting is gone."""
    nonce = _bound_group(arm, subscription_id=subscription_id, hushh_id=hushh_id)
    inputs = PlanInputs(
        hushh_id=hushh_id,
        tenant_id="",
        subscription_id=subscription_id,
        location="",
        resource_group=resource_group_name(hushh_id),
        nonce=nonce,
    )
    scopes = Scopes(inputs, resource_names(inputs))
    _require_hosting_gone(arm, scopes)
    principal = _surviving_principal(arm, scopes, recorded_principal.strip())
    custody = (
        ("vault", scopes.vault, "key_vault"),
        ("key", scopes.key, "key_vault"),
        ("signing_secret", scopes.secret, "key_vault"),
        ("storage", scopes.storage, "storage"),
        ("container", scopes.container, "storage"),
    )
    for label, path, api in custody:
        if _read(arm, path, api) is None:
            logger.warning("azure_rebuild.custody_missing which=%s", label)
            raise _refuse("REBUILD_CUSTODY_MISSING", _CUSTODY_MISSING)
    return CustodySurvey(nonce=nonce, principal_id=principal)


def _same_agent(row: Optional[dict], expected: dict[str, str]) -> bool:
    return bool(row) and all(
        str((row or {}).get(key) or "") == value for key, value in expected.items()
    )


#: The lifecycle states ``mark_needs_reinit`` may flip from: never an in-progress,
#: suspended or erasing row. Kept identical to that writer's allowlist.
_REINIT_FROM: frozenset[str] = frozenset(
    {"pending", "unprovisioned", "provisioned", "provisioning_failed", "needs_reinit"}
)
#: The Azure placement the person just signed in for; the write fences on it too.
_AZURE_PLACEMENT = (
    "user_cloud_tenant_id",
    "user_cloud_subscription_id",
    "user_cloud_resource_group",
)


def _hand_to_adoption(db: Any, row: dict) -> bool:
    """One fenced UPDATE: ``needs_reinit`` for adoption, and the authorization RESTORED.

    ``mark_needs_reinit`` is the confirmed-gone writer and clears
    ``user_cloud_authorized_at`` on purpose: nobody has re-authorized the project. A
    rebuild is the opposite case. The owner has just approved a fresh Microsoft sign-in
    for this exact group, and the agent has been rebuilt there. Clearing the
    authorization here would leave ``UserCloud.blocks_provisioning`` True forever, so
    ``upgrade_pod`` (and with it every Azure update) would refuse the rebuilt agent.
    The write matches on the same fresh snapshot ``mark_needs_reinit`` uses, plus the
    Azure placement. A row changed since then, such as erasure, a new host or a new
    cloud, matches nothing, and the write changes nothing.
    """
    from hushh_mcp.services.personal_agent_registry_repo import (  # noqa: PLC0415
        registry_host_snapshot,
    )

    snapshot = registry_host_snapshot(row)
    if snapshot is None or not snapshot["updated_at"] or snapshot["status"] not in _REINIT_FROM:
        return False
    fence = {**snapshot, **{key: row.get(key) for key in _AZURE_PLACEMENT}}
    now = datetime.now(timezone.utc).isoformat()
    query = db.table("personal_agent_registry").update(
        {"status": "needs_reinit", "user_cloud_authorized_at": now, "updated_at": now}
    )
    for key, value in fence.items():
        query = query.is_(key, None) if value is None else query.eq(key, value)
    return bool(query.execute().data or [])


async def _require_own_job(jobs: Any, *, user_id: str, job_id: str) -> None:
    """The setup-job row must still be THIS rebuild, running; otherwise it was superseded.

    A pre-check, not a row lock: ``record_proven_azure_cloud`` locks the job row in the
    same transaction as its write, and this hand-off's write goes through the table
    builder, which cannot join that transaction. Single-flight still rests on the
    atomic claim; this stops a superseded rebuild from handing off over a newer job.
    """
    from hushh_mcp.services.byoc_setup_job_service import JobSuperseded  # noqa: PLC0415

    job = await jobs.get(user_id)
    if not job or job.get("job_id") != job_id or job.get("status") != "running":
        raise JobSuperseded(f"job {job_id} no longer owns the row")


async def record_rebuilt_agent(
    *,
    user_id: str,
    expected: dict[str, str],
    registry: Any,
    jobs: Any = None,
    job_id: str = "",
) -> None:
    """Hand the rebuilt agent to adoption, with its cloud authorization restored.

    ``expected`` is what the job started from: the HusshID, the target, the agent id
    and the Azure placement. The row is re-read now, not when the job started, so a
    five-minute rebuild does not lose to a heartbeat column write. A change DURING the
    rebuild is caught by ``expected`` and the status allowlist; ``updated_at`` only
    fences the gap between this re-read and the write. With ``jobs``, the setup-job
    row must still be this running rebuild (``_require_own_job``).
    """
    if jobs is not None:
        await _require_own_job(jobs, user_id=user_id, job_id=job_id)
    row = await registry.get(user_id)
    if not _same_agent(row, expected) or not await asyncio.to_thread(
        _hand_to_adoption, registry._db(), dict(row or {})
    ):
        raise _refuse(
            "CLOUD_NOT_RECORDED",
            "Your agent was rebuilt in your subscription, but your Hussh record changed "
            "while it was being built. Nothing in Azure was removed.",
        )


#: Hussh's observer grant on the new agent takes minutes to apply.
_ADOPT_DELAYS: tuple[float, ...] = (10.0, 20.0, 30.0, 60.0)


async def adopt_rebuilt_agent(
    user_id: str,
    *,
    adopt: Callable[..., Any],
    sleep: Callable[[float], Any] = asyncio.sleep,
) -> bool:
    """Attach the rebuilt agent through ``adopt_orphan``. Never raises.

    Adoption re-checks the identity and approved digest, then pulls the agent's key
    from its new address. While the new observer grant settles the read is refused
    (``AzureAgentUnreadable``) and is retried. If it never settles, the row stays
    ``needs_reinit`` and the hosting card's existing "Link existing pod" finishes it.
    """
    for delay in (0.0, *_ADOPT_DELAYS):
        if delay:
            await sleep(delay)
        try:
            result = await adopt(user_id=user_id)
        except AzureAgentUnreadable:
            continue
        except Exception as exc:  # noqa: BLE001 - the rebuild itself is recorded
            logger.warning("azure_rebuild.adopt_failed err=%s", type(exc).__name__)
            return False
        adopted = bool((result or {}).get("adopted"))
        logger.info("azure_rebuild.adopted ok=%s", adopted)
        return adopted
    logger.warning("azure_rebuild.adopt_unreadable_after_retries")
    return False


__all__ = [
    "HOSTING_AGENT_REMOVED",
    "HOSTING_AGENT_UNREADABLE",
    "HOSTING_PRESENT",
    "HOSTING_RECLAIMED",
    "HOSTING_UNCONFIRMED",
    "HOSTING_UNKNOWN",
    "REBUILDABLE",
    "REBUILD_CODE_PREFIX",
    "REBUILD_STAGE",
    "CustodySurvey",
    "adopt_rebuilt_agent",
    "hosting_state",
    "is_rebuild_job",
    "record_rebuilt_agent",
    "survey_custody",
]
