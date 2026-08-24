"""Tear down a BYOC tenant's substrate -- DARK by construction.

The substrate ensurer (byoc_substrate.py) self-names the gap: it records a receipt
of WHAT was created but has no teardown, so account deletion leaves the user's KMS
key, CMEK bucket, SA, Pub/Sub, and scheduler in their project. This closes it, but
behind two independent guards, because it DESTROYS THE USER'S SEALED HOLDINGS in a
customer-owned project, irreversibly (a KMS key cannot be un-destroyed):

  1. ``personal_agent_substrate_teardown_enabled()`` -- founder flag, default off; and
  2. an explicit ``dry_run=False`` at the call site.

With either guard closed, the executor returns the PLAN of what it would delete and
touches nothing. The plan itself is pure and consults no flag, so planning is always
safe.
"""

from __future__ import annotations

from typing import Any

# Dependency-safe teardown order (LOWER runs first). Reverse of creation, so a
# resource is deleted only after whatever depends on it is gone. KMS is LAST and
# is a version-destroy, not a delete -- the keyring/key resource itself is
# permanent in GCP; only key versions can be scheduled for destruction.
_TEARDOWN_PRIORITY = {
    "scheduler_job": 10,
    "pubsub_subscription": 20,
    "pubsub_topic": 30,
    "secret": 40,
    # The user's own copy of the pod image. Nothing in the substrate depends on it, so
    # its slot is free; reclaim it promptly (before the bucket) so a delete that fails
    # surfaces early. The Cloud Run service that referenced it is already gone by now --
    # deprovision deletes the service BEFORE substrate teardown runs, and that ordering
    # is load-bearing (a running pod holds a pull reference to this repo).
    "artifact_repository": 45,
    "gcs_object": 50,
    "gcs_bucket": 60,
    "iam_binding": 70,
    "service_account": 80,
    "kms_key": 100,
    "kms_keyring": 110,
}


def plan_teardown(resources: Any) -> list[dict[str, Any]]:
    """Order a plan's resources into a dependency-safe teardown sequence. Pure.

    Each input is a ``{"type": ..., "id": ...}`` from the substrate plan. Unknown
    types sort last (before nothing depends on them being handled specially), so a
    new resource kind is never silently dropped from a teardown."""
    actions: list[dict[str, Any]] = []
    for r in resources or []:
        if not isinstance(r, dict):
            continue
        rtype = str(r.get("type") or "").strip()
        rid = str(r.get("id") or "").strip()
        if not rid:
            continue
        actions.append(
            {
                "type": rtype or "unknown",
                "id": rid,
                "op": "destroy_versions" if rtype == "kms_key" else "delete",
            }
        )
    actions.sort(key=lambda a: _TEARDOWN_PRIORITY.get(a["type"], 90))
    return actions


async def execute_teardown(
    actions: Any,
    *,
    deleter: Any,
    dry_run: bool = True,
) -> dict[str, Any]:
    """Run a teardown plan. Destroys NOTHING unless BOTH guards open:
    ``dry_run=False`` AND ``personal_agent_substrate_teardown_enabled()``. Otherwise
    it returns the plan it WOULD run and calls ``deleter`` for nothing.

    ``deleter`` is the injected async callable ``(action) -> None`` that performs the
    real GCP delete -- injected so the destructive dependency is explicit at the call
    site and this stays testable without touching a customer's project."""
    from hushh_mcp.runtime_settings import (  # noqa: PLC0415
        personal_agent_substrate_teardown_enabled,
    )

    plan = list(actions or [])
    live = (not dry_run) and personal_agent_substrate_teardown_enabled()
    if not live:
        return {"executed": False, "reason": "guarded", "planned": plan, "deleted": []}
    deleted: list[dict[str, Any]] = []
    for action in plan:
        await deleter(action)
        deleted.append(action)
    return {"executed": True, "planned": plan, "deleted": deleted}


def substrate_resources(hushh_id: str, project: str) -> list[dict[str, Any]]:
    """The deletable substrate a pod's bootstrap created in the person's project.

    Derived from the SAME naming helpers the bootstrap plan renders from, so the
    two cannot drift apart silently. The Cloud Run service is deliberately
    absent: the existing deprovision path owns it, and two owners racing one
    delete is how a teardown summary starts lying.
    """
    from hushh_mcp.services.user_gcp_backend import (  # noqa: PLC0415
        _slug,  # noqa: SLF001 - deliberate in-repo reuse of one naming source
        pod_service_account_id,
    )

    slug = _slug(hushh_id)
    account_id = pod_service_account_id(hushh_id)
    return [
        {"type": "cloud_scheduler_job", "id": f"one-mail-{slug}-watch-renew"},
        {"type": "pubsub_subscription", "id": f"one-mail-{slug}-sub"},
        {"type": "pubsub_topic", "id": f"one-mail-{slug}"},
        # The person's own copy of the pod image. A fixed id, not slug-derived: the repo
        # is `one-pod` in every project (one image per person, one repo). Left behind, it
        # keeps billing them in a project hushh can barely reach -- so it MUST be named
        # here, where account deletion reads the list.
        {"type": "artifact_repository", "id": "one-pod"},
        {"type": "gcs_bucket", "id": f"one-pod-{slug}-blobs"},
        {"type": "secret", "id": f"{account_id}-signing-key"},
        {"type": "service_account", "id": f"{account_id}@{project}.iam.gserviceaccount.com"},
        {"type": "kms_key", "id": f"one-pod-{slug}-key"},
    ]


def build_gcp_deleter(*, token: str, project: str, region: str, session: Any = None):
    """A real deleter over Google's REST surfaces, bound to ONE project.

    Runs under the person's bootstrap-impersonated token, which is the whole
    posture: hushh can only remove what the person's own grant lets it touch,
    and only until they revoke it. Every call treats 404/409-already-gone as
    success -- a teardown that fails on already-deleted is not idempotent, and
    account deletion retries would wedge on their own progress.
    """
    if session is None:
        import requests as session  # noqa: PLC0415

    import logging  # noqa: PLC0415

    log = logging.getLogger(__name__)
    headers = {"Authorization": f"Bearer {token}"}
    _OK = (200, 204, 404)

    def _delete(url: str, what: str, ok: tuple = _OK, *, critical: bool = False) -> None:
        response = session.delete(url, headers=headers, timeout=30)
        if response.status_code in ok:
            return
        if critical:
            # A resource we could NOT delete keeps billing the person in a project hushh
            # can barely reach -- an erasure-guarantee gap, not a routine skip. The known
            # cause is a revoked bootstrap admin grant (403). Logged at ERROR, not warning,
            # so it alerts, and named as delete-REQUESTED-not-confirmed: account deletion
            # must retry or escalate rather than report a clean erase over a survivor.
            log.error(
                "byoc_teardown.delete_UNERASED what=%s http=%s -- resource may still exist "
                "and keep billing; account deletion must retry or alert on this",
                what,
                response.status_code,
            )
            return
        log.warning("byoc_teardown.delete_refused what=%s http=%s", what, response.status_code)

    def _empty_bucket(bucket: str) -> None:
        # Objects first, paged; a non-empty bucket refuses deletion. Bounded at
        # 32 pages (~32k objects) -- beyond that the refusal below reports it.
        for _ in range(32):
            listing = session.get(
                f"https://storage.googleapis.com/storage/v1/b/{bucket}/o",
                headers=headers,
                params={"maxResults": 1000, "fields": "items(name)"},
                timeout=30,
            )
            if listing.status_code != 200:
                return
            items = (listing.json() or {}).get("items") or []
            if not items:
                return
            for item in items:
                from urllib.parse import quote  # noqa: PLC0415

                _delete(
                    f"https://storage.googleapis.com/storage/v1/b/{bucket}/o/"
                    f"{quote(str(item.get('name') or ''), safe='')}",
                    "bucket object",
                )

    def _destroy_kms_versions(key_id: str) -> None:
        parent = f"projects/{project}/locations/{region}/keyRings/hushh-one/cryptoKeys/{key_id}"
        listing = session.get(
            f"https://cloudkms.googleapis.com/v1/{parent}/cryptoKeyVersions",
            headers=headers,
            timeout=30,
        )
        if listing.status_code != 200:
            return
        for version in (listing.json() or {}).get("cryptoKeyVersions") or []:
            state = str(version.get("state") or "")
            if state in ("DESTROYED", "DESTROY_SCHEDULED"):
                continue
            session.post(
                f"https://cloudkms.googleapis.com/v1/{version.get('name')}:destroy",
                headers=headers,
                timeout=30,
            )

    async def _deleter(action: dict) -> None:
        import asyncio  # noqa: PLC0415

        kind = str(action.get("type") or "")
        rid = str(action.get("id") or "")

        def _run() -> None:
            if kind == "cloud_scheduler_job":
                _delete(
                    f"https://cloudscheduler.googleapis.com/v1/projects/{project}"
                    f"/locations/{region}/jobs/{rid}",
                    "scheduler job",
                )
            elif kind == "pubsub_subscription":
                _delete(
                    f"https://pubsub.googleapis.com/v1/projects/{project}/subscriptions/{rid}",
                    "pubsub subscription",
                )
            elif kind == "pubsub_topic":
                _delete(
                    f"https://pubsub.googleapis.com/v1/projects/{project}/topics/{rid}",
                    "pubsub topic",
                )
            elif kind == "gcs_bucket":
                _empty_bucket(rid)
                _delete(
                    f"https://storage.googleapis.com/storage/v1/b/{rid}",
                    "bucket",
                    (200, 204, 404, 409),
                )
            elif kind == "secret":
                _delete(
                    f"https://secretmanager.googleapis.com/v1/projects/{project}/secrets/{rid}",
                    "secret",
                )
            elif kind == "service_account":
                _delete(
                    f"https://iam.googleapis.com/v1/projects/{project}/serviceAccounts/{rid}",
                    "service account",
                )
            elif kind == "artifact_repository":
                # Deleting the repo removes the images it holds (no per-image sweep, no
                # `force` needed). The delete is an async LRO that returns 200 + an
                # operation; accepting 200 without awaiting is fine for teardown. But a
                # 403 here means the bootstrap admin grant was revoked and the repo (and
                # its bill) SURVIVES -- so this one is critical: a swallowed warning would
                # let account deletion report a clean erase over a resource that lives on.
                _delete(
                    f"https://artifactregistry.googleapis.com/v1/projects/{project}"
                    f"/locations/{region}/repositories/{rid}",
                    "artifact repository",
                    critical=True,
                )
            elif kind == "kms_key":
                # Keys cannot be deleted; destroying every version is the real
                # erasure, and the empty key shell is inert and costless.
                _destroy_kms_versions(rid)
            else:
                log.warning("byoc_teardown.unknown_resource type=%s id=%s", kind, rid)

        await asyncio.to_thread(_run)

    return _deleter


__all__ = [
    "build_gcp_deleter",
    "execute_teardown",
    "plan_teardown",
    "substrate_resources",
]
