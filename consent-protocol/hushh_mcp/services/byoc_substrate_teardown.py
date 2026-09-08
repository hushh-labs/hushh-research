"""Tear down a BYOC tenant's substrate -- DARK by construction.

These helpers order and execute explicit resource plans; they do not establish a
complete inventory or prove end-to-end account erasure. Invalid inventory refuses
before any deletion. Execution remains behind two independent guards:

  1. ``personal_agent_substrate_teardown_enabled()`` -- founder flag, default off; and
  2. an explicit ``dry_run=False`` at the call site.

With either guard closed, the executor returns the PLAN of what it would delete and
touches nothing. The plan itself is pure and consults no flag, so planning is always
safe.
"""

from __future__ import annotations

import os
from collections.abc import Awaitable, Callable
from copy import deepcopy
from typing import Any


class SubstrateDeleteError(RuntimeError):
    """One planned resource could not be confirmed gone; the message names what and why."""


# Dependency-safe teardown order (LOWER runs first). Reverse of creation, so a
# resource is deleted only after whatever depends on it is gone. KMS is LAST and
# destroys key material through version destruction and retains resource shells.
# KMS also supports conditional resource deletion; this executor does not invoke it.
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
    if not isinstance(resources, (list, tuple)):
        raise SubstrateDeleteError("substrate inventory must be an explicit sequence")
    actions: list[dict[str, Any]] = []
    targets: set[tuple[str, ...]] = set()
    for r in resources:
        if not isinstance(r, dict) or any(
            not isinstance(r.get(key), str) or not r[key].strip() for key in ("type", "id")
        ):
            raise SubstrateDeleteError("substrate inventory contains an invalid resource")
        rtype = r["type"].strip()
        rid = r["id"].strip()
        action: dict[str, Any] = {
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
        if "resourceObservation" in r:
            from hushh_mcp.services.byoc_substrate import (
                _bucket_creation_identity,
                _kms_key_creation_identity,
                _secret_creation_identity,
                _service_account_creation_identity,
            )

            observation = r["resourceObservation"]
            if (
                rtype not in {"service_account", "kms_key", "secret", "gcs_bucket"}
                or not isinstance(observation, dict)
                or observation.get("type") != rtype
                or observation.get("id") != rid
                or observation.get("disposition") != "created"
            ):
                raise SubstrateDeleteError("substrate creation observation invalid or unsupported")
            if rtype == "gcs_bucket":
                identity = _bucket_creation_identity(observation.get("identity"), rid)
            elif rtype == "service_account":
                identity = _service_account_creation_identity(observation.get("identity"), rid)
            elif rtype == "secret":
                raw_identity = observation.get("identity")
                project_id = raw_identity.get("projectId") if isinstance(raw_identity, dict) else ""
                identity = _secret_creation_identity(raw_identity, rid, project_id)
            else:
                raw_identity = observation.get("identity")
                name = raw_identity.get("name", "") if isinstance(raw_identity, dict) else ""
                identity = _kms_key_creation_identity(raw_identity, name)
                if identity and identity["name"].rsplit("/", 1)[-1] != rid:
                    identity = None
            if identity is None:
                raise SubstrateDeleteError("substrate creation identity invalid")
            action["resourceObservation"] = {
                "type": rtype,
                "id": rid,
                "disposition": "created",
                "identity": identity,
            }
        # A resource incarnation gets one action. Conflicting observations must
        # not turn the same provider target into two independent admissions.
        # IAM IDs are display labels; its actual target includes the grant.
        target = (
            (
                rtype,
                str(action.get("resource", "")) if rtype == "service_account_iam_binding" else "",
                str(action.get("role", "")),
                str(action.get("member", "")),
            )
            if rtype in {"iam_binding", "service_account_iam_binding"}
            else (rtype, rid)
        )
        if target in targets:
            raise SubstrateDeleteError("substrate inventory contains duplicate targets")
        targets.add(target)
        actions.append(action)
    actions.sort(key=lambda a: _TEARDOWN_PRIORITY.get(a["type"], 49))
    return actions


async def execute_teardown(
    actions: Any,
    *,
    deleter: Any,
    dry_run: bool = True,
    before_action: Callable[[dict[str, Any]], Awaitable[bool]] | None = None,
    on_result: Callable[[dict[str, Any]], Awaitable[bool]] | None = None,
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
    permissions and keys needed to recover are deferred and recorded as incomplete.

    Coordinated callers supply BOTH callbacks. ``before_action`` must exclusively
    retain admission in the existing owner reservation; ``on_result`` must retain
    the observed outcome there. Only explicit True acknowledges persistence. A lost
    admission or result stops further actions, leaving reconciliation to that owner.
    These callbacks do not themselves establish ownership or durable storage.
    """
    from hushh_mcp.runtime_settings import (  # noqa: PLC0415
        personal_agent_substrate_teardown_enabled,
    )

    # Validate the complete inventory before the first destructive operation.
    # Callers cannot bypass the planner with a partially malformed action list.
    if (before_action is None) != (on_result is None):
        raise SubstrateDeleteError("cleanup admission and outcome callbacks must be paired")
    plan = plan_teardown(actions)
    live = (not dry_run) and personal_agent_substrate_teardown_enabled()
    if not live:
        return {
            "executed": False,
            "reason": "guarded",
            "planned": plan,
            "deleted": [],
            "failed": [],
        }

    async def retain(
        callback: Callable[[dict[str, Any]], Awaitable[bool]], payload: dict[str, Any]
    ) -> bool:
        import asyncio

        try:
            return await asyncio.wait_for(callback(deepcopy(payload)), timeout=30) is True
        except Exception:  # noqa: BLE001 -- persistence errors may expose connection details
            return False

    deleted: list[dict[str, Any]] = []
    failed: list[dict[str, Any]] = []
    retention_failed = False
    for action in plan:
        if retention_failed:
            failed.append({**action, "reason": "deferred_until_cleanup_receipt_confirmed"})
            continue
        if failed and action.get("type") in _RECOVERY_AUTHORITY_TYPES:
            failed.append({**action, "reason": "deferred_until_dependencies_erased"})
            continue
        if before_action is not None and not await retain(before_action, action):
            failed.append({**action, "reason": "cleanup_admission_unconfirmed"})
            retention_failed = True
            continue
        reason = ""
        try:
            await deleter(deepcopy(action))
        except Exception as exc:  # noqa: BLE001 - preserve recovery authority after failure
            reason = str(exc) if isinstance(exc, SubstrateDeleteError) else "cleanup_unavailable"
        outcome = {"action": action, "status": "failed" if reason else "deleted"}
        if reason:
            outcome["reason"] = reason
        if on_result is not None and not await retain(on_result, outcome):
            failed.append({**action, "reason": "cleanup_outcome_unconfirmed"})
            retention_failed = True
            continue
        if reason:
            failed.append({**action, "reason": reason})
        else:
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
    """Legacy candidate inventory derived from bootstrap naming, not ownership proof.

    Bootstrap can adopt these names. The fixed artifact repository and bootstrap
    grants may be shared; this inventory alone must not authorize private-pod cleanup.
    Derived from the same naming helpers the bootstrap plan renders from, so the
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


def revoke_runtime_writer(
    *,
    token: str,
    project: str,
    bootstrap_ref: str,
    identity: dict[str, str],
    before_disable: Callable[[dict[str, Any]], bool],
    admitted: bool = False,
    session: Any = None,
) -> dict[str, Any]:
    """Revoke one captured runtime identity; never call disable again after admission.

    A disabled account is not an upload-drain or deletion receipt. The caller owns
    durable admission and must retain/read back this result before dependent work.
    """
    from urllib.parse import quote

    from hushh_mcp.services.byoc_substrate import _service_account_creation_identity

    if (
        _service_account_creation_identity(identity, identity.get("email", "")) != identity
        or identity.get("projectId") != project
        or not bootstrap_ref
    ):
        raise SubstrateDeleteError("runtime writer identity unavailable")
    if session is None:
        import requests  # type: ignore[import-untyped]

        session = requests
    headers = {"Authorization": f"Bearer {token}"}
    base = f"https://iam.googleapis.com/v1/projects/{quote(project, safe='')}/serviceAccounts"
    bootstrap = session.get(
        f"{base}/{quote(bootstrap_ref, safe='')}",
        headers=headers,
        timeout=30,
        allow_redirects=False,
    )
    body = bootstrap.json() if bootstrap.status_code == 200 else None
    bootstrap_identity = _service_account_creation_identity(
        body, body.get("email", "") if isinstance(body, dict) else ""
    )
    if (
        bootstrap_identity is None
        or bootstrap_identity["projectId"] != project
        or bootstrap_ref not in (bootstrap_identity["email"], bootstrap_identity["uniqueId"])
        or bootstrap_identity["uniqueId"] == identity["uniqueId"]
        or (isinstance(body, dict) and body.get("disabled", False) is not False)
    ):
        raise SubstrateDeleteError("independent bootstrap recovery identity unverified")
    url = f"{base}/{identity['uniqueId']}"

    def observe() -> bool:
        response = session.get(url, headers=headers, timeout=30, allow_redirects=False)
        current = response.json() if response.status_code == 200 else None
        if (
            _service_account_creation_identity(current, identity["email"]) != identity
            or not isinstance(current, dict)
            or type(current.get("disabled", False)) is not bool
        ):
            raise SubstrateDeleteError("runtime writer incarnation unverified")
        return current.get("disabled", False) is True

    disabled = observe()
    receipt = {"runtimeIdentity": identity, "bootstrapIdentity": bootstrap_identity}
    if not admitted:
        if before_disable(receipt) is not True:
            raise SubstrateDeleteError("runtime writer admission unconfirmed")
        if not disabled:
            response = session.post(
                url + ":disable", headers=headers, json={}, timeout=30, allow_redirects=False
            )
            if response.status_code != 200 or response.json() != {}:
                raise SubstrateDeleteError("runtime writer revocation unconfirmed")
        disabled = observe()
    if not disabled:
        raise SubstrateDeleteError("runtime writer revocation unresolved")
    return {**receipt, "status": "disabled"}


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
        response = session.delete(url, headers=headers, timeout=30, allow_redirects=False)
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

    def _delete_observed_bucket(bucket: str, expected: dict[str, str]) -> None:
        from urllib.parse import quote

        from hushh_mcp.services.byoc_substrate import _bucket_creation_identity

        # Bucket names are global: bind the retained project number to the
        # configured project before reading any bucket information.
        resolved = session.get(
            f"https://cloudresourcemanager.googleapis.com/v1/projects/{quote(project, safe='')}",
            headers=headers,
            timeout=30,
            allow_redirects=False,
        )
        body = resolved.json() if resolved.status_code == 200 else None
        if (
            not isinstance(body, dict)
            or body.get("projectId") != project
            or body.get("projectNumber") != expected["projectNumber"]
        ):
            raise SubstrateDeleteError("bucket creation project unverified")
        url = f"https://storage.googleapis.com/storage/v1/b/{quote(bucket, safe='')}"

        def current_metageneration() -> str:
            response = session.get(url, headers=headers, timeout=30, allow_redirects=False)
            current = response.json() if response.status_code == 200 else None
            if (
                not isinstance(current, dict)
                or _bucket_creation_identity(current, bucket) != expected
            ):
                raise SubstrateDeleteError("bucket creation identity unverified")
            meta = current.get("metageneration")
            if (
                not isinstance(meta, str)
                or not 1 <= len(meta) <= 20
                or not meta.isascii()
                or not meta.isdigit()
                or int(meta) <= 0
            ):
                raise SubstrateDeleteError("bucket metageneration unverified")
            return meta

        current_metageneration()
        _empty_bucket(bucket)
        meta = current_metageneration()
        # This protects metadata changes, not atomic bucket-incarnation changes.
        # Exclusive lifecycle admission and writer quiescence remain required.
        response = session.delete(
            url,
            headers=headers,
            params={"ifMetagenerationMatch": meta},
            timeout=30,
            allow_redirects=False,
        )
        if response.status_code not in (200, 204):
            raise SubstrateDeleteError("bucket conditional deletion unconfirmed")
        absent = session.get(url, headers=headers, timeout=30, allow_redirects=False)
        retained = session.get(
            url,
            headers=headers,
            params={"softDeleted": True, "generation": expected["generation"]},
            timeout=30,
            allow_redirects=False,
        )
        if absent.status_code != 404 or retained.status_code != 404:
            raise SubstrateDeleteError("bucket retained generation remains or absence unverified")

    def _empty_bucket(bucket: str) -> None:
        from urllib.parse import quote

        base = f"https://storage.googleapis.com/storage/v1/b/{quote(bucket, safe='')}/o"
        # Re-read the first page after deleting its exact generations. A new
        # object version must never inherit a previously observed deletion.
        for _ in range(32):
            listing = session.get(
                base,
                headers=headers,
                params={
                    "maxResults": 1000,
                    "versions": True,
                    "fields": "items(name,generation),nextPageToken",
                },
                timeout=30,
                allow_redirects=False,
            )
            if listing.status_code != 200:
                # A missing bucket can be soft-deleted. Without its retained
                # generation/inventory, 404 cannot certify historical erasure.
                raise SubstrateDeleteError(
                    f"bucket version inventory unavailable http={listing.status_code}"
                )
            body = listing.json()
            if not isinstance(body, dict) or body.get("error") is not None:
                raise SubstrateDeleteError("bucket version inventory invalid")
            items = body.get("items", [])
            if not isinstance(items, list) or any(
                not isinstance(item, dict)
                or not isinstance(item.get("name"), str)
                or not item["name"]
                or not isinstance(item.get("generation"), str)
                or not item["generation"].isascii()
                or not item["generation"].isdigit()
                or int(item["generation"]) <= 0
                for item in items
            ):
                raise SubstrateDeleteError("bucket version inventory invalid")
            if not items:
                if body.get("nextPageToken"):
                    raise SubstrateDeleteError("bucket version inventory incomplete")
                retained = session.get(
                    base,
                    headers=headers,
                    params={
                        "maxResults": 1,
                        "softDeleted": True,
                        "fields": "items(name,generation),nextPageToken",
                    },
                    timeout=30,
                    allow_redirects=False,
                )
                if retained.status_code != 200:
                    raise SubstrateDeleteError("bucket retained-object inventory unavailable")
                retained_body = retained.json()
                if (
                    not isinstance(retained_body, dict)
                    or retained_body.get("error") is not None
                    or retained_body.get("items", []) != []
                    or retained_body.get("nextPageToken")
                ):
                    raise SubstrateDeleteError(
                        "bucket retained objects remain or inventory is invalid"
                    )
                return
            for item in items:
                response = session.delete(
                    f"{base}/{quote(item['name'], safe='')}",
                    headers=headers,
                    params={
                        "generation": item["generation"],
                        "ifGenerationMatch": item["generation"],
                    },
                    timeout=30,
                    allow_redirects=False,
                )
                if response.status_code not in (200, 204, 404):
                    raise SubstrateDeleteError(
                        f"bucket object generation deletion http={response.status_code}"
                    )
        raise SubstrateDeleteError("bucket not emptied after 32 version pages")

    def _delete_artifact_repository(repository: str) -> None:
        # DELETE acknowledges a long-running operation, not completed erasure.
        # A pending operation keeps the existing teardown retry authority intact.
        base = "https://artifactregistry.googleapis.com/v1/"
        parent = f"projects/{project}/locations/{region}"
        url = f"{base}{parent}/repositories/{repository}"
        response = session.delete(url, headers=headers, timeout=30, allow_redirects=False)
        if response.status_code == 404:
            return
        if response.status_code != 200:
            raise SubstrateDeleteError(f"artifact repository http={response.status_code}")
        operation = response.json() or {}
        name = str(operation.get("name") or "")
        prefix = f"{parent}/operations/"
        operation_id = name.removeprefix(prefix)
        if (
            not name.startswith(prefix)
            or not operation_id
            or any(
                char not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"
                for char in operation_id
            )
        ):
            raise SubstrateDeleteError("artifact deletion operation identity mismatch")
        if operation.get("done") is not True:
            observed = session.get(f"{base}{name}", headers=headers, timeout=30)
            if observed.status_code != 200:
                raise SubstrateDeleteError(
                    f"artifact deletion operation http={observed.status_code}"
                )
            operation = observed.json() or {}
            if operation.get("name") != name:
                raise SubstrateDeleteError("artifact deletion operation identity mismatch")
        if "error" in operation:
            # Provider error messages can contain private resource details.
            raise SubstrateDeleteError("artifact deletion operation failed")
        if operation.get("done") is not True or "response" not in operation:
            raise SubstrateDeleteError("artifact deletion pending verification")
        absent = session.get(url, headers=headers, timeout=30)
        if absent.status_code != 404:
            raise SubstrateDeleteError(
                f"artifact repository absence unverified http={absent.status_code}"
            )

    def _destroy_kms_versions(key_id: str) -> None:
        parent = f"projects/{project}/locations/{region}/keyRings/hushh-one/cryptoKeys/{key_id}"
        # Scheduling is reversible. Only a complete inventory of DESTROYED
        # versions proves erasure; pending versions retain retry authority.
        page_token = ""
        pending = False
        seen_tokens: set[str] = set()
        for _ in range(32):
            listing = session.get(
                f"https://cloudkms.googleapis.com/v1/{parent}/cryptoKeyVersions",
                headers=headers,
                params={"pageSize": 1000, **({"pageToken": page_token} if page_token else {})},
                timeout=30,
                allow_redirects=False,
            )
            if listing.status_code == 404 and not page_token:
                return  # key never created -- retry-safe
            if listing.status_code != 200:
                raise SubstrateDeleteError(f"kms version listing http={listing.status_code}")
            body = listing.json()
            if not isinstance(body, dict) or body.get("error") is not None:
                raise SubstrateDeleteError("kms version inventory invalid")
            versions = body.get("cryptoKeyVersions", [])
            continuation = body.get("nextPageToken", "")
            prefix = f"{parent}/cryptoKeyVersions/"
            if (
                not isinstance(versions, list)
                or not isinstance(continuation, str)
                or continuation in seen_tokens
                or len(continuation) > 4096
            ):
                raise SubstrateDeleteError("kms version inventory invalid")
            # Validate every entry before acting on this page, including entries
            # claiming DESTROYED. A foreign destroyed key proves nothing here.
            for version in versions:
                if not isinstance(version, dict):
                    raise SubstrateDeleteError("kms version inventory invalid")
                name = version.get("name")
                state = version.get("state")
                if (
                    not isinstance(name, str)
                    or not name.startswith(prefix)
                    or not name[len(prefix) :].isascii()
                    or not name[len(prefix) :].isdigit()
                ):
                    raise SubstrateDeleteError("kms version identity mismatch")
                if not isinstance(state, str) or not state:
                    raise SubstrateDeleteError("kms version state unavailable")
            for version in versions:
                state = version["state"]
                if state == "DESTROYED":
                    continue
                pending = True
                if state == "DESTROY_SCHEDULED":
                    continue
                name = version["name"]
                resp = session.post(
                    f"https://cloudkms.googleapis.com/v1/{name}:destroy",
                    headers=headers,
                    timeout=30,
                    allow_redirects=False,
                )
                if resp.status_code not in (200, 404):
                    raise SubstrateDeleteError(f"kms version destroy http={resp.status_code}")
            page_token = continuation
            if continuation:
                seen_tokens.add(continuation)
            if not page_token:
                if pending:
                    raise SubstrateDeleteError("kms destruction pending verification")
                return
        raise SubstrateDeleteError("kms version inventory exceeds 32 pages")

    def _policy_without_binding(policy: Any, role: str, member: str) -> Any:
        if not isinstance(policy, dict) or policy.get("error") is not None:
            raise SubstrateDeleteError("iam policy inventory invalid")
        bindings = policy.get("bindings", [])
        if not isinstance(bindings, list) or any(
            not isinstance(binding, dict)
            or not isinstance(binding.get("role"), str)
            or not binding["role"]
            or not isinstance(binding.get("members"), list)
            or any(not isinstance(value, str) or not value for value in binding["members"])
            for binding in bindings
        ):
            raise SubstrateDeleteError("iam policy inventory invalid")
        if any("condition" in binding for binding in bindings) and policy.get("version") != 3:
            raise SubstrateDeleteError("iam conditional policy version unavailable")
        kept, changed = [], False
        for binding in bindings:
            if binding["role"] == role and member in binding["members"]:
                changed = True
                members = [value for value in binding["members"] if value != member]
                if members:
                    kept.append({**binding, "members": members})
            else:
                kept.append(binding)
        if not changed:
            return None
        if not isinstance(policy.get("etag"), str) or not policy["etag"].strip():
            raise SubstrateDeleteError("iam policy concurrency precondition unavailable")
        return {**policy, "bindings": kept}

    def _remove_project_iam_binding(role: str, member: str) -> None:
        # Read-modify-write on the project policy, mirroring bootstrap's merge_binding
        # in reverse. The fetched policy's etag rides along inside `policy`, so a
        # concurrent write 409s and surfaces as a retryable failure, never a clobber.
        base = f"https://cloudresourcemanager.googleapis.com/v1/projects/{project}"
        got = session.post(
            f"{base}:getIamPolicy",
            headers=headers,
            json={"options": {"requestedPolicyVersion": 3}},
            timeout=30,
            allow_redirects=False,
        )
        if got.status_code != 200:
            raise SubstrateDeleteError(f"project iam getIamPolicy http={got.status_code}")
        policy = _policy_without_binding(got.json(), role, member)
        if policy is None:
            return
        put = session.post(
            f"{base}:setIamPolicy",
            headers=headers,
            json={"policy": policy},
            timeout=30,
            allow_redirects=False,
        )
        if put.status_code != 200:
            raise SubstrateDeleteError(f"project iam setIamPolicy http={put.status_code}")

    def _remove_service_account_iam_binding(resource: str, role: str, member: str) -> None:
        # The same read-modify-write as the project version, on the service ACCOUNT's
        # own policy. Never a whole-policy replace: the person may hold bindings here
        # that hushh knows nothing about, and dropping them while claiming to revoke
        # one grant is the failure safe-changes R3 exists for.
        base = f"https://iam.googleapis.com/v1/projects/{project}/serviceAccounts/{resource}"
        got = session.post(
            f"{base}:getIamPolicy",
            headers=headers,
            params={"options.requestedPolicyVersion": 3},
            timeout=30,
            allow_redirects=False,
        )
        if got.status_code == 404:
            return  # the account is gone, so the grant on it is too -- idempotent
        if got.status_code != 200:
            raise SubstrateDeleteError(f"sa iam getIamPolicy http={got.status_code}")
        policy = _policy_without_binding(got.json(), role, member)
        if policy is None:
            return
        put = session.post(
            f"{base}:setIamPolicy",
            headers=headers,
            json={"policy": policy},
            timeout=30,
            allow_redirects=False,
        )
        if put.status_code != 200:
            raise SubstrateDeleteError(f"sa iam setIamPolicy http={put.status_code}")

    async def _deleter(action: dict) -> None:
        import asyncio  # noqa: PLC0415

        # Revalidate even when the injected deleter is called without the executor.
        action = plan_teardown([action])[0]
        kind = action["type"]
        rid = action["id"]
        observation = action.get("resourceObservation")
        if observation:
            if (
                kind in {"service_account", "secret"}
                and observation["identity"]["projectId"] != project
            ):
                raise SubstrateDeleteError("substrate creation project mismatch")
            if kind == "kms_key" and observation["identity"]["name"] != (
                f"projects/{project}/locations/{region}/keyRings/hushh-one/cryptoKeys/{rid}"
            ):
                raise SubstrateDeleteError("substrate creation project or region mismatch")

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
                if observation:
                    _delete_observed_bucket(rid, observation["identity"])
                    return
                _empty_bucket(rid)
                # No 409 in the ok tuple: a not-empty refusal is a recorded failure,
                # never minted success.
                _delete(
                    f"https://storage.googleapis.com/storage/v1/b/{rid}",
                    "bucket",
                )
            elif kind == "secret":
                if not observation:
                    _delete(
                        f"https://secretmanager.googleapis.com/v1/projects/{project}/secrets/{rid}",
                        "secret",
                    )
                    return
                from hushh_mcp.services.byoc_substrate import _secret_creation_identity

                expected = observation["identity"]
                # A receipt may describe a numeric alias, but must never select
                # the request's authority boundary. Resolve through the bound project.
                url = f"https://secretmanager.googleapis.com/v1/projects/{project}/secrets/{rid}"
                current = session.get(url, headers=headers, timeout=30, allow_redirects=False)
                if current.status_code != 200:
                    raise SubstrateDeleteError("secret creation identity unavailable")
                body = current.json()
                if not isinstance(body, dict):
                    raise SubstrateDeleteError("secret creation identity invalid")
                candidate = {
                    "name": body.get("name"),
                    "createTime": body.get("createTime"),
                    "projectId": project,
                    **(
                        {"projectNumber": expected["projectNumber"]}
                        if "projectNumber" in expected
                        else {}
                    ),
                }
                etag = body.get("etag")
                if (
                    _secret_creation_identity(candidate, rid, project) != expected
                    or not isinstance(etag, str)
                    or not etag.strip()
                    or len(etag) > 512
                ):
                    raise SubstrateDeleteError("secret creation identity or etag unverified")
                deleted = session.delete(
                    url,
                    headers=headers,
                    params={"etag": etag},
                    timeout=30,
                    allow_redirects=False,
                )
                if deleted.status_code not in _OK:
                    raise SubstrateDeleteError("secret conditional deletion unconfirmed")
                absent = session.get(url, headers=headers, timeout=30, allow_redirects=False)
                if absent.status_code != 404:
                    raise SubstrateDeleteError("secret deletion unverified")
            elif kind == "service_account":
                # The provider's immutable numeric ID prevents a retry from deleting
                # a replacement account that reuses the original email. Legacy plans
                # have no creation receipt and retain their existing compatibility path.
                account_id = observation["identity"]["uniqueId"] if observation else rid
                url = (
                    f"https://iam.googleapis.com/v1/projects/{project}/serviceAccounts/{account_id}"
                )
                _delete(url, "service account")
                if observation:
                    absent = session.get(url, headers=headers, timeout=30, allow_redirects=False)
                    if absent.status_code != 404:
                        raise SubstrateDeleteError("service account deletion unverified")
            elif kind == "artifact_repository":
                _delete_artifact_repository(rid)
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
                # This cleanup policy destroys key material and retains the key
                # shell. It does not invoke KMS resource deletion or claim absence.
                if observation:
                    from hushh_mcp.services.byoc_substrate import _kms_key_creation_identity

                    expected = observation["identity"]
                    response = session.get(
                        f"https://cloudkms.googleapis.com/v1/{expected['name']}",
                        headers=headers,
                        timeout=30,
                        allow_redirects=False,
                    )
                    if (
                        response.status_code != 200
                        or _kms_key_creation_identity(response.json(), expected["name"]) != expected
                    ):
                        raise SubstrateDeleteError("KMS key creation identity unverified")
                _destroy_kms_versions(rid)
            else:
                # A plan entry nothing knows how to delete must fail the completeness
                # check, honoring plan_teardown's "never silently dropped" promise.
                log.warning("byoc_teardown.unknown_resource")
                raise SubstrateDeleteError("unknown resource type")

        await asyncio.to_thread(_run)

    return _deleter


__all__ = [
    "SubstrateDeleteError",
    "build_gcp_deleter",
    "execute_teardown",
    "plan_teardown",
    "substrate_resources",
]
