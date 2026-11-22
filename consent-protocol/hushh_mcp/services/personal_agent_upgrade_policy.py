"""Pure personal-agent upgrade identity, approval, and retry policy."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from hushh_mcp.services.pod_release import (
    image_digest,
    is_immutable_image_reference,
)
from hushh_mcp.services.pod_update_identity import approved_browser_plan

UPGRADE_APPROVAL_VERSION = 1
_UPGRADE_APPROVAL_ACTIVE_STATUSES = frozenset({"approved", "scheduled", "updating"})
_UPGRADE_APPROVAL_UNRESOLVED_STATUSES = frozenset({"blocked"})


def pod_incarnation(row: Optional[dict]) -> Optional[str]:
    """Return the recorded provider incarnation, or ``None`` when it is unknown.

    A service name is a stable address, not an incarnation. The registry records
    ``serviceUid`` when the provider gives us one and keeps the older
    ``external_agent_id``/``service`` values only as compatibility fallbacks.
    ``unknown`` is intentionally not an identity: allowing it to participate in an
    approval would let a later host inherit authority from a row that never proved
    which host it owns.
    """
    metadata = (row or {}).get("backend_metadata") or {}
    if not isinstance(metadata, dict):
        metadata = {}
    value = (
        metadata.get("serviceUid")
        or (row or {}).get("external_agent_id")
        or metadata.get("service")
    )
    normalized = str(value or "").strip()
    return normalized if normalized and normalized.lower() != "unknown" else None


def _approval_operation_id(approval: object) -> Optional[str]:
    if not isinstance(approval, dict):
        return None
    value = str(approval.get("operationId") or "").strip()
    return value or None


def _approval_is_well_formed(
    row: Optional[dict],
    approval: object,
    *,
    allow_unresolved: bool = False,
    allow_terminal_failure: bool = False,
) -> bool:
    """Validate the durable approval envelope without making a provider call."""
    if not isinstance(approval, dict) or (row or {}).get("user_id") is None:
        return False
    if type(approval.get("version")) is not int or approval["version"] not in {
        UPGRADE_APPROVAL_VERSION,
        2,
    }:
        return False
    target = str(approval.get("targetImage") or "").strip()
    incarnation = pod_incarnation(row)
    owner_id = str((row or {}).get("user_id") or "").strip()
    hushh_id = str((row or {}).get("hushh_id") or "").strip()
    required_strings = ("releaseId", "operationId", "idempotencyKey", "targetImage")
    if (
        not owner_id
        or not hushh_id
        or not incarnation
        or not is_immutable_image_reference(target)
        or any(
            not isinstance(approval.get(key), str) or not approval[key].strip()
            for key in required_strings
        )
        or approval.get("ownerId") != owner_id
        or approval.get("hushhId") != hushh_id
        or approval.get("podIncarnation") != incarnation
    ):
        return False
    from hushh_mcp.services.pod_update_identity import approved_files_plan

    try:
        capability = approved_files_plan(approval)
        browser = approved_browser_plan(approval)
        if browser is not None:
            browser.require_owner(row, target)
        if capability is not None:
            capability.require_owner(row, target)
    except (ValueError, TypeError):
        return False
    statuses = set(_UPGRADE_APPROVAL_ACTIVE_STATUSES)
    if allow_unresolved:
        statuses.update(_UPGRADE_APPROVAL_UNRESOLVED_STATUSES)
    if allow_terminal_failure:
        statuses.add("failed")
    return approval.get("status") in statuses


def upgrade_operation_is_recoverable(row: Optional[dict]) -> bool:
    """Whether the row retains enough owner authority to observe an old upgrade.

    This deliberately does not compare against the hub's *current* target image:
    a newer release may be offered while an older provider operation is unresolved.
    The operation must be reconciled against the target and incarnation saved in its
    own receipt before a new release can be considered.
    """
    metadata = (row or {}).get("backend_metadata") or {}
    if not isinstance(metadata, dict):
        return False
    return bool(
        isinstance(metadata, dict)
        and isinstance(metadata.get("upgradeLease"), str)
        and metadata.get("upgradeLease")
        and _approval_is_well_formed(row, metadata.get("upgradeApproval"), allow_unresolved=True)
    )


def upgrade_release_id(
    row: Optional[dict],
    target_image: str,
    *,
    capability_digest: str | None = None,
    browser_digest: str | None = None,
) -> str:
    """Return an opaque release identifier bound to image and pod incarnation."""
    incarnation = pod_incarnation(row) or "unknown"
    hushh_id = str((row or {}).get("hushh_id") or "").strip()
    from hushh_mcp.services.pod_update_identity import release_identity

    return release_identity(
        hushh_id,
        incarnation,
        str(target_image or "").strip(),
        capability_digest=capability_digest,
        browser_digest=browser_digest,
    )


def upgrade_approval_matches(
    row: Optional[dict],
    target_image: str,
    *,
    allow_unresolved: bool = False,
    allow_terminal_failure: bool = False,
) -> bool:
    """Whether durable approval covers this exact image and pod incarnation."""
    metadata = (row or {}).get("backend_metadata") or {}
    if not isinstance(metadata, dict):
        return False
    approval = metadata.get("upgradeApproval")
    target = str(target_image or "").strip()
    if not _approval_is_well_formed(
        row,
        approval,
        allow_unresolved=allow_unresolved,
        allow_terminal_failure=allow_terminal_failure,
    ):
        return False
    from hushh_mcp.services.pod_update_identity import approved_files_plan

    try:
        capability = approved_files_plan(approval)
        browser = approved_browser_plan(approval)
        if browser is not None:
            browser.require_owner(row, target)
        if capability is not None:
            capability.require_owner(row, target)
    except (ValueError, TypeError):
        return False
    return (
        is_immutable_image_reference(target)
        and image_digest(approval.get("targetImage")) == image_digest(target)
        and approval.get("targetImage") == target
        and approval.get("releaseId")
        == upgrade_release_id(
            row,
            target,
            capability_digest=capability.digest if capability else None,
            browser_digest=browser.digest if browser else None,
        )
    )


def running_image(row: Optional[dict[str, Any]]) -> Optional[str]:
    """The hub-side image a pod was built from, as its registry row records it.

    ``source_image`` on a user-owned pod (its own registry holds a digest-pinned
    COPY, so the recorded ``image`` is the copy, not what the hub ships) and
    ``image`` on a hussh-hosted one. Neither means the row has no host, which is
    "nothing to upgrade" rather than "stale".
    """
    meta = (row or {}).get("backend_metadata") or {}
    value = meta.get("source_image") or meta.get("image")
    return str(value).strip() or None if value else None


#: A lease younger than this is another worker mid-upgrade; older, it was left by
#: a worker that died and the row is a candidate again. Mirrors the repo's TTL.
UPGRADE_LEASE_FRESH_FOR_SECONDS = 600


#: After a failed attempt, leave the pod alone this long before trying again. The
#: lease is released the moment a failure is recorded, so without this the OTHER
#: gunicorn worker (which listed the same candidates) retried the same pod fifteen
#: seconds later and the three-attempt cap burned in two passes (seen live 2026-09-03).
UPGRADE_RETRY_COOLDOWN_SECONDS = 600


def _attempted_recently(marker: Any, *, now: Optional[datetime] = None) -> bool:
    raw = str((marker or {}).get("lastAttemptAt") or "").strip() if isinstance(marker, dict) else ""
    if not raw:
        return False
    try:
        at = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return False
    if at.tzinfo is None:
        at = at.replace(tzinfo=timezone.utc)
    return (
        (now or datetime.now(timezone.utc)) - at
    ).total_seconds() < UPGRADE_RETRY_COOLDOWN_SECONDS


def hub_revision() -> str:
    """This process's Cloud Run revision name (``consent-protocol-00061-9p2``), or ''."""
    import os  # noqa: PLC0415

    return (os.getenv("K_REVISION") or "").strip()


def set_by_newer_hub(row: Optional[dict], *, own_revision: Optional[str] = None) -> bool:
    """Did a NEWER hub revision than this one last set the pod's image?

    During a rollout Cloud Run keeps the previous hub revision's instances alive for
    a while, and every instance runs the reconcile sweep against ITS OWN
    ``HUSSH_ONE_POD_IMAGE``. Seen live 2026-09-03: revision 00060 (target
    ``dev-e53e0c6a0``) and 00061 (target ``dev-ec552dd3c``) alternately moved the
    founder's pod forward and back, a ~90s PUT and a restart each time, until the
    old instances drained. The image a pod runs must only ever move forward, so
    the upgrade records which hub revision set it and an older revision refuses to
    touch a row a newer one already wrote. Revision names are zero-padded and
    monotonic within a service, so string order is deploy order.
    """
    own = (own_revision if own_revision is not None else hub_revision()).strip()
    metadata = (row or {}).get("backend_metadata")
    theirs = str((metadata or {}).get("imageSetByRevision") or "").strip()
    if not own or not theirs:
        return False
    if own.rsplit("-", 2)[0] != theirs.rsplit("-", 2)[0]:
        return False  # a different service; no ordering to speak of
    return theirs > own


def _lease_is_fresh(value: Any) -> bool:
    """``upgradeLease`` starts with ``<iso timestamp>|``; only the timestamp
    decides freshness. Anything unparseable is treated as absent, never as a lock."""
    text = str(value or "")
    if not text:
        return False
    from datetime import datetime, timezone  # noqa: PLC0415

    try:
        taken = datetime.fromisoformat(text.split("|", 1)[0])
    except ValueError:
        return False
    if taken.tzinfo is None:
        taken = taken.replace(tzinfo=timezone.utc)
    age = (datetime.now(timezone.utc) - taken).total_seconds()
    return 0 <= age < UPGRADE_LEASE_FRESH_FOR_SECONDS


#: A pod that failed to come up on one target image is retried this many times for
#: THAT image, then left alone until the image moves again. Without the cap a pod
#: whose new revision cannot boot would be replaced every pass forever.
UPGRADE_ATTEMPTS_PER_IMAGE = 3
