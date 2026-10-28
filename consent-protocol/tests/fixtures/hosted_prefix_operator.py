"""Real SQL admissions with synthetic native responses for managed prefix cleanup."""

from __future__ import annotations

from copy import deepcopy
from types import SimpleNamespace
from urllib.parse import unquote

import pytest

from hushh_mcp.services.hosted_prefix_abort_operator import HostedPrefixAbortOperator
from hushh_mcp.services.hosted_prefix_native_resources import PrefixNativeResources
from hushh_mcp.services.provision_attempt import ProvisionReconciliationRequired
from tests.fixtures.hosted_prefix_abort import admitted_prefix_abort
from tests.test_hosted_pilot_admission_postgres import _Client

TOKEN = "synthetic-not-a-credential"


class NativePrefixFixture:
    def __init__(self, fixture):
        self.fixture = fixture
        self.inventory = fixture.native_inventory()
        self.log = []
        self.before_request = None
        self.resources = {}
        self.policies = {}
        self.key_state = "ENABLED"
        self.project = deepcopy(
            fixture.reservation()["registrySnapshot"]["backend_metadata"]["provisionAttempt"][
                "evidence"
            ]["reserved"]["hostedPreparation"]["completed"][0]["resourceObservation"]["identity"]
        )
        self.billing = {
            "projectId": fixture.project,
            "billingAccountName": fixture.provision["hostedAdmission"]["assignment"][
                "preparationContract"
            ]["billingAccount"],
            "billingEnabled": True,
        }
        native = PrefixNativeResources(
            project=fixture.project,
            number=self.project["projectNumber"],
            region=fixture.region,
            token=TOKEN,
            session=self,
        )
        for item in self.inventory["resources"]:
            if item["disposition"] == "created":
                body = deepcopy(item["identity"])
                if item["type"] == "service_account":
                    body["disabled"] = False
                if item["type"] == "gcs_bucket":
                    body.update(
                        metageneration="1", softDeletePolicy={"retentionDurationSeconds": "604800"}
                    )
                if item["type"] == "secret":
                    body["etag"] = "synthetic-secret-etag"
                self.resources[unquote(native.url(item))] = body
        auth = fixture.reservation()["registrySnapshot"]["backend_metadata"]["provisionAttempt"]
        self.authorization = auth["evidence"]["reserved"]["projectAuthorization"]["receipt"]
        self.bootstrap_url = (
            "https://iam.googleapis.com/v1/" + self.authorization["bootstrapIdentity"]["name"]
        )
        self.resources[self.bootstrap_url] = {
            **self.authorization["bootstrapIdentity"],
            "disabled": False,
        }
        for binding in [*self.inventory["bindings"], self.authorization["bindingObservation"]]:
            url = unquote(binding["policyResource"])
            policy = self.policies.setdefault(
                url, {"etag": "synthetic-current-etag", "bindings": []}
            )
            policy["bindings"].append({"role": binding["role"], "members": [binding["member"]]})

    @staticmethod
    def response(status, body=None):
        return SimpleNamespace(
            status_code=status, json=lambda: deepcopy(body or {}), text="synthetic", content=b"{}"
        )

    def request(self, method, url, **options):
        method, url = method.upper(), unquote(url)
        self.log.append((method, url))
        if self.before_request:
            self.before_request(method, url)
        if url in self.policies:
            if method in {"GET", "POST"}:
                return self.response(200, self.policies[url])
            if method == "PUT":
                self.policies[url] = deepcopy(options["json"])
                return self.response(200, self.policies[url])
        if url.endswith(":setIamPolicy"):
            key = url.removesuffix(":setIamPolicy") + ":getIamPolicy"
            self.policies[key] = deepcopy(options["json"]["policy"])
            return self.response(200, self.policies[key])
        if url.endswith("/o"):
            return self.response(200, {"items": []})
        if url.endswith("/cryptoKeyVersions"):
            name = self.inventory_key()["identity"]["name"] + "/cryptoKeyVersions/1"
            return self.response(
                200, {"cryptoKeyVersions": [{"name": name, "state": self.key_state}]}
            )
        if url.endswith(":destroy"):
            self.key_state = "DESTROY_SCHEDULED"
            return self.response(200, {})
        if url.endswith(":disable"):
            account = self._account_url(url.removesuffix(":disable"))
            self.resources[account]["disabled"] = True
            return self.response(200, {})
        if url.endswith("/billingInfo"):
            if method == "PUT":
                self.billing.update(billingAccountName="", billingEnabled=False)
            return self.response(200, self.billing)
        if url == "https://cloudresourcemanager.googleapis.com/v1/projects/" + self.fixture.project:
            if method == "DELETE":
                self.project["lifecycleState"] = "DELETE_REQUESTED"
            return self.response(200, self.project)
        url = self._account_url(url)
        if method == "PATCH" and "/storage/v1/b/" in url:
            self.resources[url].update(options["json"], metageneration="2")
            return self.response(200, self.resources[url])
        if method == "DELETE":
            self.resources.pop(url, None)
            return self.response(200, {})
        return (
            self.response(200, self.resources[url]) if url in self.resources else self.response(404)
        )

    def _account_url(self, url):
        return next(
            (
                key
                for key, body in self.resources.items()
                if "/serviceAccounts/" in key and url.endswith("/" + body["uniqueId"])
            ),
            url,
        )

    def inventory_key(self):
        return next(item for item in self.inventory["resources"] if item["type"] == "kms_key")

    def inventory_observer(self, reservation, stage, session):
        value = deepcopy(self.inventory)
        runtime = next(item for item in value["resources"] if item["type"] == "service_account")
        if stage == "admission":
            # The callback cannot secretly disable before durable admission.
            with pytest.raises(ProvisionReconciliationRequired, match="read-only"):
                session.request("POST", self.bootstrap_url + ":disable")
            value["writerFence"]["status"] = "admitted"
        else:
            url = "https://iam.googleapis.com/v1/" + runtime["identity"]["name"]
            assert self.resources[url]["disabled"] is True
        return value


class PrefixRegistry:
    def __init__(self, fixture, client):
        self.fixture, self.client = fixture, client
        self.hijack = False

    async def get(self, owner):
        value = deepcopy(self.fixture.row())
        if owner != self.fixture.owner or self.hijack:
            value["backend_metadata"]["erasure"]["ownerId"] = "foreign-owner"
        return value

    def _db(self):
        return self.client


async def verify_prefix_operator(pg):
    async for fixture in admitted_prefix_abort(pg, 18, bridge=True):
        native, client = NativePrefixFixture(fixture), _Client(pg)
        registry = PrefixRegistry(fixture, client)
        assignment = fixture.provision["hostedAdmission"]["assignment"]
        operator = HostedPrefixAbortOperator(
            registry,
            actor=assignment["preparationContract"]["operatorPrincipal"],
            token=TOKEN,
            session=native,
            observe_inventory=native.inventory_observer,
        )
        try:
            with pytest.raises(ProvisionReconciliationRequired, match="reservation unavailable"):
                await operator.prefix_abort(user_id="owner-b", reservation=fixture.reservation())
            assert native.log == []

            def revoke_after_read(method, url, registry=registry):
                if method == "GET" and url.endswith(":getIamPolicy"):
                    registry.hijack = True

            native.before_request = revoke_after_read
            with pytest.raises(ProvisionReconciliationRequired, match="reservation unavailable"):
                await operator.prefix_abort(
                    user_id=fixture.owner, reservation=fixture.reservation()
                )
            assert not any(
                url.endswith(":setIamPolicy") or method == "DELETE" for method, url in native.log
            )
            assert (
                fixture.reservation()["managedPrefixAbort"]["inventory"]["writerFence"]["status"]
                == "disabled"
            )
            native.before_request = None
            registry.hijack = False
            with pytest.raises(ProvisionReconciliationRequired, match="destruction is pending"):
                await operator.prefix_abort(
                    user_id=fixture.owner, reservation=fixture.reservation()
                )
            saved = fixture.reservation()
            key = "kms_key:" + native.inventory_key()["id"]
            assert "admission" in saved["managedPrefixAbort"]["resources"][key]
            assert "deletion" not in saved["managedPrefixAbort"]["resources"][key]
            assert "bootstrap" not in saved["managedPrefixAbort"]
            assert not pg.execute("SELECT personal_agent_erasure_complete(%s)", (fixture.owner,))[
                0
            ][0]
            mutations = [
                event
                for event in native.log
                if event[0] not in {"GET"} and not event[1].endswith(":getIamPolicy")
            ]
            assert mutations and mutations[0][1].endswith(":disable")
            native.key_state = "DESTROYED"  # Independent native passage of destruction delay.
            await operator.prefix_abort(user_id=fixture.owner, reservation=fixture.reservation())
            assert not pg.execute("SELECT personal_agent_erasure_complete(%s)", (fixture.owner,))[
                0
            ][0]
            registry.hijack = True
            count = len(native.log)
            with pytest.raises(ProvisionReconciliationRequired):
                await operator.retirement(user_id=fixture.owner, reservation=fixture.reservation())
            assert len(native.log) == count
            registry.hijack = False
            await operator.retirement(user_id=fixture.owner, reservation=fixture.reservation())
            assert pg.execute("SELECT personal_agent_erasure_complete(%s)", (fixture.owner,))[0][0]
            count = len(native.log)
            await operator.retirement(user_id=fixture.owner, reservation=fixture.reservation())
            assert len(native.log) == count  # Lost acknowledgement never repeats retirement.
        finally:
            client._engine.dispose()
