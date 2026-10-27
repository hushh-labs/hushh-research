"""Real SQL admission and deterministic provider transport for preparation aborts."""

from copy import deepcopy
from types import SimpleNamespace

import pytest

from hushh_mcp.services.hosted_preparation_cleanup import (
    cleanup_managed_preparation,
)
from hushh_mcp.services.hosted_preparation_inventory import CORE_FIELDS
from hushh_mcp.services.provision_attempt import ProvisionReconciliationRequired
from tests.fixtures.hosted_prefix_abort import project_wide_memory_absence


class PreparationNative:
    def __init__(self, pg, coordinates, case):
        self.pg, self.coordinates, self.case = pg, coordinates, case
        self.identity = deepcopy(coordinates["projectIdentity"])
        self.billing = {
            "projectId": coordinates["project"],
            "billingAccountName": "billingAccounts/000000-000000-000000",
            "billingEnabled": True,
        }
        self.calls, self.mutations = [], []
        self.inventory_calls = 0
        self.project_reads = 0
        self.before_mutation = lambda: None

    @staticmethod
    def response(body, code=200):
        return SimpleNamespace(status_code=code, content=b"{}", json=lambda: deepcopy(body))

    def request(self, method, url, **options):
        assert options["allow_redirects"] is False
        assert 0 < options["timeout"] <= 20
        self.calls.append((method, url))
        if method == "GET" and "/serviceAccounts/" in url:
            code = 200 if self.case == "bootstrap_present" else 404
            return self.response({}, code)
        if method == "POST" and url.endswith(":getIamPolicy"):
            code = 403 if self.case == "denied_iam" else 200
            bindings = []
            if self.case == "iam_present":
                bindings = [
                    {
                        "role": "roles/owner",
                        "members": [
                            "deleted:serviceAccount:" + self.coordinates["bootstrap"] + "?uid=123"
                        ],
                    }
                ]
            return self.response({"etag": "synthetic", "bindings": bindings}, code)
        if method == "GET" and url.endswith("/billingInfo"):
            return self.response(self.billing)
        if method == "GET" and "cloudresourcemanager" in url:
            self.project_reads += 1
            # The final pre-mutation read precedes a changed owner readback.
            if self.case == "authority_changed" and self.project_reads == 3:
                self.before_mutation()
            value = deepcopy(self.identity)
            if self.case == "foreign_project":
                value["projectNumber"] = "999999999999"
            return self.response(value)
        if method == "PUT" and url.endswith("/billingInfo"):
            self.mutations.append(method)
            self.billing.update(billingAccountName="", billingEnabled=False)
            return self.response(self.billing)
        if method == "DELETE" and "cloudresourcemanager" in url:
            self.mutations.append(method)
            self.identity["lifecycleState"] = "DELETE_REQUESTED"
            if self.case == "lost_ack":
                self.case = "recovery"
                raise TimeoutError("Synthetic lost project retirement acknowledgement")
            return self.response({})
        raise AssertionError(f"Unexpected native request: {method} {url}")

    def inventory(self, reader, creation, region):
        self.inventory_calls += 1
        with pytest.raises(ProvisionReconciliationRequired, match="cannot mutate"):
            reader._session.request("DELETE", "https://cloudresourcemanager.googleapis.com/")
        result = {
            "resourceInventory": {key: [] for key in CORE_FIELDS},
            "noMemory": project_wide_memory_absence(reader.number, region),
        }
        if self.case == "incomplete_memory":
            result["noMemory"]["coverage"] = []
        return result


async def verify_preparation_operator(pg, client, reservation, coordinates, case):
    class Registry:
        changed = False

        async def get(self, owner):
            row = pg.execute(
                "SELECT to_jsonb(r) FROM personal_agent_registry r WHERE user_id=%s", (owner,)
            )[0][0]
            if self.changed:
                row["backend_metadata"]["erasure"]["ownerId"] = "foreign-owner"
            return row

        def _db(self):
            return client

    registry = Registry()
    native = PreparationNative(pg, coordinates, case)
    native.before_mutation = lambda: setattr(registry, "changed", True)

    async def run():
        await cleanup_managed_preparation(
            registry,
            user_id="owner-a",
            actor=coordinates["operatorPrincipal"],
            token="synthetic-operator-token",  # noqa: S106 - deterministic fake transport only
            session=native,
            inventory=native.inventory,
        )

    if case == "lost_ack":
        with pytest.raises(TimeoutError, match="lost project"):
            await run()
        saved = (await registry.get("owner-a"))["backend_metadata"]["erasure"]
        assert "admission" in saved["managedPreparationCleanup"]
        assert "deletion" not in saved["managedPreparationCleanup"]
        await run()
    elif case != "clean":
        with pytest.raises(ProvisionReconciliationRequired):
            await run()
        assert native.mutations == []
        saved = (await registry.get("owner-a"))["backend_metadata"]["erasure"]
        assert "deletion" not in saved.get("managedPreparationCleanup", {})
        return
    else:
        await run()
    assert native.mutations == ["PUT", "DELETE"]
    assert native.inventory_calls == 1
    saved = (await registry.get("owner-a"))["backend_metadata"]["erasure"]
    assert (
        saved["managedPreparationCleanup"]["deletion"]["status"]
        == "retirement_pending_provider_purge"
    )
    before = list(native.calls)
    await run()
    assert native.calls == before  # Qualified completion retry performs no native work.
    assert saved["registrySnapshot"] == reservation["registrySnapshot"]
