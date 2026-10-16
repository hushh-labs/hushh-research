"""Exact owner-resource cleanup, retained uncertainty and independent absence."""

from __future__ import annotations

import copy
import json
import uuid

import pytest

from hushh_mcp.services.azure_arm_mutations import ArmMutationAcknowledgement, ArmMutationRequest
from hushh_mcp.services.azure_resource_teardown import execute, preflight
from hushh_mcp.services.azure_setup_plan import NONCE_TAG, PlanInputs, Scopes, resource_names
from hushh_mcp.services.azure_teardown_inventory import AzureTeardownRefused, inventory
from hushh_mcp.services.azure_teardown_receipts import prepare_stage
from tests.azure_arm_fake import POD_PRINCIPAL, FakeArm
from tests.test_owner_access_erasure import _hub_caller as _hub_caller
from tests.test_owner_access_erasure import arm as arm
from tests.test_user_azure_backend import _HUSHH_ID, _SUB, _TENANT, _backend


class _Journal:
    def __init__(self):
        self.receipts = {}
        self.admitted = True
        self.contents_exclusive = True
        self.readbacks = []

    def assert_admitted(self):
        if not self.admitted:
            raise PermissionError("cleanup authority withdrawn")

    def state(self, resource):
        return self.receipts.get(resource.path)

    def assert_parent_approved(self, resource):
        if not self.contents_exclusive:
            raise PermissionError("parent contents unqualified")

    def assert_group_approved(self):
        self.assert_admitted()

    def retain(self, resource, stage, receipt):
        self.receipts[resource.path] = prepare_stage(
            self.receipts.get(resource.path, {}), stage, receipt
        )
        return True

    def retain_final_readback(self, resource_ids):
        self.readbacks.append(resource_ids)
        return True


class _CleanupArm(FakeArm):
    """Azure's parent cascade, expressed explicitly; never a cloud acceptance claim."""

    def __init__(self, source):
        self.__dict__.update(source.__dict__)
        self.before_write = lambda: None
        self.fail_path = None
        self.fail_after_delete = False
        self.recreate_path = None
        self.mutations = None
        self.known_absence_path = None

    def with_write_guard(self, guard):
        fenced = copy.copy(self)
        fenced.before_write = guard
        return fenced

    def get(self, path, **kwargs):
        if path.endswith("/resources"):
            group = path.removesuffix("/resources")
            return {"value": [v for k, v in self.resources.items() if k.startswith(group + "/")]}
        if path.endswith("/deployments"):
            return {"value": [v for k, v in self.resources.items() if k.startswith(path + "/")]}
        return super().get(path, **kwargs)

    def with_mutations(self, journal):
        recorded = copy.copy(self)
        recorded.mutations = journal
        return recorded

    def delete(self, path, **kwargs):
        self.before_write()
        request_id = str(uuid.uuid4())
        assert self.mutations.admit(
            request_id, ArmMutationRequest("DELETE", path, kwargs["api_version"], kwargs["op"])
        )
        if path == self.known_absence_path:
            self.calls.append(("DELETE", path, None))
            self.resources.pop(path, None)
            assert self.mutations.acknowledge(
                request_id, ArmMutationAcknowledgement(404, None, None)
            )
            assert self.mutations.terminal(request_id, "refused")
            return False
        if path == self.fail_path and not self.fail_after_delete:
            self.calls.append(("DELETE", path, None))
            raise TimeoutError("synthetic lost response")
        result = super().delete(path, **kwargs)
        for child in list(self.resources):
            if child.startswith(path + "/"):
                del self.resources[child]
        if path == self.fail_path:
            raise TimeoutError("synthetic lost response")
        assert self.mutations.acknowledge(request_id, ArmMutationAcknowledgement(200, None, None))
        assert self.mutations.terminal(request_id, "succeeded")
        if path == self.recreate_path:
            self.resources[path] = {"id": path, "tags": {"foreign": "replacement"}}
        return result


def _prepared(arm):
    backend = _backend(arm)
    app = arm.resources[backend.app_id]
    from hushh_mcp.services.azure_container_app_renderer import INCARNATION_TAG

    inputs = PlanInputs(_HUSHH_ID, _TENANT, _SUB, "eastus2", backend._group, app["tags"][NONCE_TAG])
    resources = inventory(
        inputs,
        pod_principal=POD_PRINCIPAL,
        hub_principal="88888888-8888-8888-8888-888888888888",
        pod_incarnation=app["tags"][INCARNATION_TAG],
    )
    return _CleanupArm(arm), inputs, resources, _Journal()


def test_owner_cloud_cleanup_reaches_independent_active_absence(arm):
    client, inputs, resources, journal = _prepared(arm)
    frozen = preflight(client, inputs, resources, journal)
    execute(client, inputs, resources, journal, frozen)
    assert client.resources == {}
    direct = [r for r in resources if r.covered_by is None]
    assert all(journal.state(r)["absence"]["status"] == "active_resource_absent" for r in direct)
    assert journal.readbacks == [tuple(r.path for r in direct)]
    writes = [path for method, path, _ in client.calls if method == "DELETE"]
    assert len(writes) == len(set(writes))
    execute(client, inputs, resources, journal, frozen)
    assert [p for m, p, _ in client.calls if m == "DELETE"] == writes


@pytest.mark.parametrize("failure", ["reappeared", "receipt"])
def test_final_readback_failure_never_reports_cleanup_complete(arm, monkeypatch, failure):
    client, inputs, resources, journal = _prepared(arm)
    frozen = preflight(client, inputs, resources, journal)
    original = client.get_or_none

    def observe(path, **kwargs):
        if failure == "reappeared" and kwargs.get("op") == "cleanup_final":
            return {"id": path}
        return original(path, **kwargs)

    monkeypatch.setattr(client, "get_or_none", observe)
    if failure == "receipt":
        monkeypatch.setattr(journal, "retain_final_readback", lambda _: False)
    with pytest.raises(AzureTeardownRefused, match="REAPPEARED|READBACK_UNCONFIRMED"):
        execute(client, inputs, resources, journal, frozen)
    assert journal.readbacks == []


@pytest.mark.parametrize(
    "change", ["unrelated", "unrelated_deployment", "owner", "incarnation", "role", "malformed"]
)
def test_unrelated_or_changed_resources_refuse_before_first_delete(arm, change):
    client, inputs, resources, journal = _prepared(arm)
    scopes = Scopes(inputs, resource_names(inputs))
    if change == "unrelated":
        path = scopes.group + "/providers/Microsoft.Storage/storageAccounts/unrelated"
        client.resources[path] = {"id": path}
    elif change == "unrelated_deployment":
        path = scopes.openai + "/deployments/unrelated"
        client.resources[path] = {"id": path}
    elif change == "owner":
        client.resources[scopes.storage]["tags"][NONCE_TAG] = "f" * 16
    elif change == "incarnation":
        from hushh_mcp.services.azure_container_app_renderer import INCARNATION_TAG

        client.resources[scopes.app]["tags"][INCARNATION_TAG] = "replacement"
    elif change == "malformed":
        client.resources[scopes.app]["systemData"] = ["invalid"]
    else:
        role = next(r for r in resources if r.kind == "role_assignment")
        client.resources[role.path]["properties"]["principalId"] = "wrong-owner"
    with pytest.raises(AzureTeardownRefused):
        preflight(client, inputs, resources, journal)
    assert not any(m == "DELETE" for m, _, _ in client.calls)


@pytest.mark.parametrize("after_delete", [False, True])
def test_lost_delete_response_is_observed_without_replaying_it(arm, after_delete):
    client, inputs, resources, journal = _prepared(arm)
    frozen = preflight(client, inputs, resources, journal)
    target = next(r for r in resources if not r.covered_by and frozen[r.path] is not None)
    client.fail_path, client.fail_after_delete = target.path, after_delete
    with pytest.raises(TimeoutError):
        execute(client, inputs, resources, journal, frozen)
    assert journal.state(target).get("acknowledgement") is None
    with pytest.raises(AzureTeardownRefused, match="OUTCOME_UNCERTAIN"):
        execute(client, inputs, resources, journal, frozen)
    assert len([p for m, p, _ in client.calls if m == "DELETE" and p == target.path]) == 1


def test_unknown_parent_contents_refuse_before_first_delete(arm):
    client, inputs, resources, journal = _prepared(arm)
    journal.contents_exclusive = False
    with pytest.raises(PermissionError, match="contents unqualified"):
        preflight(client, inputs, resources, journal)
    assert not any(m == "DELETE" for m, _, _ in client.calls)


def test_replacement_under_allowed_name_is_not_deleted_by_group_cascade(arm):
    client, inputs, resources, journal = _prepared(arm)
    frozen = preflight(client, inputs, resources, journal)
    scopes = Scopes(inputs, resource_names(inputs))
    client.recreate_path = scopes.storage
    with pytest.raises(AzureTeardownRefused, match="ABSENCE_UNCONFIRMED|UNRELATED_RESOURCES"):
        execute(client, inputs, resources, journal, frozen)
    assert not any(m == "DELETE" and p == scopes.group for m, p, _ in client.calls)


def test_real_arm_cleanup_keeps_guard_and_does_not_retry_uncertain_mutation(arm):
    from hushh_mcp.services.azure_arm_client import ArmClient, ArmError
    from hushh_mcp.services.azure_teardown_receipts import TeardownMutationJournal
    from tests.test_azure_arm_client import _Response, _Session

    _, _, resources, journal = _prepared(arm)
    target = next(r for r in resources if not r.covered_by)
    session = _Session(_Response(503, {"error": {"code": "ServiceUnavailable"}}), _Response(200))
    guarded = ArmClient("synthetic-token", session=session, sleep=lambda _: None).with_write_guard(
        journal.assert_admitted
    )
    recorded = guarded.with_mutations(TeardownMutationJournal(journal, target))
    with pytest.raises(ArmError):
        recorded.delete(target.path, api_version=target.api_version)
    assert len(session.sent) == 1
    assert journal.state(target)["provider_ack"]["status"] == 503
    assert "provider_terminal" not in journal.state(target)


@pytest.mark.parametrize(
    "change",
    [
        None,
        "apiVersion",
        "kind",
        "expected",
        "coveredBy",
        "deletionScope",
        "missing",
        "wrong_principal",
        "wrong_incarnation",
    ],
)
def test_preview_is_read_only_and_restored_inventory_keeps_dependency_order(arm, change):
    from hushh_mcp.services.azure_container_app_renderer import INCARNATION_TAG
    from hushh_mcp.services.azure_teardown_observation import execution_inventory, inspect_plan
    from tests.test_owner_access_erasure import OWNER, _snapshot

    client, inputs, resources, _ = _prepared(arm)
    snapshot = _snapshot(client)
    context = {
        "ownerId": OWNER,
        "attemptId": "attempt-preview",
        "hushhId": inputs.hushh_id,
        "tenantId": inputs.tenant_id,
        "subscriptionId": inputs.subscription_id,
        "resourceGroup": inputs.resource_group,
        "location": inputs.location,
        "setupNonce": inputs.nonce,
    }
    plan = inspect_plan(
        client,
        context=context,
        reservation={
            "ownerId": OWNER,
            "attemptId": "attempt-preview",
            "registrySnapshot": snapshot,
        },
        hub_principal="88888888-8888-8888-8888-888888888888",
    )
    assert not any(method != "GET" for method, _, _ in client.calls)
    recovered = json.loads(json.dumps(plan, sort_keys=True))
    target = next(
        path for path in recovered["resources"] if path.endswith("/containerApps/ca-hussh-one-pod")
    )
    if change == "missing":
        recovered["resources"].pop(target)
    elif change in {"apiVersion", "kind", "expected", "coveredBy", "deletionScope"}:
        recovered["resources"][target][change] = {} if change == "expected" else "changed"

    def restore():
        return execution_inventory(
            recovered,
            pod_principal="00000000-0000-0000-0000-000000000001"
            if change == "wrong_principal"
            else POD_PRINCIPAL,
            hub_principal="88888888-8888-8888-8888-888888888888",
            pod_incarnation="wrong"
            if change == "wrong_incarnation"
            else next(r.expected.get(INCARNATION_TAG) for r in resources if r.path == target),
        )

    if change is not None:
        with pytest.raises(AzureTeardownRefused, match="INVENTORY_CHANGED"):
            restore()
        return
    restored_inputs, restored, frozen = restore()
    assert restored_inputs.nonce == inputs.nonce
    assert next(r for r in restored if r.kind == "resource").path.endswith(
        "/containerApps/ca-hussh-one-pod"
    )
    assert restored[-1].path.endswith("/resourceGroups/" + inputs.resource_group)
    assert set(frozen) == {r.path for r in restored if not r.covered_by}
    assert plan["resources"][restored[-1].path]["deletionScope"] == "whole_group"


@pytest.mark.parametrize("interruption", ["intent_only", "not_dispatched", "refused", "not_found"])
def test_definitely_undispatched_or_refused_request_can_resume_once(arm, interruption):
    client, inputs, resources, journal = _prepared(arm)
    frozen = preflight(client, inputs, resources, journal)
    target = next(r for r in resources if not r.covered_by)
    journal.retain(target, "intent", {"identity": frozen[target.path]})
    if interruption == "not_found":
        client.known_absence_path = target.path
    elif interruption != "intent_only":
        request_id = str(uuid.uuid4())
        journal.retain(
            target,
            "provider_request",
            {
                "requestId": request_id,
                "method": "DELETE",
                "path": target.path,
                "apiVersion": target.api_version,
            },
        )
        if interruption == "refused":
            journal.retain(
                target,
                "provider_ack",
                {
                    "requestId": request_id,
                    "status": 401,
                    "operationUrl": None,
                    "operationUrlSha256": None,
                },
            )
        journal.retain(
            target,
            "provider_terminal",
            {
                "requestId": request_id,
                "outcome": "refused" if interruption == "refused" else "not_dispatched",
            },
        )
    execute(client, inputs, resources, journal, frozen)
    assert client.resources == {}
    assert len([p for m, p, _ in client.calls if m == "DELETE" and p == target.path]) == 1
    assert journal.state(target)["absence"]["status"] == "active_resource_absent"
    if interruption in {"not_dispatched", "refused"}:
        assert len(journal.state(target)["providerHistory"]) == 1


@pytest.mark.parametrize("kind", ["azure-asyncoperation", "location"])
@pytest.mark.parametrize("target_kind", ["app", "model_child_parent_gone"])
def test_interrupted_delete_polls_original_typed_operation_without_redispatch(
    arm, kind, target_kind
):
    import hashlib

    from hushh_mcp.services.azure_arm_client import ArmClient
    from hushh_mcp.services.azure_teardown_reconciliation import reconcile_delete
    from tests.test_azure_arm_client import _Response, _Session

    cleanup, inputs, resources, journal = _prepared(arm)
    frozen = preflight(cleanup, inputs, resources, journal)
    scopes = Scopes(inputs, resource_names(inputs))
    path = scopes.app if target_kind == "app" else scopes.deployment
    target = next(r for r in resources if r.path == path)
    request_id = str(uuid.uuid4())
    subscription = target.path.split("/")[2]
    url = f"https://management.azure.com/subscriptions/{subscription}/operations/one?api-version=2025-01-01"
    journal.retain(
        target,
        "provider_request",
        {
            "requestId": request_id,
            "method": "DELETE",
            "path": target.path,
            "apiVersion": target.api_version,
        },
    )
    journal.retain(
        target,
        "provider_ack",
        {
            "requestId": request_id,
            "status": 202,
            "operationUrl": url,
            "operationUrlSha256": hashlib.sha256(url.encode()).hexdigest(),
            "operationKind": kind,
        },
    )
    body = {"status": "Succeeded"} if kind == "azure-asyncoperation" else {}
    session = _Session(_Response(200, body))
    client = ArmClient("synthetic-token", session=session, sleep=lambda _: None)
    settled = reconcile_delete(client, target, journal)
    assert settled["provider_terminal"] == {"requestId": request_id, "outcome": "succeeded"}
    assert settled["acknowledgement"]["status"] == "provider_completed"
    assert [call["method"] for call in session.sent] == ["GET"]
    assert session.sent[0]["url"] == url
    if target_kind == "model_child_parent_gone":
        for path in list(cleanup.resources):
            if path == scopes.openai or path.startswith(scopes.openai + "/"):
                del cleanup.resources[path]
        execute(cleanup, inputs, resources, journal, frozen)
        assert journal.state(target)["absence"]["status"] == "active_resource_absent"
        assert not any(
            method == "DELETE" and path == scopes.deployment for method, path, _ in cleanup.calls
        )


@pytest.mark.parametrize(
    "change",
    [
        "legacy_kind",
        "tampered",
        "foreign",
        "unacknowledged",
        "failed_read",
        "dot_segment",
        "encoded_dot_segment",
    ],
)
def test_unqualified_delete_observation_stays_unresolved_without_replay(arm, change):
    import hashlib

    from hushh_mcp.services.azure_arm_client import ArmClient, ArmError
    from hushh_mcp.services.azure_teardown_reconciliation import reconcile_delete
    from tests.test_azure_arm_client import _Response, _Session

    _, _, resources, journal = _prepared(arm)
    target = next(r for r in resources if not r.covered_by)
    request_id = str(uuid.uuid4())
    subscription = target.path.split("/")[2] if change != "foreign" else "another-subscription"
    url = f"https://management.azure.com/subscriptions/{subscription}/operations/one?api-version=2025-01-01"
    if change == "dot_segment":
        url = url.replace("/operations/", "/../another-subscription/operations/")
    elif change == "encoded_dot_segment":
        url = url.replace("/operations/", "/%2e%2e/another-subscription/operations/")
    journal.retain(
        target,
        "provider_request",
        {
            "requestId": request_id,
            "method": "DELETE",
            "path": target.path,
            "apiVersion": target.api_version,
        },
    )
    ack = {
        "requestId": request_id,
        "status": 202,
        "operationUrl": url,
        "operationUrlSha256": hashlib.sha256(url.encode()).hexdigest(),
        "operationKind": "azure-asyncoperation",
    }
    if change == "legacy_kind":
        ack.pop("operationKind")
    if change == "tampered":
        ack["operationUrlSha256"] = "0" * 64
    if change != "unacknowledged":
        journal.retain(target, "provider_ack", ack)
    session = _Session(_Response(503, {}))
    client = ArmClient("synthetic-token", session=session, sleep=lambda _: None)
    with pytest.raises((AzureTeardownRefused, ArmError)):
        reconcile_delete(client, target, journal)
    assert "provider_terminal" not in journal.state(target)
    assert [call["method"] for call in session.sent] == (["GET"] if change == "failed_read" else [])


@pytest.mark.parametrize("kind", ["key_vault", "storage", "model_account"])
@pytest.mark.parametrize("case", ["retained", "absent", "foreign", "malformed_time"])
def test_retention_readback_never_claims_purge_or_retains_recovery_secrets(arm, kind, case):
    from types import SimpleNamespace

    from hushh_mcp.services.azure_teardown_retention import observe_retention, retention_target

    _, inputs, resources, _ = _prepared(arm)
    scopes = Scopes(inputs, resource_names(inputs))
    path = {"key_vault": scopes.vault, "storage": scopes.storage, "model_account": scopes.openai}[
        kind
    ]
    resource = next(r for r in resources if r.path == path)
    deleted_path, api, _ = retention_target(resource, inputs)
    from tests.fixtures.azure_teardown import CREATED, retention_body

    body = retention_body(inputs, path, deleted_path)
    properties = body["properties"]
    if case == "foreign":
        properties.update(vaultId="foreign", storageAccountResourceId="foreign")
        body["id"] = "foreign"
    if case == "malformed_time":
        properties.update(deletionTime="invalid", deletionDate="invalid")
    calls = []

    def read(actual, **kwargs):
        calls.append((actual, kwargs))
        return None if case == "absent" else body

    if case in {"foreign", "malformed_time"}:
        with pytest.raises(AzureTeardownRefused, match="RETENTION_.*UNVERIFIED"):
            observe_retention(
                SimpleNamespace(get_or_none=read), inputs, resource, {"createdAt": CREATED}
            )
        return
    receipt = observe_retention(
        SimpleNamespace(get_or_none=read), inputs, resource, {"createdAt": CREATED}
    )
    assert receipt["physicalPurgeVerified"] is False
    assert receipt["status"] == (
        "provider_record_absent" if case == "absent" else "provider_retained"
    )
    assert "synthetic-private" not in json.dumps(receipt) and "restoreReference" not in receipt
    assert calls == [(deleted_path, {"api_version": api, "op": "cleanup_retention"})]
    if kind == "storage":
        assert "scheduledPurgeDate" not in receipt
