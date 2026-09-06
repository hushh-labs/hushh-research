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

import os
from typing import Any


class SubstrateDeleteError(RuntimeError):
    """One planned resource could not be confirmed gone; the message names what and why."""


# Dependency-safe teardown order (LOWER runs first). Reverse of creation, so a
# resource is deleted only after whatever depends on it is gone. KMS is LAST and
# is a version-destroy, not a delete -- the keyring/key resource itself is
# permanent in GCP; only key versions can be scheduled for destruction.
_TEARDOWN_PRIORITY = {
    "cloud_scheduler_job": 10,
    "pubsub_subscription": 20,
    "pubsub_topic": 30,
    # Preserve recovery material until storage/image removal has succeeded.
    "secret": 65,
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
    # LAST, and the ordering is the whole design. This is hushh's permission to
    # impersonate the bootstrap account -- the identity every delete above runs as.
    # Give it up before the rest is gone and teardown cannot finish, in a project
    # hushh has just lost the only way back into.
    "service_account_iam_binding": 120,
}

_RECOVERY_AUTHORITY_TYPES = frozenset(
    {
        "secret",
        "iam_binding",
        "service_account",
        "kms_key",
        "kms_keyring",
        "service_account_iam_binding",
    }
)


def plan_teardown(resources: Any) -> list[dict[str, Any]]:
    """Order a plan's resources into a dependency-safe teardown sequence. Pure.

    Each input is a ``{"type": ..., "id": ...}`` from the substrate plan. Unknown
    types run before recovery authority is removed, so an unsupported resource
    fails completeness while preserving access needed to finish its teardown."""
    actions: list[dict[str, Any]] = []
    for r in resources or []:
        if not isinstance(r, dict):
            continue
        rtype = str(r.get("type") or "").strip()
        rid = str(r.get("id") or "").strip()
        if not rid:
            continue
        action = {
            "type": rtype or "unknown",
            "id": rid,
            "op": "destroy_versions" if rtype == "kms_key" else "delete",
        }
        # `resource` joined these because a binding on a SERVICE ACCOUNT needs to name
        # which account; dropping it silently built a malformed URL and the revoke
        # could not have worked. A key this loop does not know about is discarded
        # without a word, so anything a deleter reads must be listed here.
        for key in ("role", "member", "resource"):
            if r.get(key):
                action[key] = str(r[key])
        actions.append(action)
    actions.sort(key=lambda a: _TEARDOWN_PRIORITY.get(a["type"], 49))
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
    real GCP delete, RAISING (``SubstrateDeleteError`` or anything) when a resource
    cannot be confirmed gone -- injected so the destructive dependency is explicit at
    the call site and this stays testable without touching a customer's project.
    ``deleted`` holds only confirmed removals; a raise lands the action in ``failed``
    with its reason. Independent cleanup continues after a failure, but credentials,
    permissions and keys needed to recover are deferred and recorded as incomplete."""
    from hushh_mcp.runtime_settings import (  # noqa: PLC0415
        personal_agent_substrate_teardown_enabled,
    )

    plan = sorted(
        list(actions or []), key=lambda action: _TEARDOWN_PRIORITY.get(action["type"], 49)
    )
    live = (not dry_run) and personal_agent_substrate_teardown_enabled()
    if not live:
        return {
            "executed": False,
            "reason": "guarded",
            "planned": plan,
            "deleted": [],
            "failed": [],
        }
    deleted: list[dict[str, Any]] = []
    failed: list[dict[str, Any]] = []
    for action in plan:
        if failed and action.get("type") in _RECOVERY_AUTHORITY_TYPES:
            failed.append({**action, "reason": "deferred_until_dependencies_erased"})
            continue
        try:
            await deleter(action)
        except Exception as exc:  # noqa: BLE001 - record and continue; the rest may still delete
            failed.append({**action, "reason": (str(exc) or type(exc).__name__)[:300]})
            continue
        deleted.append(action)
    return {
        "executed": True,
        "planned": plan,
        "deleted": deleted,
        "failed": failed,
        "complete": not failed,
    }


def substrate_resources(
    hushh_id: str,
    project: str,
    *,
    bootstrap_sa: str = "",
    hushh_caller: str = "",
) -> list[dict[str, Any]]:
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
    sa_email = f"{account_id}@{project}.iam.gserviceaccount.com"
    resources: list[dict[str, Any]] = [
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
        {"type": "service_account", "id": sa_email},
        {
            # The ONLY project-level grant bootstrap makes (user_gcp_bootstrap.plan_calls,
            # step iam_pod_sa_vertex). Every other binding dies with its resource; this one
            # outlives the SA delete as an inert deleted: member unless removed here.
            "type": "iam_binding",
            "id": f"roles/aiplatform.user:{sa_email}",
            "role": "roles/aiplatform.user",
            "member": f"serviceAccount:{sa_email}",
        },
        {"type": "kms_key", "id": f"one-pod-{slug}-key"},
    ]
    resources.extend(_hushh_access_revocation(project, bootstrap_sa, hushh_caller))
    return resources


def _hushh_access_revocation(
    project: str, bootstrap_sa: str, hushh_caller: str
) -> list[dict[str, Any]]:
    """Give back the one permission the person granted hushh. Deliberately not a delete.

    Everything above is the person's own infrastructure. This is different in kind: it
    is hushh's standing ability to impersonate `one-bootstrap@<their project>`, an
    account holding ten admin-class roles -- storage.admin, secretmanager.admin,
    cloudkms.admin, run.admin among them -- inside a project belonging to somebody who
    has just deleted their account. Teardown removed the pod's service account and
    never touched this, so hushh kept minting 900-second tokens as an admin in an
    ex-customer's cloud, indefinitely, with the product showing the account as erased.

    WHY THE GRANT AND NOT THE ACCOUNT

    Deleting `one-bootstrap@` would be a larger irreversible act in a project hushh does
    not own, and it is not what ends hushh's access -- the binding is. Removing exactly
    the binding leaves the person holding their own account, to delete or reuse as they
    choose, and leaves hushh with nothing. `authorize_byoc_project.sh` documents this
    same command as the revoke; account deletion now performs it on the person's behalf
    rather than leaving it as homework nobody knows they have.

    The honest bound, unchanged from that script: a token already minted lives out its
    remaining 900 seconds, because Google does not revoke issued access tokens. So this
    ends future authority, and at most fifteen more minutes of the old.

    Emitted only when both identities are known. A binding with an empty member would
    match nothing and mint a clean-erasure summary over an access that survived.
    """
    caller = (hushh_caller or "").strip()
    if not caller:
        from hushh_mcp.services.user_gcp_backend import (  # noqa: PLC0415
            _bare_service_account,  # noqa: SLF001 - one spelling of this principal
        )

        caller = str(_bare_service_account(os.getenv("HUSSH_CONSENT_PLANE_SA", "")))
    account = (bootstrap_sa or "").strip()
    if not account or not caller:
        return []
    return [
        {
            "type": "service_account_iam_binding",
            "id": f"roles/iam.serviceAccountTokenCreator:{caller}@{account}",
            "resource": account,
            "role": "roles/iam.serviceAccountTokenCreator",
            "member": f"serviceAccount:{caller}",
        }
    ]


def build_gcp_deleter(*, token: str, project: str, region: str, session: Any = None):
    """A real deleter over Google's REST surfaces, bound to ONE project.

    Runs under the person's bootstrap-impersonated token, which is the whole
    posture: hushh can only remove what the person's own grant lets it touch,
    and only until they revoke it. Every call treats 404-already-gone as
    success -- a teardown that fails on already-deleted is not idempotent, and
    account deletion retries would wedge on their own progress. Everything else
    RAISES ``SubstrateDeleteError``: a bucket 409-not-empty is a FAILURE, not
    success, because a refusal minted as success is how a teardown summary lies.
    """
    if session is None:
        import requests as session  # noqa: PLC0415

    import logging  # noqa: PLC0415

    log = logging.getLogger(__name__)
    headers = {"Authorization": f"Bearer {token}"}
    _OK = (200, 204, 404)

    def _delete(url: str, what: str, ok: tuple = _OK) -> None:
        response = session.delete(url, headers=headers, timeout=30)
        if response.status_code in ok:
            return
        # A resource we could NOT delete keeps billing the person in a project hushh
        # can barely reach -- an erasure-guarantee gap, not a routine skip. The known
        # cause is a revoked bootstrap admin grant (403). Logged at ERROR, not warning,
        # so it alerts, and named as delete-REQUESTED-not-confirmed; the raise makes
        # execute_teardown record a survivor instead of minting a clean erase over it.
        log.error(
            "byoc_teardown.delete_UNERASED what=%s http=%s -- resource may still exist "
            "and keep billing; account deletion must retry or alert on this",
            what,
            response.status_code,
        )
        raise SubstrateDeleteError(f"{what} http={response.status_code}")

    def _empty_bucket(bucket: str) -> None:
        # Objects first, paged; a non-empty bucket refuses deletion. Bounded at
        # 32 pages (~32k objects) -- beyond that the for/else below reports it.
        for _ in range(32):
            listing = session.get(
                f"https://storage.googleapis.com/storage/v1/b/{bucket}/o",
                headers=headers,
                params={"maxResults": 1000, "fields": "items(name)"},
                timeout=30,
            )
            if listing.status_code == 404:
                return  # bucket already gone -- the bucket _delete then sees 404-ok
            if listing.status_code != 200:
                raise SubstrateDeleteError(f"bucket object listing http={listing.status_code}")
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
        else:
            raise SubstrateDeleteError("bucket not emptied after 32 pages (~32k objects)")

    def _destroy_kms_versions(key_id: str) -> None:
        parent = f"projects/{project}/locations/{region}/keyRings/hushh-one/cryptoKeys/{key_id}"
        listing = session.get(
            f"https://cloudkms.googleapis.com/v1/{parent}/cryptoKeyVersions",
            headers=headers,
            timeout=30,
        )
        if listing.status_code == 404:
            return  # key never created -- retry-safe
        if listing.status_code != 200:
            raise SubstrateDeleteError(f"kms version listing http={listing.status_code}")
        for version in (listing.json() or {}).get("cryptoKeyVersions") or []:
            state = str(version.get("state") or "")
            if state in ("DESTROYED", "DESTROY_SCHEDULED"):
                continue
            # This POST is the real erasure of the sealed holdings; unchecked it is
            # the quietest possible failure, so its result is never ignored.
            resp = session.post(
                f"https://cloudkms.googleapis.com/v1/{version.get('name')}:destroy",
                headers=headers,
                timeout=30,
            )
            if resp.status_code not in (200, 404):
                raise SubstrateDeleteError(f"kms version destroy http={resp.status_code}")

    def _remove_project_iam_binding(role: str, member: str) -> None:
        # Read-modify-write on the project policy, mirroring bootstrap's merge_binding
        # in reverse. The fetched policy's etag rides along inside `policy`, so a
        # concurrent write 409s and surfaces as a retryable failure, never a clobber.
        base = f"https://cloudresourcemanager.googleapis.com/v1/projects/{project}"
        got = session.post(f"{base}:getIamPolicy", headers=headers, json={}, timeout=30)
        if got.status_code != 200:
            raise SubstrateDeleteError(f"project iam getIamPolicy http={got.status_code}")
        policy = got.json() or {}
        kept, changed = [], False
        for b in policy.get("bindings") or []:
            if b.get("role") == role and member in (b.get("members") or []):
                changed = True
                members = [m for m in b["members"] if m != member]
                if members:
                    kept.append({**b, "members": members})
            else:
                kept.append(b)
        if not changed:
            return  # already absent -> idempotent success (retry after SA delete lands here)
        policy["bindings"] = kept
        put = session.post(
            f"{base}:setIamPolicy", headers=headers, json={"policy": policy}, timeout=30
        )
        if put.status_code != 200:
            raise SubstrateDeleteError(f"project iam setIamPolicy http={put.status_code}")

    def _remove_service_account_iam_binding(resource: str, role: str, member: str) -> None:
        # The same read-modify-write as the project version, on the service ACCOUNT's
        # own policy. Never a whole-policy replace: the person may hold bindings here
        # that hushh knows nothing about, and dropping them while claiming to revoke
        # one grant is the failure safe-changes R3 exists for.
        base = f"https://iam.googleapis.com/v1/projects/{project}/serviceAccounts/{resource}"
        got = session.post(f"{base}:getIamPolicy", headers=headers, json={}, timeout=30)
        if got.status_code == 404:
            return  # the account is gone, so the grant on it is too -- idempotent
        if got.status_code != 200:
            raise SubstrateDeleteError(f"sa iam getIamPolicy http={got.status_code}")
        policy = got.json() or {}
        kept, changed = [], False
        for b in policy.get("bindings") or []:
            if b.get("role") == role and member in (b.get("members") or []):
                changed = True
                members = [m for m in b["members"] if m != member]
                if members:
                    kept.append({**b, "members": members})
            else:
                kept.append(b)
        if not changed:
            return  # already revoked -> idempotent success on a retried deletion
        policy["bindings"] = kept
        put = session.post(
            f"{base}:setIamPolicy", headers=headers, json={"policy": policy}, timeout=30
        )
        if put.status_code != 200:
            raise SubstrateDeleteError(f"sa iam setIamPolicy http={put.status_code}")

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
                # No 409 in the ok tuple: a not-empty refusal is a recorded failure,
                # never minted success.
                _delete(
                    f"https://storage.googleapis.com/storage/v1/b/{rid}",
                    "bucket",
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
                # its bill) SURVIVES -- every failure is loud now, so a swallowed warning
                # can no longer let deletion report a clean erase over it.
                _delete(
                    f"https://artifactregistry.googleapis.com/v1/projects/{project}"
                    f"/locations/{region}/repositories/{rid}",
                    "artifact repository",
                )
            elif kind == "iam_binding":
                _remove_project_iam_binding(
                    str(action.get("role") or ""), str(action.get("member") or "")
                )
            elif kind == "service_account_iam_binding":
                _remove_service_account_iam_binding(
                    str(action.get("resource") or ""),
                    str(action.get("role") or ""),
                    str(action.get("member") or ""),
                )
            elif kind == "kms_key":
                # Keys cannot be deleted; destroying every version is the real
                # erasure, and the empty key shell is inert and costless.
                _destroy_kms_versions(rid)
            else:
                # A plan entry nothing knows how to delete must fail the completeness
                # check, honoring plan_teardown's "never silently dropped" promise.
                log.warning("byoc_teardown.unknown_resource type=%s id=%s", kind, rid)
                raise SubstrateDeleteError(f"unknown resource type {kind}")

        await asyncio.to_thread(_run)

    return _deleter


__all__ = [
    "SubstrateDeleteError",
    "build_gcp_deleter",
    "execute_teardown",
    "plan_teardown",
    "substrate_resources",
]
