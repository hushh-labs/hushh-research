"""The real GCP deleter converts every refusal into a raise, never into silence.

Defect being pinned: a single revoked grant (403) used to be swallowed as a warning,
execute_teardown counted the action as deleted, and account deletion then wrote the
substrate_torn_down tombstone -- a clean-erase claim over surviving, billing resources.
These drive build_gcp_deleter against a scripted REST session and assert that anything
short of confirmed-gone raises SubstrateDeleteError. Bucket absence alone cannot
prove erasure because soft-deleted objects may survive.
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


@pytest.mark.parametrize(
    "operation,absence,expected",
    [
        ({}, None, "pending verification"),
        ({"done": True, "error": {"message": "synthetic private detail"}}, None, "failed"),
        ({"done": True}, None, "pending verification"),
        ({"done": True, "response": {}}, 200, "absence unverified"),
        ({"done": True, "response": {}}, 403, "absence unverified"),
        ({"done": True, "response": {}}, 404, None),
    ],
)
async def test_artifact_delete_requires_completion_and_absence(operation, absence, expected):
    session = _Session()
    name = "projects/proj-x/locations/us-central1/operations/delete-123"
    session.rule("DELETE", "/repositories/", _Resp(200, {"name": name}))
    session.rule("GET", "/operations/", _Resp(200, {"name": name, **operation}))
    if absence is not None:
        session.rule("GET", "/repositories/", _Resp(absence))
    action = {"type": "artifact_repository", "id": "one-pod"}
    if expected:
        with pytest.raises(SubstrateDeleteError, match=expected) as raised:
            await _deleter(session)(action)
        assert "synthetic private detail" not in str(raised.value)
    else:
        await _deleter(session)(action)


async def test_artifact_delete_rejects_foreign_operation_before_fetch():
    session = _Session()
    session.rule(
        "DELETE",
        "/repositories/",
        _Resp(200, {"name": "projects/foreign/locations/us-central1/operations/delete-123"}),
    )
    with pytest.raises(SubstrateDeleteError, match="identity mismatch"):
        await _deleter(session)({"type": "artifact_repository", "id": "one-pod"})
    assert [method for method, _, _ in session.calls] == ["DELETE"]


async def test_artifact_delete_already_absent_is_retry_safe():
    session = _Session()
    session.rule("DELETE", "/repositories/", _Resp(404))
    await _deleter(session)({"type": "artifact_repository", "id": "one-pod"})
    assert len(session.calls) == 1


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
    session.rule(
        "GET", "/b/one-pod-x-blobs/o", _Resp(200, {"items": [{"name": "obj", "generation": "1"}]})
    )
    session.rule("DELETE", "/o/", _Resp(204))
    with pytest.raises(SubstrateDeleteError, match="not emptied after 32 version pages"):
        await _deleter(session)({"type": "gcs_bucket", "id": "one-pod-x-blobs", "op": "delete"})


async def test_bucket_listing_failure_is_loud():
    session = _Session()
    session.rule("GET", "/b/one-pod-x-blobs/o", _Resp(500))
    with pytest.raises(SubstrateDeleteError, match="bucket version inventory unavailable http=500"):
        await _deleter(session)({"type": "gcs_bucket", "id": "one-pod-x-blobs", "op": "delete"})

    # A missing bucket may retain soft-deleted contents; preserve recovery authority.
    session = _Session()
    session.rule("GET", "/b/one-pod-x-blobs/o", _Resp(404))
    session.rule("DELETE", "/b/one-pod-x-blobs", _Resp(404))
    with pytest.raises(SubstrateDeleteError, match="inventory unavailable http=404"):
        await _deleter(session)({"type": "gcs_bucket", "id": "one-pod-x-blobs", "op": "delete"})
    assert all(method == "GET" for method, _, _ in session.calls)


async def test_bucket_erases_each_generation_before_confirming_no_retained_objects():
    session = _Session()
    remaining = ["1", "2"]

    def inventory(url, kwargs):
        params = kwargs["params"]
        assert kwargs["allow_redirects"] is False
        if params.get("softDeleted"):
            assert not remaining
            assert "versions" not in params
            return _Resp(200)
        assert params["versions"] is True
        return _Resp(200, {"items": [{"name": "logs/entry", "generation": g} for g in remaining]})

    def erase(url, kwargs):
        assert url.endswith("/o/logs%2Fentry")
        generation = kwargs["params"]["generation"]
        assert kwargs["params"]["ifGenerationMatch"] == generation
        remaining.remove(generation)
        return _Resp(204)

    session.rule("GET", "/o", inventory)
    session.rule("DELETE", "/o/", erase)
    session.rule("DELETE", "/b/one-pod-x-blobs", _Resp(204))
    await _deleter(session)({"type": "gcs_bucket", "id": "one-pod-x-blobs"})
    assert not remaining
    assert session.calls[-1][1].endswith("/b/one-pod-x-blobs")


@pytest.mark.parametrize(
    "status,body",
    [
        (200, {"items": [{"name": "old", "generation": "1"}]}),
        (200, {"nextPageToken": "more"}),
        (200, {"items": None}),
        (403, {}),
        (400, {}),
    ],
)
async def test_retained_inventory_refusal_preserves_recovery_authority(monkeypatch, status, body):
    session = _Session()
    session.rule(
        "GET",
        "/o",
        lambda url, kwargs: (
            _Resp(status, body) if kwargs["params"].get("softDeleted") else _Resp(200)
        ),
    )
    monkeypatch.setenv("PERSONAL_AGENT_SUBSTRATE_TEARDOWN_ENABLED", "1")
    result = await execute_teardown(
        [
            {"type": "gcs_bucket", "id": "one-pod-x-blobs", "op": "delete"},
            dict(_SA_ACTION),
        ],
        deleter=_deleter(session),
        dry_run=False,
    )
    assert result["complete"] is False
    assert result["deleted"] == []
    assert all(method == "GET" for method, _, _ in session.calls)


async def test_invalid_version_page_is_rejected_before_any_delete():
    session = _Session()
    session.rule(
        "GET",
        "/o",
        _Resp(
            200,
            {
                "items": [
                    {"name": "valid", "generation": "1"},
                    {"name": "invalid"},
                ]
            },
        ),
    )
    with pytest.raises(SubstrateDeleteError, match="inventory invalid"):
        await _deleter(session)({"type": "gcs_bucket", "id": "one-pod-x-blobs"})
    assert len(session.calls) == 1


async def test_generation_precondition_refusal_never_falls_back_to_name_delete():
    session = _Session()
    session.rule("GET", "/o", _Resp(200, {"items": [{"name": "obj", "generation": "1"}]}))
    session.rule("DELETE", "/o/", _Resp(412))
    with pytest.raises(SubstrateDeleteError, match="generation deletion http=412"):
        await _deleter(session)({"type": "gcs_bucket", "id": "one-pod-x-blobs"})
    assert len(session.calls) == 2
    assert session.calls[-1][2]["params"] == {"generation": "1", "ifGenerationMatch": "1"}


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
    version = {
        "name": "projects/proj-x/locations/us-central1/keyRings/hushh-one/cryptoKeys/one-pod-x-key/cryptoKeyVersions/1",
        "state": "ENABLED",
    }
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
    with pytest.raises(SubstrateDeleteError, match="unknown resource type"):
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


@pytest.mark.parametrize("state", ["ENABLED", "DESTROY_SCHEDULED"])
async def test_kms_recoverable_versions_never_count_as_erased(state):
    session = _Session()
    name = "projects/proj-x/locations/us-central1/keyRings/hushh-one/cryptoKeys/one-pod-x-key/cryptoKeyVersions/1"
    session.rule(
        "GET",
        "/cryptoKeyVersions",
        _Resp(200, {"cryptoKeyVersions": [{"name": name, "state": state}]}),
    )
    session.rule(
        "POST",
        ":destroy",
        _Resp(
            200,
            {
                "name": "projects/proj-x/locations/us-central1/keyRings/hushh-one/cryptoKeys/one-pod-x-key/cryptoKeyVersions/2",
                "state": "DESTROY_SCHEDULED",
            },
        ),
    )
    with pytest.raises(SubstrateDeleteError, match="destruction pending verification"):
        await _deleter(session)({"type": "kms_key", "id": "one-pod-x-key"})
    assert len([call for call in session.calls if call[0] == "POST"]) == (state == "ENABLED")


async def test_kms_inventory_checks_later_pages_before_claiming_erasure():
    session = _Session()

    def listing(url, kwargs):
        if kwargs["params"].get("pageToken") == "second":
            return _Resp(
                200,
                {
                    "cryptoKeyVersions": [
                        {
                            "name": "projects/proj-x/locations/us-central1/keyRings/hushh-one/cryptoKeys/one-pod-x-key/cryptoKeyVersions/2",
                            "state": "DESTROY_SCHEDULED",
                        }
                    ]
                },
            )
        return _Resp(
            200,
            {
                "cryptoKeyVersions": [
                    {
                        "name": "projects/proj-x/locations/us-central1/keyRings/hushh-one/cryptoKeys/one-pod-x-key/cryptoKeyVersions/1",
                        "state": "DESTROYED",
                    }
                ],
                "nextPageToken": "second",
            },
        )

    session.rule("GET", "/cryptoKeyVersions", listing)
    with pytest.raises(SubstrateDeleteError, match="destruction pending verification"):
        await _deleter(session)({"type": "kms_key", "id": "one-pod-x-key"})
    assert len(session.calls) == 2


async def test_kms_completed_destruction_is_retry_safe():
    session = _Session()
    session.rule(
        "GET",
        "/cryptoKeyVersions",
        _Resp(
            200,
            {
                "cryptoKeyVersions": [
                    {
                        "name": "projects/proj-x/locations/us-central1/keyRings/hushh-one/cryptoKeys/one-pod-x-key/cryptoKeyVersions/1",
                        "state": "DESTROYED",
                    }
                ]
            },
        ),
    )
    await _deleter(session)({"type": "kms_key", "id": "one-pod-x-key"})
    assert [call for call in session.calls if call[0] == "POST"] == []


@pytest.mark.parametrize(
    "body",
    [
        {"cryptoKeyVersions": None},
        {"cryptoKeyVersions": {}},
        {"error": {"message": "synthetic private content"}},
        {"nextPageToken": 12},
        {"cryptoKeyVersions": [{"name": "foreign/key/1", "state": "DESTROYED"}]},
        {"cryptoKeyVersions": [{"name": "foreign/key/1", "state": "DESTROY_SCHEDULED"}]},
    ],
)
async def test_invalid_kms_inventory_never_certifies_erasure_or_schedules_destroy(body):
    session = _Session()
    session.rule("GET", "/cryptoKeyVersions", _Resp(200, body))
    with pytest.raises(SubstrateDeleteError) as raised:
        await _deleter(session)({"type": "kms_key", "id": "one-pod-x-key"})
    assert "synthetic private content" not in str(raised.value)
    assert all(method == "GET" for method, _, _ in session.calls)


@pytest.mark.parametrize("second_status", [404, 200])
async def test_kms_pagination_failure_preserves_incomplete_result(second_status):
    session = _Session()
    pages = iter(
        [_Resp(200, {"nextPageToken": "same"}), _Resp(second_status, {"nextPageToken": "same"})]
    )
    session.rule("GET", "/cryptoKeyVersions", lambda url, kwargs: next(pages))
    with pytest.raises(SubstrateDeleteError):
        await _deleter(session)({"type": "kms_key", "id": "one-pod-x-key"})
    assert len(session.calls) == 2


@pytest.mark.parametrize("service_account", [False, True])
@pytest.mark.parametrize("invalid", [None, "etag", "bindings", "version"])
async def test_iam_cleanup_preserves_conditional_grants_and_requires_write_precondition(
    service_account, invalid
):
    member = _HUSHH
    action = (
        dict(_REVOKE)
        if service_account
        else {
            "type": "iam_binding",
            "id": "synthetic-grant",
            "role": "roles/iam.serviceAccountTokenCreator",
            "member": member,
        }
    )
    condition = {
        "title": "synthetic",
        "expression": "request.time < timestamp('2030-01-01T00:00:00Z')",
    }
    unrelated = {
        "role": "roles/viewer",
        "members": ["user:other@example.com"],
        "condition": condition,
    }
    policy = {
        "version": 3,
        "etag": "v1",
        "bindings": [
            {"role": action["role"], "members": [member]},
            unrelated,
        ],
    }
    if invalid == "etag":
        policy.pop("etag")
    elif invalid == "bindings":
        policy["bindings"] = None
    elif invalid == "version":
        policy["version"] = 1
    session = _Session()
    session.rule("POST", ":getIamPolicy", _Resp(200, policy))
    session.rule("POST", ":setIamPolicy", _Resp(200))
    if invalid:
        with pytest.raises(SubstrateDeleteError):
            await _deleter(session)(action)
        assert len(session.calls) == 1
    else:
        await _deleter(session)(action)
        assert session.calls[1][2]["json"]["policy"] == {
            "version": 3,
            "etag": "v1",
            "bindings": [unrelated],
        }
    read = session.calls[0][2]
    assert read["allow_redirects"] is False
    if service_account:
        assert read["params"] == {"options.requestedPolicyVersion": 3}
        assert "json" not in read
    else:
        assert read["json"] == {"options": {"requestedPolicyVersion": 3}}


@pytest.mark.parametrize("case", ["deleted", "still_present", "foreign", "adopted", "invalid_uid"])
async def test_receipted_account_cleanup_targets_creation_identity(case):
    from hushh_mcp.services.byoc_substrate_teardown import plan_teardown

    email = "one-pod-owner@proj-x.iam.gserviceaccount.com"
    uid = "123456789012345678901"
    identity = {
        "name": f"projects/proj-x/serviceAccounts/{email}",
        "projectId": "proj-x",
        "email": email,
        "uniqueId": uid,
        "private": "must-not-retain",
    }
    observation = {
        "type": "service_account",
        "id": email,
        "disposition": "created",
        "identity": identity,
    }
    action = {"type": "service_account", "id": email, "resourceObservation": observation}
    if case == "adopted":
        observation["disposition"] = "adopted"
    elif case == "invalid_uid":
        identity["uniqueId"] = "../replacement"
    elif case == "foreign":
        email = "one-pod-owner@foreign.iam.gserviceaccount.com"
        action["id"] = observation["id"] = identity["email"] = email
        identity.update(projectId="foreign", name=f"projects/foreign/serviceAccounts/{email}")
    session = _Session()
    url = f"https://iam.googleapis.com/v1/projects/proj-x/serviceAccounts/{uid}"
    session.rule("DELETE", url, _Resp(200))
    session.rule("GET", url, _Resp(200 if case == "still_present" else 404))
    if case in {"adopted", "invalid_uid", "foreign"}:
        with pytest.raises(SubstrateDeleteError):
            await _deleter(session)(action)
        assert session.calls == []
        return
    plan = plan_teardown([action])
    assert "private" not in plan[0]["resourceObservation"]["identity"]
    assert plan_teardown(plan) == plan
    if case == "still_present":
        with pytest.raises(SubstrateDeleteError, match="unverified"):
            await _deleter(session)(plan[0])
    else:
        await _deleter(session)(plan[0])
    assert [method for method, _, _ in session.calls] == ["DELETE", "GET"]
    assert all(
        target == url and kwargs["allow_redirects"] is False for _, target, kwargs in session.calls
    )


@pytest.mark.parametrize("case", ["destroyed", "changed", "foreign", "unavailable"])
async def test_receipted_kms_cleanup_verifies_creation_before_version_access(case):
    from hushh_mcp.services.byoc_substrate_teardown import plan_teardown

    name = "projects/proj-x/locations/us-central1/keyRings/hushh-one/cryptoKeys/key-1"
    identity = {"name": name, "purpose": "ENCRYPT_DECRYPT", "createTime": "2026-09-08T00:00:00Z"}
    action = {
        "type": "kms_key",
        "id": "key-1",
        "resourceObservation": {
            "type": "kms_key",
            "id": "key-1",
            "disposition": "created",
            "identity": identity,
        },
    }
    if case == "foreign":
        identity["name"] = name.replace("proj-x", "foreign")
    observed = dict(identity)
    if case == "changed":
        observed["createTime"] = "2026-09-09T00:00:00Z"
    session = _Session()
    session.rule(
        "GET",
        name + "/cryptoKeyVersions",
        _Resp(
            200,
            {"cryptoKeyVersions": [{"name": name + "/cryptoKeyVersions/1", "state": "DESTROYED"}]},
        ),
    )
    session.rule("GET", name, _Resp(404 if case == "unavailable" else 200, observed))
    planned = plan_teardown([action])
    if case == "destroyed":
        await _deleter(session)(planned[0])
        assert len(session.calls) == 2
    else:
        with pytest.raises(SubstrateDeleteError):
            await _deleter(session)(planned[0])
        assert len(session.calls) == (0 if case == "foreign" else 1)
    assert all(method == "GET" for method, _, _ in session.calls)


@pytest.mark.parametrize(
    "case",
    ["deleted", "replacement", "no_etag", "raced", "foreign", "forged_alias", "still_present"],
)
async def test_receipted_secret_cleanup_requires_identity_and_conditional_delete(case):
    from hushh_mcp.services.byoc_substrate_teardown import plan_teardown

    name = "projects/123456789012/secrets/signing-key"
    identity = {
        "name": name,
        "projectId": "proj-x",
        "projectNumber": "123456789012",
        "createTime": "2026-09-08T00:00:00Z",
    }
    action = {
        "type": "secret",
        "id": "signing-key",
        "resourceObservation": {
            "type": "secret",
            "id": "signing-key",
            "disposition": "created",
            "identity": identity,
        },
    }
    if case == "foreign":
        identity["projectId"] = "foreign"
    if case == "forged_alias":
        identity.update(
            projectNumber="999999999999", name="projects/999999999999/secrets/signing-key"
        )
    observed = {"name": name, "createTime": identity["createTime"], "etag": '"current-etag"'}
    if case == "replacement":
        observed["createTime"] = "2026-09-09T00:00:00Z"
    elif case == "no_etag":
        observed.pop("etag")
    session = _Session()
    reads = iter([_Resp(200, observed), _Resp(200 if case == "still_present" else 404)])
    bound_name = "projects/proj-x/secrets/signing-key"
    session.rule("GET", bound_name, lambda _url, _kwargs: next(reads))
    session.rule("DELETE", bound_name, _Resp(412 if case == "raced" else 200))
    plan = plan_teardown([action])
    if case == "deleted":
        await _deleter(session)(plan[0])
    else:
        with pytest.raises(SubstrateDeleteError):
            await _deleter(session)(plan[0])
    deletes = [(url, kwargs) for method, url, kwargs in session.calls if method == "DELETE"]
    assert all("projects/proj-x/secrets/signing-key" in url for _, url, _ in session.calls)
    if case in {"foreign", "forged_alias", "replacement", "no_etag"}:
        assert deletes == []
        if case == "foreign":
            assert session.calls == []
    else:
        assert len(deletes) == 1
        assert deletes[0][1]["params"] == {"etag": '"current-etag"'}
        assert deletes[0][1]["allow_redirects"] is False


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "failure",
    [
        None,
        "foreign_project",
        "replaced",
        "retained",
        "admission_refused",
        "ack_refused",
        "acknowledged_retry",
        "uncertain_retry",
        "object_retained",
    ],
)
async def test_observed_bucket_checks_project_incarnation_and_retention(failure):
    session = _Session()
    identity = {
        "name": "one-pod-x-blobs",
        "generation": "10",
        "projectNumber": "123",
        "timeCreated": "2026-09-01T00:00:00Z",
    }
    action = {
        "type": "gcs_bucket",
        "id": identity["name"],
        "resourceObservation": {
            "type": "gcs_bucket",
            "id": identity["name"],
            "disposition": "created",
            "identity": identity,
        },
    }
    session.rule(
        "GET",
        "cloudresourcemanager",
        _Resp(
            200,
            {
                "projectId": "proj-x",
                "projectNumber": "999" if failure == "foreign_project" else "123",
            },
        ),
    )
    deleted = failure == "acknowledged_retry"

    def metadata(url, kwargs):
        if kwargs.get("params", {}).get("softDeleted"):
            assert kwargs["params"]["generation"] == "10"
            return _Resp(200 if failure == "retained" else 404)
        if deleted:
            return _Resp(404)
        return _Resp(
            200,
            {
                **identity,
                "metageneration": "4",
                "generation": "11" if failure == "replaced" else "10",
            },
        )

    def remove(url, kwargs):
        nonlocal deleted
        assert kwargs["params"] == {"ifMetagenerationMatch": "4"}
        assert kwargs["allow_redirects"] is False
        deleted = True
        return _Resp(204)

    session.rule(
        "GET",
        "/one-pod-x-blobs/o",
        lambda _url, kwargs: _Resp(
            200,
            {"items": [{"name": "held", "generation": "1"}]}
            if failure == "object_retained" and kwargs.get("params", {}).get("softDeleted")
            else {},
        ),
    )
    session.rule("GET", "/b/", metadata)
    session.rule("DELETE", "/b/", remove)
    checkpoints = []
    admission = {"bucketIdentity": identity, "metageneration": "4", "status": "admitted"}
    state = {}
    if failure in {"acknowledged_retry", "uncertain_retry"}:
        state["bucketAdmission"] = admission
    if failure == "acknowledged_retry":
        state["bucketAcknowledgement"] = {**admission, "status": "acknowledged"}

    def retain(stage, receipt):
        checkpoints.append(stage)
        if stage == "bucketAdmission":
            assert not deleted
        if failure == "admission_refused" and stage == "bucketAdmission":
            return False
        if failure == "ack_refused" and stage == "bucketAcknowledgement":
            return False
        assert receipt["bucketIdentity"] == identity
        return True

    deleter = build_gcp_deleter(
        token="tok",  # noqa: S106 -- scripted provider
        project="proj-x",
        region="us-central1",
        session=session,
        bucket_erasure_state=state,
        retain_bucket_receipt=retain,
    )
    if failure and failure != "acknowledged_retry":
        with pytest.raises(SubstrateDeleteError):
            await deleter(action)
    else:
        await deleter(action)
    if failure in {"object_retained", "uncertain_retry"}:
        assert checkpoints == []
        assert not any(method == "DELETE" for method, _, _ in session.calls)
    if failure == "admission_refused":
        assert checkpoints == ["bucketAdmission"] and not deleted
    if failure == "ack_refused":
        assert checkpoints == ["bucketAdmission", "bucketAcknowledgement"]
        before = list(session.calls)
        with pytest.raises(SubstrateDeleteError, match="acknowledgement unresolved"):
            await deleter(action)
        assert not any(method == "DELETE" for method, _, _ in session.calls[len(before) :])
    if failure == "acknowledged_retry":
        assert checkpoints == ["bucketDeletion"]
        assert not any(method == "DELETE" or url.endswith("/o") for method, url, _ in session.calls)
    if failure is None:
        assert checkpoints == ["bucketAdmission", "bucketAcknowledgement", "bucketDeletion"]
    if failure in {"foreign_project", "replaced"}:
        assert not deleted
        assert not any(url.endswith("/o") for _, url, _ in session.calls)
    if failure == "foreign_project":
        assert len(session.calls) == 1


@pytest.mark.parametrize(
    "case",
    [
        "success",
        "same_account_alias",
        "admission_refused",
        "retry_disabled",
        "retry_enabled",
        "disable_failed",
        "replacement",
        "reenabled_during_admission",
    ],
)
def test_runtime_writer_revocation_preserves_recovery_and_never_replays_disable(case):
    from hushh_mcp.services.byoc_substrate_teardown import revoke_runtime_writer

    def account(name, uid):
        email = f"{name}@proj-x.iam.gserviceaccount.com"
        return {
            "name": f"projects/proj-x/serviceAccounts/{email}",
            "email": email,
            "projectId": "proj-x",
            "uniqueId": uid,
        }

    runtime = account("runtime", "123456789")
    bootstrap = account("bootstrap", "987654321")
    if case == "same_account_alias":
        bootstrap = dict(runtime)
    session = _Session()
    # Numeric bootstrap lookup deliberately exercises email/UID alias protection.
    session.rule("GET", f"/{bootstrap['uniqueId']}", _Resp(200, bootstrap))
    observations = iter(
        [
            {**runtime, "uniqueId": "111111111"}
            if case == "replacement"
            else {**runtime, "disabled": case in {"retry_disabled", "reenabled_during_admission"}},
            {**runtime, "disabled": case != "reenabled_during_admission"},
        ]
    )
    if case != "same_account_alias":
        session.rule("GET", f"/{runtime['uniqueId']}", lambda *_: _Resp(200, next(observations)))
    session.rule("POST", ":disable", _Resp(403 if case == "disable_failed" else 200))
    admissions = []

    def admit(receipt):
        assert not any(method == "POST" for method, _, _ in session.calls)
        admissions.append(receipt)
        return case != "admission_refused"

    def invoke():
        return revoke_runtime_writer(
            token="synthetic-token",  # noqa: S106 -- scripted provider, no real credential
            project="proj-x",
            bootstrap_ref=bootstrap["uniqueId"],
            identity=runtime,
            before_disable=admit,
            admitted=case.startswith("retry_"),
            session=session,
        )

    if case in {"success", "retry_disabled"}:
        receipt = invoke()
        assert receipt == {
            "runtimeIdentity": runtime,
            "bootstrapIdentity": bootstrap,
            "status": "disabled",
        }
    else:
        with pytest.raises(SubstrateDeleteError):
            invoke()
    posts = [url for method, url, _ in session.calls if method == "POST"]
    assert len(posts) == (1 if case in {"success", "disable_failed"} else 0)
    assert len(admissions) == (
        1
        if case in {"success", "disable_failed", "admission_refused", "reenabled_during_admission"}
        else 0
    )
    assert all(options["allow_redirects"] is False for _, _, options in session.calls)


async def test_coordinated_bucket_never_falls_back_to_unreceipted_delete():
    session = _Session()

    def unexpected(*args):
        raise AssertionError("no evidence may reach receipt retention")

    deleter = build_gcp_deleter(
        token="tok",  # noqa: S106 -- scripted provider
        project="proj-x",
        region="us-central1",
        session=session,
        bucket_erasure_state={},
        retain_bucket_receipt=unexpected,
    )
    with pytest.raises(SubstrateDeleteError, match="requires creation evidence"):
        await deleter({"type": "gcs_bucket", "id": "unproven-bucket"})
    assert session.calls == []


@pytest.mark.parametrize("kind", ["pubsub_topic", "pubsub_subscription", "cloud_scheduler_job"])
@pytest.mark.parametrize("case", ["deleted", "resume", "uncertain", "ack_refused"])
def test_mail_cleanup_retains_stages_and_never_replays_uncertain_delete(kind, case):
    from hushh_mcp.services.byoc_substrate_teardown import reconcile_mail_resource

    segment = {
        "pubsub_topic": "topics",
        "pubsub_subscription": "subscriptions",
        "cloud_scheduler_job": "jobs",
    }[kind]
    name = (
        "projects/proj-x/"
        + ("locations/us-central1/" if kind == "cloud_scheduler_job" else "")
        + segment
        + "/mail-one"
    )
    identity = {"name": name}
    if kind == "pubsub_subscription":
        identity["topic"] = "projects/proj-x/topics/mail-one"
    if kind == "cloud_scheduler_job":
        identity.update(
            pubsubTarget={"topicName": "projects/proj-x/topics/mail-one"},
            schedule="0 4 * * *",
            timeZone="Etc/UTC",
        )
    observation = {"type": kind, "id": "mail-one", "disposition": "created", "identity": identity}
    base = {"resourceObservation": observation}
    state = {}
    if case in {"resume", "uncertain"}:
        state["admission"] = {**base, "status": "admitted"}
    if case == "resume":
        state["acknowledgement"] = {**base, "status": "acknowledged"}
    session = _Session()
    reads = iter([_Resp(404)] if case == "resume" else [_Resp(200, identity), _Resp(404)])
    session.rule("GET", name, lambda *_: next(reads))
    session.rule("DELETE", name, _Resp(200))
    stages = []

    def retain(stage, receipt):
        stages.append(stage)
        assert receipt["resourceObservation"] == observation
        return not (case == "ack_refused" and stage == "acknowledgement")

    def invoke():
        reconcile_mail_resource(
            token="tok",  # noqa: S106 -- scripted provider
            project="proj-x",
            region="us-central1",
            observation=observation,
            state=state,
            retain_receipt=retain,
            session=session,
        )

    if case in {"uncertain", "ack_refused"}:
        with pytest.raises(SubstrateDeleteError):
            invoke()
        if case == "ack_refused":
            before = len(session.calls)
            with pytest.raises(SubstrateDeleteError, match="acknowledgement unresolved"):
                invoke()
            assert len(session.calls) == before
    else:
        invoke()
        assert stages == (
            ["deletion"] if case == "resume" else ["admission", "acknowledgement", "deletion"]
        )
    assert sum(method == "DELETE" for method, _, _ in session.calls) == (
        case in {"deleted", "ack_refused"}
    )
    assert all(kwargs["allow_redirects"] is False for _, _, kwargs in session.calls)
