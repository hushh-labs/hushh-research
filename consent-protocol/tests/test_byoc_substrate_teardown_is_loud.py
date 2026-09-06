"""The real GCP deleter converts every refusal into a raise, never into silence.

Defect being pinned: a single revoked grant (403) used to be swallowed as a warning,
execute_teardown counted the action as deleted, and account deletion then wrote the
substrate_torn_down tombstone -- a clean-erase claim over surviving, billing resources.
These drive build_gcp_deleter against a scripted REST session and assert that anything
short of confirmed-gone raises SubstrateDeleteError (404-already-gone stays success,
because a retry must not wedge on its own progress).
"""

from __future__ import annotations

from typing import Any

import pytest

from hushh_mcp.services.byoc_substrate_teardown import (
    SubstrateDeleteError,
    build_gcp_deleter,
    execute_teardown,
)


class _Resp:
    def __init__(self, status: int, body: dict | None = None):
        self.status_code = status
        self._body = body or {}

    def json(self):
        return self._body


class _Session:
    """A scripted GCP REST surface: rules match on (method, URL fragment), in order."""

    def __init__(self):
        self.rules: list[tuple[str, str, Any]] = []
        self.calls: list[tuple[str, str, dict]] = []

    def rule(self, method: str, fragment: str, resp: Any) -> None:
        self.rules.append((method, fragment, resp))

    def _dispatch(self, method: str, url: str, **kwargs):
        self.calls.append((method, url, kwargs))
        for m, fragment, resp in self.rules:
            if m == method and fragment in url:
                return resp(url, kwargs) if callable(resp) else resp
        raise AssertionError(f"unscripted {method} {url}")

    def delete(self, url, **kwargs):
        return self._dispatch("DELETE", url, **kwargs)

    def get(self, url, **kwargs):
        return self._dispatch("GET", url, **kwargs)

    def post(self, url, **kwargs):
        return self._dispatch("POST", url, **kwargs)


def _deleter(session: _Session):
    return build_gcp_deleter(
        token="tok",  # noqa: S106 -- a placeholder; the REST surface is scripted here
        project="proj-x",
        region="us-central1",
        session=session,
    )


_SA_ACTION = {
    "type": "service_account",
    "id": "one-pod-abc@proj-x.iam.gserviceaccount.com",
    "op": "delete",
}


async def test_403_delete_is_a_failure_not_a_success(monkeypatch):
    session = _Session()
    session.rule("DELETE", "/serviceAccounts/", _Resp(403))
    deleter = _deleter(session)

    with pytest.raises(SubstrateDeleteError, match="http=403"):
        await deleter(dict(_SA_ACTION))

    # ... and through execute_teardown the action lands in failed, never deleted
    monkeypatch.setenv("PERSONAL_AGENT_SUBSTRATE_TEARDOWN_ENABLED", "1")
    summary = await execute_teardown([dict(_SA_ACTION)], deleter=deleter, dry_run=False)
    assert summary["executed"] is True
    assert summary["complete"] is False
    assert summary["deleted"] == []
    assert [a["id"] for a in summary["failed"]] == [_SA_ACTION["id"]]
    assert "http=403" in summary["failed"][0]["reason"]


async def test_bucket_not_empty_is_a_failure():
    # An empty listing followed by a 409 on the bucket delete: the old code minted
    # 409-not-empty as success; now it is a recorded failure.
    session = _Session()
    session.rule("GET", "/b/one-pod-x-blobs/o", _Resp(200, {"items": []}))
    session.rule("DELETE", "/b/one-pod-x-blobs", _Resp(409))
    with pytest.raises(SubstrateDeleteError, match="bucket http=409"):
        await _deleter(session)({"type": "gcs_bucket", "id": "one-pod-x-blobs", "op": "delete"})

    # A bucket that never empties (items on every page) fails loudly at the page bound
    # instead of looping into a silent 409.
    session = _Session()
    session.rule("GET", "/b/one-pod-x-blobs/o", _Resp(200, {"items": [{"name": "obj"}]}))
    session.rule("DELETE", "/o/", _Resp(204))
    with pytest.raises(SubstrateDeleteError, match="not emptied after 32 pages"):
        await _deleter(session)({"type": "gcs_bucket", "id": "one-pod-x-blobs", "op": "delete"})


async def test_bucket_listing_failure_is_loud():
    session = _Session()
    session.rule("GET", "/b/one-pod-x-blobs/o", _Resp(500))
    with pytest.raises(SubstrateDeleteError, match="bucket object listing http=500"):
        await _deleter(session)({"type": "gcs_bucket", "id": "one-pod-x-blobs", "op": "delete"})

    # companion: already-gone stays idempotent -- listing 404 + bucket delete 404 raise nothing
    session = _Session()
    session.rule("GET", "/b/one-pod-x-blobs/o", _Resp(404))
    session.rule("DELETE", "/b/one-pod-x-blobs", _Resp(404))
    await _deleter(session)({"type": "gcs_bucket", "id": "one-pod-x-blobs", "op": "delete"})


async def test_kms_listing_and_destroy_are_checked():
    session = _Session()
    session.rule("GET", "/cryptoKeyVersions", _Resp(500))
    with pytest.raises(SubstrateDeleteError, match="kms version listing http=500"):
        await _deleter(session)(
            {"type": "kms_key", "id": "one-pod-x-key", "op": "destroy_versions"}
        )

    # The :destroy POST result was previously ignored -- the quietest possible failure
    # on the real erasure of the sealed holdings. Now a refused destroy raises.
    session = _Session()
    version = {"name": "projects/proj-x/.../cryptoKeyVersions/1", "state": "ENABLED"}
    session.rule("GET", "/cryptoKeyVersions", _Resp(200, {"cryptoKeyVersions": [version]}))
    session.rule("POST", ":destroy", _Resp(403))
    with pytest.raises(SubstrateDeleteError, match="kms version destroy http=403"):
        await _deleter(session)(
            {"type": "kms_key", "id": "one-pod-x-key", "op": "destroy_versions"}
        )


async def test_iam_binding_removed_via_read_modify_write():
    pod = "serviceAccount:one-pod-abc@proj-x.iam.gserviceaccount.com"
    other = "serviceAccount:someone-else@proj-x.iam.gserviceaccount.com"
    action = {
        "type": "iam_binding",
        "id": f"roles/aiplatform.user:{pod.split(':', 1)[1]}",
        "op": "delete",
        "role": "roles/aiplatform.user",
        "member": pod,
    }

    session = _Session()
    session.rule(
        "POST",
        ":getIamPolicy",
        _Resp(
            200,
            {
                "etag": "abc123",
                "bindings": [
                    {"role": "roles/aiplatform.user", "members": [pod, other]},
                    {"role": "roles/viewer", "members": [other]},
                ],
            },
        ),
    )
    session.rule("POST", ":setIamPolicy", _Resp(200))
    await _deleter(session)(dict(action))

    set_calls = [c for c in session.calls if ":setIamPolicy" in c[1]]
    assert len(set_calls) == 1
    policy = set_calls[0][2]["json"]["policy"]
    # the pod member is gone, the other member and the etag ride along untouched
    vertex = next(b for b in policy["bindings"] if b["role"] == "roles/aiplatform.user")
    assert pod not in vertex["members"]
    assert other in vertex["members"]
    assert policy["etag"] == "abc123"
    assert {"role": "roles/viewer", "members": [other]} in policy["bindings"]

    # already absent -> no write at all, and nothing raises (idempotent retry after
    # the SA delete rewrote the member as deleted: residue)
    session = _Session()
    session.rule(
        "POST",
        ":getIamPolicy",
        _Resp(200, {"etag": "abc123", "bindings": [{"role": "roles/viewer", "members": [other]}]}),
    )
    await _deleter(session)(dict(action))
    assert [c for c in session.calls if ":setIamPolicy" in c[1]] == []


async def test_unknown_resource_type_is_a_failure():
    # A plan entry nothing knows how to delete must fail the completeness check --
    # plan_teardown promises a new resource kind is never silently dropped.
    with pytest.raises(SubstrateDeleteError, match="unknown resource type something_new"):
        await _deleter(_Session())({"type": "something_new", "id": "x", "op": "delete"})


# -- giving back hushh's own access, which teardown used to keep ----------------

_BOOTSTRAP = "one-bootstrap@proj-x.iam.gserviceaccount.com"
_HUSHH = "serviceAccount:consent-plane@hushh.iam.gserviceaccount.com"
_REVOKE = {
    "type": "service_account_iam_binding",
    "id": f"roles/iam.serviceAccountTokenCreator:{_HUSHH}@{_BOOTSTRAP}",
    "resource": _BOOTSTRAP,
    "role": "roles/iam.serviceAccountTokenCreator",
    "member": _HUSHH,
}


def test_hushh_impersonation_grant_is_revoked_last():
    """Ordering is the design, not a preference.

    This binding is hushh's permission to impersonate the bootstrap account -- the
    identity every other delete in the plan runs as. Revoke it earlier and teardown
    strands itself in a project it has just lost the only way back into.
    """
    from hushh_mcp.services.byoc_substrate_teardown import plan_teardown, substrate_resources

    actions = plan_teardown(
        substrate_resources(
            "ha1_abc", "proj-x", bootstrap_sa=_BOOTSTRAP, hushh_caller=_HUSHH.split(":", 1)[1]
        )
    )
    assert actions[-1]["type"] == "service_account_iam_binding"
    assert actions[-1]["resource"] == _BOOTSTRAP


def test_the_revocation_is_omitted_when_either_identity_is_unknown(monkeypatch):
    """A binding with an empty member matches nothing and deletes nothing.

    Emitting one anyway would let execute_teardown count it deleted and mint a
    clean-erasure summary over an access that is still live.
    """
    from hushh_mcp.services.byoc_substrate_teardown import substrate_resources

    monkeypatch.delenv("HUSSH_CONSENT_PLANE_SA", raising=False)
    kinds = lambda rs: {r["type"] for r in rs}  # noqa: E731
    assert "service_account_iam_binding" not in kinds(
        substrate_resources("ha1_abc", "proj-x", bootstrap_sa="", hushh_caller="who@hushh")
    )
    assert "service_account_iam_binding" not in kinds(
        substrate_resources("ha1_abc", "proj-x", bootstrap_sa=_BOOTSTRAP, hushh_caller="")
    )


async def test_revoking_hushh_keeps_every_other_binding():
    """Read-modify-write, never a whole-policy replace (safe-changes R3).

    The person may hold bindings on their own account that hushh knows nothing about.
    Dropping them while reporting that one grant was revoked would be a larger and
    quieter change than the one being made.
    """
    theirs = "user:alice@example.com"
    session = _Session()
    session.rule(
        "POST",
        ":getIamPolicy",
        _Resp(
            200,
            {
                "etag": "etag-9",
                "bindings": [
                    {
                        "role": "roles/iam.serviceAccountTokenCreator",
                        "members": [_HUSHH, theirs],
                    },
                    {"role": "roles/iam.serviceAccountUser", "members": [theirs]},
                ],
            },
        ),
    )
    session.rule("POST", ":setIamPolicy", _Resp(200))
    await _deleter(session)(dict(_REVOKE))

    policy = [c for c in session.calls if ":setIamPolicy" in c[1]][0][2]["json"]["policy"]
    creator = next(
        b for b in policy["bindings"] if b["role"] == "roles/iam.serviceAccountTokenCreator"
    )
    assert _HUSHH not in creator["members"], "hushh still holds the grant"
    assert theirs in creator["members"], "the person's own grant was collateral"
    assert {"role": "roles/iam.serviceAccountUser", "members": [theirs]} in policy["bindings"]
    assert policy["etag"] == "etag-9", "a dropped etag turns a merge into a clobber"

    # Already revoked -> no write, no raise. Account deletion retries land here.
    session = _Session()
    session.rule("POST", ":getIamPolicy", _Resp(200, {"etag": "e", "bindings": []}))
    await _deleter(session)(dict(_REVOKE))
    assert [c for c in session.calls if ":setIamPolicy" in c[1]] == []


async def test_a_deleted_bootstrap_account_is_idempotent_success():
    """The person deleted the account themselves. The grant went with it."""
    session = _Session()
    session.rule("POST", ":getIamPolicy", _Resp(404))
    await _deleter(session)(dict(_REVOKE))
    assert [c for c in session.calls if ":setIamPolicy" in c[1]] == []


async def test_a_refused_revocation_is_loud():
    """The one failure that must never be swallowed.

    A silent failure here writes the substrate tombstone over an access hushh still
    holds -- the account reads as erased while hushh can still mint admin tokens in
    that project. Same reasoning as the 403-delete case at the top of this file.
    """
    session = _Session()
    session.rule(
        "POST",
        ":getIamPolicy",
        _Resp(200, {"etag": "e", "bindings": [{"role": _REVOKE["role"], "members": [_HUSHH]}]}),
    )
    session.rule("POST", ":setIamPolicy", _Resp(403))
    with pytest.raises(SubstrateDeleteError):
        await _deleter(session)(dict(_REVOKE))

    session = _Session()
    session.rule("POST", ":getIamPolicy", _Resp(500))
    with pytest.raises(SubstrateDeleteError):
        await _deleter(session)(dict(_REVOKE))


async def test_failed_storage_cleanup_preserves_recovery_authority(monkeypatch):
    monkeypatch.setenv("PERSONAL_AGENT_SUBSTRATE_TEARDOWN_ENABLED", "1")
    attempted = []

    async def delete(action):
        attempted.append(action["type"])
        if action["type"] == "gcs_bucket":
            raise SubstrateDeleteError("bucket http=409")

    actions = [
        {"type": kind, "id": f"synthetic-{kind}"}
        for kind in [
            "service_account_iam_binding",
            "secret",
            "kms_key",
            "gcs_bucket",
            "service_account",
            "iam_binding",
        ]
    ]
    result = await execute_teardown(actions, deleter=delete, dry_run=False)
    assert attempted == ["gcs_bucket"]
    assert not result["complete"]
    assert len(result["failed"]) == len(actions)
    assert all(
        item["reason"] == "deferred_until_dependencies_erased" for item in result["failed"][1:]
    )

    # Same receipt inventory can retry after the failed dependency is gone.
    attempted.clear()

    async def succeeding_delete(action):
        attempted.append(action["type"])

    result = await execute_teardown(actions, deleter=succeeding_delete, dry_run=False)
    assert result["complete"]
    assert attempted[0] == "gcs_bucket"
    assert attempted[-1] == "service_account_iam_binding"
