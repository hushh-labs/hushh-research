"""Stop the approved legacy compute incarnation and settle native Memory."""

from __future__ import annotations

import hashlib
from uuid import uuid4

from hushh_mcp.services.legacy_cloud_removal import (
    PROTECTED_PROJECTS,
    LegacyRemovalJournal,
    _require,
    resource_key,
    resource_state,
    sha256,
)
from hushh_mcp.services.legacy_cloud_removal_native import (
    RecoverySession,
    native_identity,
    resource_url,
)


class LegacyGcpRemoval:
    """Execute one exact approved plan; unknown submissions only permit observation."""

    def __init__(self, *, session: RecoverySession, journal: LegacyRemovalJournal):
        self.session, self.journal = session, journal
        self.plan = journal.read()["plan"]
        self.project = self.plan["project"]["projectId"]
        self.region = self.plan["runtime"]["serviceName"].split("/")[3]
        _require(self.project not in PROTECTED_PROJECTS)

    def _resource(self, kind: str, name: str | None = None) -> dict:
        found = [
            item
            for item in self.plan["resources"]
            if item["type"] == kind and (name is None or item["id"] == name)
        ]
        _require(len(found) == 1)
        return found[0]

    def _intent(self, resource: dict, *, writer: bool = False) -> dict:
        state = resource_state(self.journal.read(), resource_key(resource))
        stage = "writer_intent" if writer else "intent"
        if stage not in state:
            receipt = {
                "identitySha256": self.journal.identity_sha256(resource),
                "requestId": uuid4().hex,
                "method": "POST"
                if writer
                or resource["type"] in {"kms_key", "project_iam_policy", "bootstrap_access"}
                else "DELETE",
            }
            self.journal.append(resource_key(resource), stage, receipt)
        return resource_state(self.journal.read(), resource_key(resource))

    def _observe(
        self,
        resource: dict,
        response,
        status: str,
        *,
        operation: str | None = None,
        complete: bool | None = None,
        coverage: dict | None = None,
    ) -> None:
        self.journal.append(
            resource_key(resource),
            "observation",
            {
                "identitySha256": self.journal.identity_sha256(resource),
                "status": status,
                "httpStatus": response.status_code,
                "nativeReadbackSha256": hashlib.sha256(response.content).hexdigest(),
                "operationName": operation,
                "operationDone": complete,
                "coverage": coverage or {},
            },
        )

    def _poll(self, operation: str, *, engine: bool = False) -> bool:
        parts = operation.split("/")
        _require(
            len(parts) in {6, 8}
            and parts[0] == "projects"
            and parts[1] in {self.project, self.plan["project"]["projectNumber"]}
            and parts[2:4] == ["locations", self.region]
            and parts[-2] == "operations"
        )
        if len(parts) == 8:
            _require(
                engine
                and parts[4:6]
                == ["reasoningEngines", self.plan["memory"]["engineName"].split("/")[-1]]
            )
        host = (
            f"{self.region}-aiplatform.googleapis.com/v1beta1"
            if engine
            else "run.googleapis.com/v2"
        )
        response = self.session.get(f"https://{host}/{operation}")
        _require(response.status_code == 200)
        body = response.json()
        _require(body.get("name") == operation and "error" not in body)
        if body.get("done") is True:
            _require(isinstance(body.get("response"), dict))
        return body.get("done") is True

    def _pages(self, url: str, field: str) -> list[dict]:
        values, seen, token = [], set(), ""
        for _ in range(128):
            response = self.session.get(
                url, params={"pageSize": 1000, **({"pageToken": token} if token else {})}
            )
            _require(response.status_code == 200)
            body = response.json()
            _require(
                not body.get("error")
                and not body.get("unreachable")
                and isinstance(body.get(field, []), list)
            )
            values.extend(body.get(field, []))
            token = body.get("nextPageToken", "")
            _require(isinstance(token, str) and token not in seen)
            if not token:
                return values
            seen.add(token)
        raise RuntimeError("Native inventory pagination incomplete")

    def _checkpoint(self, resource: dict, stage: str, value: dict) -> bool:
        self.journal.append(
            resource_key(resource),
            "checkpoint",
            {
                "identitySha256": self.journal.identity_sha256(resource),
                "stage": stage,
                "value": value,
            },
        )
        return True

    def _checkpoints(self, resource: dict) -> dict:
        state: dict = {}
        for event in self.journal.read()["events"]:
            if event["resource"] != resource_key(resource) or event["stage"] != "checkpoint":
                continue
            stage, value = event["receipt"]["stage"], event["receipt"]["value"]
            if stage in {"admission", "acknowledgement", "destruction"} and "versionName" in value:
                state.setdefault("versions", {}).setdefault(value["versionName"], {})[stage] = value
            else:
                state[stage] = value
        return state

    def _operations(self, *, engine: bool = False) -> dict:
        if engine:
            url = (
                resource_url(self.project, self.region, self._resource("reasoning_engine"))
                + "/operations"
            )
        else:
            url = f"https://run.googleapis.com/v2/projects/{self.project}/locations/{self.region}/operations"
        operations = self._pages(url, "operations")
        # Listing includes every page, without a recent-operation filter. Ambiguous
        # project-wide pending work refuses; it is never adopted as our DELETE.
        _require(
            all(item.get("done") is True for item in operations), "CLOUD_REMOVAL_PROVIDER_PENDING"
        )
        return {"complete": True, "pendingOperations": 0, "inventorySha256": sha256(operations)}

    def delete_compute(self, *, credentials) -> None:
        from hushh_mcp.services.gcp_run_client import GcpRunClient

        resource = self._resource("cloud_run_service")
        self.session.resource = resource
        state = resource_state(self.journal.read(), resource_key(resource))
        if state.get("observation", {}).get("status") == "deleted":
            return
        operation = state.get("acknowledgement", {}).get("operationName")
        _require(
            "provider_dispatch" not in state or operation is not None,
            "CLOUD_REMOVAL_PROVIDER_OUTCOME_UNKNOWN",
        )
        self._operations()

        def admit(observed: dict) -> bool:
            expected = self.plan["runtime"]
            _require(
                all(
                    observed[key] == expected[key]
                    for key in ("serviceName", "serviceUid", "image", "generation", "etag")
                )
            )
            self._intent(resource)
            return True

        client = GcpRunClient(project=self.project, region=self.region, credentials=credentials)
        client.delete_service(
            resource["id"],
            expected_uid=self.plan["runtime"]["serviceUid"],
            timeout_s=45,
            interval_s=1,
            operation_name=operation,
            before_submit=admit,
            on_acknowledged=lambda _: True,
            session=self.session,
        )
        state = resource_state(self.journal.read(), resource_key(resource))
        operation = state["acknowledgement"]["operationName"]
        _require(self._poll(operation))
        response = self.session.get(resource_url(self.project, self.region, resource))
        _require(response.status_code == 404)
        # The provider operation's completed Service identity is verified by the
        # existing client. Its documented delete contract retires all revisions.
        coverage = {**self._operations(), "remainingRevisions": 0}
        self._observe(
            resource, response, "deleted", operation=operation, complete=True, coverage=coverage
        )

    def delete_memory(self) -> None:
        resource = self._resource("reasoning_engine")
        self.session.resource = resource
        state = resource_state(self.journal.read(), resource_key(resource))
        if state.get("observation", {}).get("status") == "deleted":
            return
        url = resource_url(self.project, self.region, resource)
        operation = state.get("acknowledgement", {}).get("operationName")
        if operation is None and "provider_dispatch" not in state:
            current = self.session.get(url)
            _require(
                current.status_code == 200
                and native_identity("reasoning_engine", current.json()) == resource["identity"]
            )
            coverage = self._operations(engine=True)
            self._intent(resource)
            self._checkpoint(resource, "inventory", coverage)
            response = self.session.delete(url, params={"force": "true"})
            _require(response.status_code == 200)
            operation = resource_state(self.journal.read(), resource_key(resource))[
                "acknowledgement"
            ]["operationName"]
        _require(isinstance(operation, str), "CLOUD_REMOVAL_PROVIDER_OUTCOME_UNKNOWN")
        _require(self._poll(operation, engine=True), "CLOUD_REMOVAL_PROVIDER_PENDING")
        current = self.session.get(url)
        _require(current.status_code == 404)
        coverage = self._checkpoints(resource).get("inventory")
        _require(isinstance(coverage, dict) and coverage.get("complete") is True)
        self._observe(
            resource, current, "deleted", operation=operation, complete=True, coverage=coverage
        )
