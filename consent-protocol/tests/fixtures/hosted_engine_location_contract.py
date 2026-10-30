"""Fresh-pilot capability classification retains ca without fabricating a list."""

import json
from copy import deepcopy
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from hushh_mcp.services import hosted_engine_location_contract as contract
from hushh_mcp.services.hosted_native_inventory import NativeProjectInventory
from hushh_mcp.services.hosted_native_memory_inventory import observe_memory_absence
from hushh_mcp.services.provision_attempt import ProvisionReconciliationRequired

TOKEN = "synthetic-memory-inventory"
NOW = datetime(2026, 10, 27, 10, 20, tzinfo=timezone.utc)


class MemoryNamespaceFixture:
    def __init__(self, creation, *, ca_status=404):
        self.creation = {**deepcopy(creation), "createTime": "2026-10-27T10:00:00Z"}
        self.ca_status, self.requests = ca_status, []
        self.ca_reads = 0
        self.fail_other = False

    def get(self, url, **options):
        self.requests.append(url)
        code, value = 200, {}
        if url.endswith("/locations"):
            value = {
                "locations": [
                    {"name": f"projects/{self.creation['projectId']}/locations/{loc}"}
                    for loc in ("ca", "us-central1", "us", "eu")
                ]
            }
        elif "/locations/ca/reasoningEngines" in url:
            self.ca_reads += 1
            code = (
                self.ca_status[self.ca_reads - 1]
                if isinstance(self.ca_status, list)
                else self.ca_status
            )
        elif self.fail_other and "/locations/eu/reasoningEngines" in url:
            code = 404
        elif "/reasoningEngines" not in url:
            value = deepcopy(self.creation)
        return SimpleNamespace(status_code=code, json=lambda: deepcopy(value), content=b"{}")

    def observe(self, creation, context, *, retained=()):
        reader = NativeProjectInventory(
            project=creation["projectId"],
            number=creation["projectNumber"],
            token=TOKEN,
            session=self,
        )
        return observe_memory_absence(
            reader,
            assigned_region="us-central1",
            creation=creation,
            managed_context=context,
            retained_locations=retained,
        )


def runtime_negative_controls(creation, context, monkeypatch):
    for code in (400, 403, 500):
        with pytest.raises(ProvisionReconciliationRequired):
            MemoryNamespaceFixture(creation, ca_status=code).observe(creation, context)
    with pytest.raises(ProvisionReconciliationRequired):
        MemoryNamespaceFixture(creation, ca_status=[200, 404]).observe(creation, context)
    with pytest.raises(ProvisionReconciliationRequired):
        MemoryNamespaceFixture(creation).observe(creation, None)
    for owner, attempt in (("foreign-owner", None), (None, "f" * 32)):
        changed = deepcopy(context)
        if owner:
            changed["ownerId"] = owner
        if attempt:
            changed["registrySnapshot"]["backend_metadata"]["provisionAttempt"]["attemptId"] = (
                attempt
            )
        with pytest.raises(ProvisionReconciliationRequired):
            MemoryNamespaceFixture(creation).observe(creation, changed)
    missing = MemoryNamespaceFixture(creation)
    del missing.creation["createTime"]
    with pytest.raises(ProvisionReconciliationRequired):
        missing.observe(creation, context)
    legacy = deepcopy(context)
    legacy["registrySnapshot"]["backend_metadata"]["provisionAttempt"]["hostedAdmission"][
        "environment"
    ] = "prod"
    with pytest.raises(ProvisionReconciliationRequired):
        MemoryNamespaceFixture(creation).observe(creation, legacy)
    for timestamp in ("2026-10-25T00:00:00Z", "2026-10-28T00:00:00Z"):
        native = MemoryNamespaceFixture(creation)
        native.creation["createTime"] = timestamp
        with pytest.raises(ProvisionReconciliationRequired):
            native.observe(creation, context)
    with pytest.raises(ProvisionReconciliationRequired):
        MemoryNamespaceFixture(creation).observe(creation, context, retained=("ca",))
    native = MemoryNamespaceFixture(creation)
    native.fail_other = True
    with pytest.raises(ProvisionReconciliationRequired):
        native.observe(creation, context)
    retained = deepcopy(context)
    retained["registrySnapshot"]["backend_metadata"]["retainedEngine"] = (
        f"projects/{creation['projectId']}/locations/ca/reasoningEngines/existing"
    )
    with pytest.raises(ProvisionReconciliationRequired):
        MemoryNamespaceFixture(creation).observe(creation, retained)
    monkeypatch.setattr(contract, "utc_now", lambda: datetime(2026, 11, 1, tzinfo=timezone.utc))
    with pytest.raises(ProvisionReconciliationRequired):
        MemoryNamespaceFixture(creation).observe(creation, context)
    # Actual successful native pages outrank an expired N/A contract, even for legacy callers.
    assert all(
        row["status"] == "listed_empty"
        for row in MemoryNamespaceFixture(creation, ca_status=200).observe(creation, None)[
            "coverage"
        ]
    )
    monkeypatch.setattr(contract, "utc_now", lambda: NOW)


def sql_negative_controls(pg, coordinates, receipt):
    def valid(value):
        return pg.execute(
            "SELECT valid_managed_prefix_memory_absence(%s::jsonb,%s::jsonb)",
            (json.dumps(coordinates), json.dumps(value)),
        )[0][0]

    assert valid(receipt)
    for field, value in (("pages", 1), ("status", "listed_empty"), ("location", "us")):
        changed = deepcopy(receipt)
        changed["coverage"][0][field] = value
        assert not valid(changed)
    for path, value in (
        (("providerContract", "snapshotSha256"), "0" * 64),
        (("providerContract", "qualificationExpiresAt"), "2027-01-01T00:00:00Z"),
        (("projectIdentity", "projectNumber"), "999999999999"),
        (("projectIdentity", "createTime"), "2026-10-25T00:00:00Z"),
        (("projectIdentity", "createTime"), "2026-10-28T00:00:00Z"),
        (("endpointObservation", "httpStatus"), 403),
        (("endpointObservation", "url"), "https://foreign.googleapis.com/"),
    ):
        changed = deepcopy(receipt)
        changed["coverage"][0][path[0]][path[1]] = value
        assert not valid(changed)
    changed = deepcopy(receipt)
    changed["coverage"][0]["projectIdentity"]["labels"]["hussh-provision-attempt"] = "f" * 32
    assert not valid(changed)
    changed = deepcopy(receipt)
    changed["coverage"][0]["observedAt"] = "2026-11-01T00:00:00Z"
    assert not valid(changed)
    changed = deepcopy(receipt)
    changed["coverage"].pop(0)
    assert not valid(changed)  # ca cannot be filtered out of the catalogue.


async def verify_engine_location_contract(pg, monkeypatch):
    monkeypatch.setattr(contract, "utc_now", lambda: NOW)
    context = pg.execute(
        "SELECT backend_metadata->'erasure' FROM personal_agent_registry WHERE user_id='owner-a'"
    )[0][0]
    attempt = context["registrySnapshot"]["backend_metadata"]["provisionAttempt"]
    creation = attempt["evidence"]["reserved"]["hostedPreparation"]["completed"][0][
        "resourceObservation"
    ]["identity"]
    native = MemoryNamespaceFixture(creation)
    receipt = native.observe(creation, context)
    assert "ca" in receipt["locations"] and "ca" in receipt["locationCatalogue"]["locations"]
    assert receipt["coverage"][0]["status"] == "not_applicable"
    assert receipt["coverage"][0]["pages"] == 0
    assert "/locations/ca/reasoningEngines" in next(
        url for url in native.requests if "/reasoningEngines" in url
    )
    coordinates = pg.execute(
        "SELECT managed_prefix_abort_context(%s::jsonb)", (json.dumps(context),)
    )[0][0]
    sql_negative_controls(pg, coordinates, receipt)
    runtime_negative_controls(creation, context, monkeypatch)


async def verify_all_memory_inventory(pg, monkeypatch):
    from tests.fixtures.hosted_prefix_abort import verify_memory_inventory

    await verify_memory_inventory(pg)
    await verify_engine_location_contract(pg, monkeypatch)
