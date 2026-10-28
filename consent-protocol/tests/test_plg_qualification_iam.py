"""Inert-port checks for the scoped, read-only allow-binding producer."""

from __future__ import annotations

import copy
import importlib
import time
from pathlib import Path
from urllib.error import HTTPError

import pytest

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def iam(monkeypatch):
    monkeypatch.syspath_prepend(str(ROOT / "deploy/plg"))
    return importlib.import_module("qualification_iam")


class FakeCloud:
    project_number = "123456"

    def __init__(self, iam, target):
        self.iam, self.target = iam, target
        self.member = "serviceAccount:" + target.runtime_sa
        self.chain = ["projects/123456", "folders/456", "organizations/789"]
        self.policies = {x: {"version": 3, "bindings": []} for x in self.chain}
        self.policies[self.chain[0]]["bindings"].append(
            {"role": "roles/cloudsql.client", "members": [self.member]}
        )
        self.service_doc = {
            "name": f"projects/{target.project}/locations/us-central1/services/{iam.SERVICE}",
            "invokerIamDisabled": False,
            "labels": target.labels,
            "template": {"serviceAccount": target.runtime_sa},
        }
        self.service_iam = {"version": 3, "bindings": []}
        self.account = {
            "email": target.runtime_sa,
            "projectId": target.project,
            "displayName": "PLG isolated qualification runtime",
            "disabled": False,
        }
        self.secret_names = [iam.PREFIX + x for x in (*iam.RUNTIME_SECRETS, "MIGRATOR_DB_PASSWORD")]
        self.secret_rows = [
            {"name": f"projects/123456/secrets/{name}", "labels": target.labels}
            for name in self.secret_names
        ]
        self.secret_iam = {name: {"version": 3, "bindings": []} for name in self.secret_names}
        for name in self.secret_names[:5]:
            self.secret_iam[name]["bindings"].append(
                {"role": "roles/secretmanager.secretAccessor", "members": [self.member]}
            )
        self.reads = []
        self.versions = {name: "3" for name in self.secret_names}
        self.role_permissions = {
            "roles/run.invoker": [iam.INVOKE],
            "roles/viewer": ["run.services.get"],
            "roles/secretmanager.secretAccessor": [iam.SECRET_ACCESS],
        }

    def identity(self):
        return copy.deepcopy(self.account)

    def service(self):
        return copy.deepcopy(self.service_doc)

    def service_policy(self):
        return copy.deepcopy(self.service_iam)

    def ancestry(self):
        return list(self.chain)

    def hierarchy_policy(self, name):
        self.reads.append(("policy", name))
        return copy.deepcopy(self.policies[name])

    def secrets(self):
        return copy.deepcopy(self.secret_rows)

    def secret_policy(self, name):
        self.reads.append(("secret_policy", name))
        return copy.deepcopy(self.secret_iam[name])

    def latest(self, name):
        self.reads.append(("latest", name))
        return {
            "name": f"projects/123456/secrets/{name}/versions/{self.versions[name]}",
            "state": "ENABLED",
        }

    def role(self, role):
        self.reads.append(("role", role))
        return {"name": role, "includedPermissions": self.role_permissions[role]}


@pytest.fixture
def cloud(iam):
    return FakeCloud(iam, iam.Target("dev"))


def test_allow_evidence_is_scoped_and_versions_rechecked(iam, cloud):
    proof = iam.verify(cloud.target, cloud=cloud)
    assert proof["iamEvidenceKind"] == "allow-policy-bindings"
    assert proof["serviceExists"] is True
    assert proof["authorityScope"] == "target-project-and-ancestors"
    assert proof["runtimeSecretsOnly"] is True and proof["migratorSecretAccess"] is False
    assert proof["ancestorPoliciesComplete"] is True and proof["publicInvokerBindings"] == []
    assert set(proof["runtimeSecretVersions"]) == {iam.PREFIX + x for x in iam.RUNTIME_SECRETS}
    assert all(v == "3" for v in proof["runtimeSecretVersions"].values())
    assert len([x for x in cloud.reads if x[0] == "latest"]) == 10
    assert len([x for x in cloud.reads if x[0] == "policy"]) == 6
    assert len([x for x in cloud.reads if x[0] == "secret_policy"]) == 12


def test_predeploy_only_allows_missing_service_without_fabricating_privacy(iam, cloud):
    cloud.service_doc = None
    pre = iam.verify(cloud.target, require_service=False, cloud=cloud)
    assert pre["serviceExists"] is False
    assert pre["invokerIamDisabled"] is None and pre["publicInvokerBindings"] is None
    with pytest.raises(ValueError, match="iam_service_missing"):
        iam.verify(cloud.target, cloud=cloud)


def test_predeploy_existing_service_still_must_be_private(iam, cloud):
    cloud.service_iam["bindings"].append({"role": "roles/run.invoker", "members": ["allUsers"]})
    with pytest.raises(ValueError, match="iam_public_binding_forbidden"):
        iam.verify(cloud.target, require_service=False, cloud=cloud)


def test_direct_custom_runtime_role_is_resolved_and_refused(iam, cloud):
    name = "projects/hushh-pda-dev/roles/extra"
    cloud.role_permissions[name] = ["secretmanager.versions.access"]
    cloud.policies[cloud.chain[0]]["bindings"].append({"role": name, "members": [cloud.member]})
    with pytest.raises(ValueError, match="iam_additional_runtime_binding"):
        iam.verify(cloud.target, cloud=cloud)
    assert ("role", name) in cloud.reads


@pytest.mark.parametrize(
    "change",
    [
        "disabled_sa",
        "wrong_sa",
        "public_service",
        "missing_client",
        "ancestor_extra",
        "conditional_client",
        "migrator_binding",
        "missing_expected",
        "conditional_secret",
        "extra_secret",
        "principal_set",
    ],
)
def test_unsafe_or_incomplete_bindings_refused(iam, cloud, change):
    if change == "disabled_sa":
        cloud.account["disabled"] = True
    elif change == "wrong_sa":
        cloud.account["projectId"] = "other"
    elif change == "public_service":
        cloud.service_doc["invokerIamDisabled"] = True
    elif change == "missing_client":
        cloud.policies[cloud.chain[0]]["bindings"].clear()
    elif change == "ancestor_extra":
        cloud.policies[cloud.chain[1]]["bindings"].append(
            {"role": "roles/owner", "members": [cloud.member]}
        )
    elif change == "conditional_client":
        cloud.policies[cloud.chain[0]]["bindings"][0]["condition"] = {"expression": "true"}
    elif change == "migrator_binding":
        cloud.secret_iam[cloud.secret_names[-1]]["bindings"].append(
            {"role": "roles/secretmanager.secretAccessor", "members": [cloud.member]}
        )
    elif change == "missing_expected":
        cloud.secret_rows.pop(0)
    elif change == "conditional_secret":
        cloud.secret_iam[cloud.secret_names[0]]["bindings"][0]["condition"] = {"expression": "true"}
    elif change == "extra_secret":
        cloud.secret_iam[cloud.secret_names[-1]]["bindings"].append(
            {"role": "roles/viewer", "members": [cloud.member]}
        )
    else:
        cloud.service_iam["bindings"].append(
            {"role": "roles/viewer", "members": ["principalSet://example"]}
        )
    with pytest.raises(ValueError):
        iam.verify(cloud.target, cloud=cloud)


@pytest.mark.parametrize("place", ["service", "project", "folder", "org"])
@pytest.mark.parametrize("principal", ["allUsers", "allAuthenticatedUsers"])
def test_public_invocation_at_any_scope_is_refused(iam, cloud, place, principal):
    binding = {"role": "roles/run.invoker", "members": [principal]}
    policy = (
        cloud.service_iam
        if place == "service"
        else cloud.policies[cloud.chain[["project", "folder", "org"].index(place)]]
    )
    policy["bindings"].append(binding)
    with pytest.raises(ValueError, match="iam_public_binding_forbidden"):
        iam.verify(cloud.target, cloud=cloud)


def test_public_custom_or_conditional_role_cannot_be_assumed_safe(iam, cloud):
    cloud.service_iam["bindings"] = [
        {"role": "projects/123456/roles/custom", "members": ["allUsers"]}
    ]
    with pytest.raises(ValueError, match="iam_public_custom_role_unresolved"):
        iam.verify(cloud.target, cloud=cloud)
    cloud.service_iam["bindings"] = [
        {"role": "roles/viewer", "members": ["allUsers"], "condition": {"expression": "false"}}
    ]
    with pytest.raises(ValueError, match="iam_public_condition_unresolved"):
        iam.verify(cloud.target, cloud=cloud)


def test_no_public_secret_access_even_from_ancestor(iam, cloud):
    cloud.policies[cloud.chain[-1]]["bindings"].append(
        {"role": "roles/secretmanager.secretAccessor", "members": ["allAuthenticatedUsers"]}
    )
    with pytest.raises(ValueError, match="iam_public_binding_forbidden"):
        iam.verify(cloud.target, cloud=cloud)


def test_any_public_project_grant_adds_runtime_authority(iam, cloud):
    cloud.policies[cloud.chain[0]]["bindings"].append(
        {"role": "roles/viewer", "members": ["allAuthenticatedUsers"]}
    )
    with pytest.raises(ValueError, match="iam_public_runtime_authority"):
        iam.verify(cloud.target, cloud=cloud)


def test_policy_change_during_inventory_refused(iam, cloud):
    original = cloud.hierarchy_policy
    calls = 0

    def changing(name):
        nonlocal calls
        calls += 1
        policy = original(name)
        if calls > len(cloud.chain):
            policy["etag"] = "changed"
        return policy

    cloud.hierarchy_policy = changing
    with pytest.raises(ValueError, match="iam_ancestor_policy_changed"):
        iam.verify(cloud.target, cloud=cloud)


def test_transport_refuses_secret_payload_and_write_methods(iam):
    reader = object.__new__(iam.ReadCloud)
    reader.target = iam.Target("dev")
    reader._token = "synthetic-test-only-token"
    assert reader._token not in repr(reader)
    with pytest.raises(ValueError, match="iam_path_invalid"):
        reader._read("secretmanager", "v1/projects/x/secrets/y/versions/latest:access")
    with pytest.raises(ValueError, match="iam_method_invalid"):
        reader._read("secretmanager", "v1/projects/x/secrets/y:setIamPolicy", policy_body=True)
    with pytest.raises(ValueError, match="iam_attachment_permission_path_invalid"):
        reader._read(
            "iam",
            "v1/projects/other/serviceAccounts/other:testIamPermissions",
            attachment_permission=True,
        )


def test_runtime_attachment_check_requires_the_exact_permission(iam, monkeypatch):
    reader = object.__new__(iam.ReadCloud)
    reader.target = iam.Target("dev")
    calls = []

    def observe(api, path, **kwargs):
        calls.append((api, path, kwargs))
        return {"permissions": ["iam.serviceAccounts.actAs"]}

    monkeypatch.setattr(reader, "_read", observe)
    reader.verify_runtime_attachment()
    assert calls == [
        (
            "iam",
            f"v1/projects/{reader.target.project}/serviceAccounts/{reader.target.runtime_sa}:testIamPermissions",
            {"attachment_permission": True},
        )
    ]
    monkeypatch.setattr(reader, "_read", lambda *_a, **_kw: {})
    with pytest.raises(ValueError, match="qualification_runtime_attachment_permission_missing"):
        reader.verify_runtime_attachment()


def test_only_service_404_is_tolerated_for_predeploy(iam):
    reader = object.__new__(iam.ReadCloud)
    reader.target = iam.Target("dev")
    reader._token = "synthetic-test-only-token"
    reader._deadline = time.monotonic() + 30

    class Opener:
        status = 404

        def open(self, request, timeout):
            raise HTTPError(request.full_url, self.status, "synthetic", {}, None)

    reader._opener = Opener()
    assert reader.service() is None
    reader._opener.status = 403
    with pytest.raises(ValueError, match="qualification_iam_run_http_403"):
        reader.service()
    reader._opener.status = 404
    with pytest.raises(ValueError, match="qualification_iam_iam_http_404"):
        reader.identity()


@pytest.mark.parametrize(
    "selector",
    [
        "principal://iam.googleapis.com/projects/123456/locations/global/workloadIdentityPools/github/subject/repo:org/repo:ref:refs/heads/main",
        "principalSet://iam.googleapis.com/projects/123456/locations/global/workloadIdentityPools/github/attribute.repository/org/repo",
        "principalSet://iam.googleapis.com/projects/123456/locations/global/workloadIdentityPools/github/group/developers",
        "principalSet://iam.googleapis.com/projects/123456/locations/global/workloadIdentityPools/github/*",
    ],
)
def test_external_workload_pool_is_distinct_from_runtime_and_public(iam, cloud, selector):
    cloud.policies[cloud.chain[0]]["bindings"].append(
        {"role": "roles/viewer", "members": [selector]}
    )
    assert iam.verify(cloud.target, cloud=cloud)["iamEvidenceKind"] == "allow-policy-bindings"


def test_documented_agent_project_set_is_distinct_from_runtime_and_public(iam, cloud):
    selector = (
        "principalSet://agents.global.org-123456.system.id.goog/"
        "attribute.platformContainer/aiplatform/projects/654321"
    )
    cloud.policies[cloud.chain[0]]["bindings"].append(
        {"role": "roles/viewer", "members": [selector]}
    )
    assert iam.verify(cloud.target, cloud=cloud)["iamEvidenceKind"] == "allow-policy-bindings"


@pytest.mark.parametrize(
    "selector",
    [
        "principalSet://cloudresourcemanager.googleapis.com/projects/123456/type/ServiceAccount",
        "principalSet://goog/public:all",
        "principalSet://iam.googleapis.com/projects/123456/locations/global/workloadIdentityPools/github/attribute.repository/",
        "principal://iam.googleapis.com/projects/123456/locations/global/workloadIdentityPools/github/subject/name?spoof=1",
        "principalSet://evil.example/projects/123456/locations/global/workloadIdentityPools/github/*",
        "principalSet://iam.googleapis.com/locations/global/workforcePools/github/*",
        "principal://iam.googleapis.com/projects/123456/serviceAccounts/runtime",
        "principalSet://agents.global.org-123456.system.id.goog/*",
        "principalSet://agents.global.org-123456.system.id.goog/attribute.platformContainer/aiplatform/projects/0",
        "principalSet://agents.global.org-123456.system.id.goog.evil/attribute.platformContainer/aiplatform/projects/654321",
        "principalSet://agents.global.org-123456.system.id.goog/attribute.platformContainer/aiplatform/projects/654321/extra",
    ],
)
def test_unknown_or_service_account_principal_sets_still_fail_closed(iam, cloud, selector):
    cloud.policies[cloud.chain[0]]["bindings"].append(
        {"role": "roles/viewer", "members": [selector]}
    )
    with pytest.raises(ValueError, match="iam_principal_set_unresolved"):
        iam.verify(cloud.target, cloud=cloud)


def test_request_timeout_and_collector_deadline_remain_distinct(iam):
    reader = object.__new__(iam.ReadCloud)
    reader.target = iam.Target("dev")
    reader._token = "synthetic-test-only-token"
    reader._deadline = time.monotonic() - 1
    with pytest.raises(
        iam.QualificationError, match="iam_collection_deadline_exceeded"
    ) as deadline:
        reader.identity()
    assert iam._refusal(deadline.value) == "iam_collection_deadline_exceeded"

    class TimedOut:
        def open(self, request, timeout):
            raise TimeoutError("sensitive error details must never be included")

    reader._opener = TimedOut()
    reader._deadline = time.monotonic() + 30
    with pytest.raises(iam.QualificationError, match="iam_metadata_request_timeout") as timeout:
        reader.identity()
    assert iam._refusal(timeout.value) == "iam_metadata_request_timeout"
    assert (
        iam._refusal(ValueError("credential or untrusted content"))
        == "qualification_iam_evidence_unavailable"
    )


def test_version_change_and_disabled_version_refused(iam, cloud):
    old = cloud.latest
    count = 0

    def changing(name):
        nonlocal count
        count += 1
        item = old(name)
        if count == 6:
            item["name"] = item["name"].rsplit("/", 1)[0] + "/4"
        return item

    cloud.latest = changing
    with pytest.raises(ValueError, match="iam_secret_version_changed"):
        iam.verify(cloud.target, cloud=cloud)
    cloud.latest = lambda name: {**old(name), "state": "DISABLED"}
    with pytest.raises(ValueError, match="iam_secret_version_invalid"):
        iam.verify(cloud.target, cloud=cloud)


def test_real_reader_paginates_and_refuses_repeated_cursor(iam):
    reader = object.__new__(iam.ReadCloud)
    reader.target = iam.Target("dev")
    calls = []

    def read(_api, _path, **kw):
        calls.append(kw["query"])
        return (
            {"secrets": [{"name": "first"}], "nextPageToken": "a"}
            if len(calls) == 1
            else {"secrets": [{"name": "second"}]}
        )

    reader._read = read
    assert [x["name"] for x in reader.secrets()] == ["first", "second"]
    reader._read = lambda *_a, **_kw: {"nextPageToken": "a"}
    with pytest.raises(ValueError, match="iam_secret_pagination_invalid"):
        reader.secrets()


def test_real_reader_checks_complete_hierarchy_and_cycles(iam):
    reader = object.__new__(iam.ReadCloud)
    reader.target = iam.Target("dev")
    reader.project_number = "123456"
    values = {
        "v3/projects/hushh-pda-dev": {
            "projectId": "hushh-pda-dev",
            "name": "projects/123456",
            "parent": "folders/456",
        },
        "v3/folders/456": {"name": "folders/456", "parent": "organizations/789"},
        "v3/organizations/789": {"name": "organizations/789"},
    }
    reader._read = lambda _api, path, **_kw: values[path]
    assert reader.ancestry() == ["projects/123456", "folders/456", "organizations/789"]
    values["v3/folders/456"]["parent"] = "folders/456"
    with pytest.raises(ValueError, match="iam_ancestry_invalid"):
        reader.ancestry()
