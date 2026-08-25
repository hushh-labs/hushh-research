"""Export and import: the two steps of a pod migration that only a pod can do.

WHY THESE ROUTES ARE HERE AND NOT ON THE HUB
--------------------------------------------
A person moving their agent from the hosted tier into their own project is moving
a sealed, hash-chained commit log. Reading it requires the source pod's key;
writing it requires the destination pod's. hushh holds neither -- the hub carries
``cloudkms.admin`` on the hosting keyring and provably not encrypt or decrypt, and
on BYOC it has no path to the person's KMS at all. So there is no hub-side
implementation of this to write. The work runs at the two ends, and the hub
ferries an envelope it cannot open.

That is the migration keeping the promise rather than suspending it for a minute.

AUTH: TWO LOCKS, TWO AUDIENCES, ONE REQUEST
-------------------------------------------
Cloud Run's IAM invoker binding is the first lock and the one that already
exists: a pod is created with a single ``run.invoker`` member and no ``allUsers``
binding, so an anonymous request never reaches this process. The platform
validates that token's audience against the service URL.

The second lock lives here, in its own ``X-Hussh-Hub-Proof`` header, because the
``Authorization`` slot is already spoken for. It is the same Google-signed OIDC
shape ``/pod/tick`` uses (``verify_scheduler_request``: fail-closed on an empty
allowlist, no third credential shape invented), but bound to an audience derived
from **this pod's own HusshID** rather than its URL -- see ``hub_proof_audience``
for why that is both necessary and stronger.

SHIPS DARK. ``HUSSH_POD_MIGRATION_ENABLED`` is off by default, so these routes
404 on every pod until a lane deliberately turns them on.

WHAT EACH SIDE REFUSES
----------------------
Export refuses to seal to its OWN key (that is a loop, not a migration) and
refuses an empty log (which is a misconfiguration wearing the costume of a
successful no-op). Import refuses a bundle addressed to another pod, a bundle
that fails authenticated decryption, and -- most importantly -- refuses to write
into a log that already has records. A destination with history is a different
and far more dangerous situation than an empty one, and merging two agents'
memories is not a thing this code is allowed to attempt.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Optional

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/pod/migration", tags=["pod-migration"])


def _enabled() -> bool:
    return str(os.getenv("HUSSH_POD_MIGRATION_ENABLED") or "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def _require_enabled() -> None:
    if not _enabled():
        # 404 rather than 403: a surface that is off should be indistinguishable
        # from a surface that does not exist, so probing tells an attacker
        # nothing about which pods are migration-capable.
        raise HTTPException(status_code=404, detail="not found")


def hub_proof_audience(hushh_id: str) -> str:
    """The audience a hub proof for THIS pod must carry.

    Deliberately derived from the pod's own HusshID rather than from its URL.
    Two reasons, and the second is the interesting one:

    1. **A Cloud Run service is not told its own URL.** There is no env var and
       no reliable way to derive it (the project hash in the hostname is not
       predictable), so a URL-audience check inside the pod would need a second
       deploy per pod purely to tell it where it lives.
    2. **A HusshID audience is STRONGER than a URL audience.** It binds the
       proof to this person's agent, so a proof minted for one pod cannot be
       replayed at another even by a caller who legitimately holds one. The URL
       audience is still checked -- by Cloud Run, on the `Authorization` token,
       before the request reaches this process -- so the two together bind both
       *which service* and *which agent*.
    """
    return f"hussh-pod-migration:{str(hushh_id or '').strip()}"


def _require_hub_caller(proof: Optional[str]) -> None:
    """Fail-closed hub-caller check, on top of Cloud Run's IAM invoker binding.

    Defence in depth, not the only defence: a pod is created with a single
    `run.invoker` member and no `allUsers` binding, so an anonymous request never
    arrives here at all. This is the second lock, and it is the one that survives
    an ingress or IAM misconfiguration.

    Carried in its own header rather than `Authorization`, because that slot
    already holds the token Cloud Run itself validates against the service URL.
    One request, two audiences, two different checkers.
    """
    from hushh_mcp.services.scheduler_identity import (  # noqa: PLC0415
        SchedulerIdentityError,
        verify_scheduler_request,
    )

    hushh_id = str(os.getenv("HUSHH_ID") or "").strip()
    allowed = tuple(
        email.strip()
        for email in str(os.getenv("HUSSH_POD_HUB_CALLER_EMAILS") or "").split(",")
        if email.strip()
    )
    if not hushh_id:
        # A pod that does not know which agent it is cannot bind a proof to
        # itself, and accepting an unbound proof would make every pod
        # interchangeable to a caller holding any one of them.
        raise HTTPException(status_code=403, detail="migration refused")
    try:
        verify_scheduler_request(
            authorization_header=proof,
            audience=hub_proof_audience(hushh_id),
            allowed_emails=allowed,
        )
    except SchedulerIdentityError as exc:
        raise HTTPException(status_code=403, detail="migration refused") from exc


def _commit_log() -> Any:
    """This pod's own commit log, or a loud refusal.

    Resolved through `resolve_pod_storage`, which is the one place that knows how
    both custody models produce a key. Reaching for `log_key_from_env` here
    instead is the exact defect that made every BYOC pod forget: env-only reads
    raise on a pod whose key is wrapped in the person's KMS.
    """
    from hushh_mcp.services.pod_storage import BACKEND_COMMIT_LOG, resolve_pod_storage

    storage = resolve_pod_storage()
    if getattr(storage, "backend_id", "") != BACKEND_COMMIT_LOG:
        raise HTTPException(
            status_code=503,
            detail="this pod has no durable log to migrate (storage backend is not commit_log)",
        )
    log = getattr(storage, "_log", None)
    if log is None:  # pragma: no cover - structurally impossible for this backend
        raise HTTPException(status_code=503, detail="the commit log is unavailable")
    return log


class ExportRequest(BaseModel):
    """Where this log is going, in the destination pod's own published terms."""

    recipientPublicKey: str = Field(min_length=32, max_length=128)
    recipientKeyId: str = Field(min_length=4, max_length=128)
    recipientWrappingAlg: str = Field(default="X25519-AES256-GCM", max_length=64)


@router.post("/export")
async def export_log(
    request: Request,
    body: ExportRequest,
    x_hussh_hub_proof: str | None = Header(default=None, alias="X-Hussh-Hub-Proof"),
) -> dict:
    """Replay this pod's log and seal it for exactly one destination pod.

    The response carries ciphertext plus coordinates. The hub records the head
    sha and the count -- which are a proof obligation, not content -- and ferries
    the envelope without any means of opening it.
    """
    _require_enabled()
    _require_hub_caller(x_hussh_hub_proof)

    from hushh_mcp.services.pod_migration_bundle import (  # noqa: PLC0415
        PodMigrationBundleError,
        head_sha_of,
        seal_bundle,
    )
    from hushh_mcp.services.pod_self_registration import pod_keypair  # noqa: PLC0415

    own = pod_keypair()
    if body.recipientKeyId == own.key_id or body.recipientPublicKey == own.public_key_b64:
        # Sealing to ourselves is a loop dressed as a migration, and it would
        # report success while moving nothing.
        raise HTTPException(
            status_code=400,
            detail="the destination is this pod -- there is nothing to migrate",
        )

    log = _commit_log()
    try:
        # `replay` verifies the whole chain and raises on any defect, so a
        # tampered or broken log is refused BEFORE anything is sealed. Exporting
        # first and verifying later would be the wrong order: a bundle built
        # from a broken chain is a broken chain someone now trusts.
        records = await log.replay()
    except Exception as exc:
        logger.warning("pod_migration.replay_failed", exc_info=True)
        raise HTTPException(
            status_code=409, detail=f"this pod's log did not verify: {exc}"
        ) from exc

    head_sha = head_sha_of(records) or ""
    try:
        envelope, receipt = seal_bundle(
            records=records,
            head_sha=head_sha,
            recipient_public_key_b64=body.recipientPublicKey,
            recipient_key_id=body.recipientKeyId,
            wrapping_alg=body.recipientWrappingAlg,
        )
    except PodMigrationBundleError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    logger.info(
        "pod_migration.exported records=%d head=%s recipient=%s",
        receipt.record_count,
        head_sha[:12],
        receipt.recipient_key_id,
    )
    return {
        "bundle": envelope,
        "headSha": receipt.head_sha,
        "recordCount": receipt.record_count,
        "recipientKeyId": receipt.recipient_key_id,
    }


class ImportRequest(BaseModel):
    bundle: dict


@router.post("/import")
async def import_log(
    request: Request,
    body: ImportRequest,
    x_hussh_hub_proof: str | None = Header(default=None, alias="X-Hussh-Hub-Proof"),
) -> dict:
    """Open a bundle sealed to this pod and rebuild the chain under OUR key.

    Returns this pod's own head sha and count. The hub compares them against the
    source's receipt; byte-equal heads is the zero-loss proof, and the row is
    switched over only when they match.

    The rebuild goes through the ordinary ``append`` path on purpose. There is
    deliberately no way to write a chosen sha: the hashes come out equal because
    the inputs were equal, and an import that could stamp a handed-in sha would
    be able to make a broken chain look whole.
    """
    _require_enabled()
    _require_hub_caller(x_hussh_hub_proof)

    from hushh_mcp.services.pod_migration_bundle import (  # noqa: PLC0415
        PodMigrationBundleError,
        open_bundle,
    )
    from hushh_mcp.services.pod_self_registration import pod_keypair  # noqa: PLC0415

    own = pod_keypair()
    log = _commit_log()

    existing = await log.replay()
    if existing:
        # A destination that already has history is a different and much more
        # dangerous situation than an empty one. Appending would interleave two
        # agents' memories into one chain that verifies perfectly and is wrong.
        raise HTTPException(
            status_code=409,
            detail=(
                f"this pod already has {len(existing)} record(s); refusing to import "
                "over an existing history"
            ),
        )

    try:
        records, source_head_sha, count = open_bundle(
            body.bundle, private_key=own.private_key, expected_key_id=own.key_id
        )
    except PodMigrationBundleError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    written: Optional[dict[str, Any]] = None
    for record in records:
        written = await log.append(str(record["kind"]), record.get("payload"))

    rebuilt_head = str((written or {}).get("sha") or "")
    logger.info(
        "pod_migration.imported records=%d head=%s matches_source=%s",
        count,
        rebuilt_head[:12],
        rebuilt_head == source_head_sha,
    )
    return {
        "headSha": rebuilt_head,
        "recordCount": count,
        "sourceHeadSha": source_head_sha,
        # Computed here as a convenience for the log line and the operator, but
        # the hub re-checks it against ITS recorded receipt rather than trusting
        # this field -- the destination asserting its own success is exactly the
        # claim an independent check exists to test.
        "matchesSource": bool(rebuilt_head and rebuilt_head == source_head_sha),
    }
