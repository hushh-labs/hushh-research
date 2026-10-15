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
    writes = [path for method, path, _ in client.calls if method == "DELETE"]
    assert len(writes) == len(set(writes))
    execute(client, inputs, resources, journal, frozen)
    assert [p for m, p, _ in client.calls if m == "DELETE"] == writes


@pytest.mark.parametrize("change", ["unrelated", "owner", "incarnation", "role", "malformed"])
def test_unrelated_or_changed_resources_refuse_before_first_delete(arm, change):
    client, inputs, resources, journal = _prepared(arm)
    scopes = Scopes(inputs, resource_names(inputs))
    if change == "unrelated":
        path = scopes.group + "/providers/Microsoft.Storage/storageAccounts/unrelated"
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


def test_preview_is_read_only_and_restored_inventory_keeps_dependency_order(arm):
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
    restored_inputs, restored, frozen = execution_inventory(
        json.loads(json.dumps(plan, sort_keys=True))
    )
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
