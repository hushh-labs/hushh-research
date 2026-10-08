"""An in-memory ARM that answers like the real one where the Azure lane depends on it.

Not a mock of method calls: it holds resources by ARM id, fills in what Azure fills in
(principal ids on an identity, a versioned key URI, an agent's FQDN and revisions,
``systemData.createdAt``), and records every call so tests assert on what was sent.
"""

from __future__ import annotations

import copy
from typing import Any, Optional

from hushh_mcp.services.azure_arm_client import ArmError, ArmResponse

POD_PRINCIPAL = "66666666-6666-6666-6666-666666666666"
POD_CLIENT = "77777777-7777-7777-7777-777777777777"


class FakeArm:
    def __init__(self) -> None:
        self.resources: dict[str, dict[str, Any]] = {}
        self.calls: list[tuple[str, str, Optional[dict]]] = []
        #: (method, path fragment) -> ArmErrors raised in order before succeeding.
        self.failures: dict[tuple[str, str], list[ArmError]] = {}
        self.forbidden: set[str] = set()
        self.revision = 1

    def fail(self, method: str, suffix: str, *errors: ArmError) -> None:
        self.failures[(method, suffix)] = list(errors)

    def _maybe_fail(self, method: str, path: str) -> None:
        if path in self.forbidden:
            raise ArmError(
                "forbidden", status=403, code="AuthorizationFailed", message="", op=method
            )
        for (fail_method, suffix), queue in self.failures.items():
            if fail_method == method and suffix in path and queue:
                raise queue.pop(0)

    def _enrich(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        stored = copy.deepcopy(body)
        stored["id"] = path
        props = stored.setdefault("properties", {})
        if "/userAssignedIdentities/" in path:
            props.update(principalId=POD_PRINCIPAL, clientId=POD_CLIENT)
        elif "/keys/" in path:
            props["keyUriWithVersion"] = (
                f"https://{path.split('/vaults/')[1].split('/')[0]}.vault.azure.net/keys/pod-log-key/v1"
            )
        elif "/containerApps/" in path and "/revisions/" not in path:
            suffix = (props.get("template") or {}).get("revisionSuffix") or f"r{self.revision}"
            self.revision += 1
            revision = f"ca-hussh-one-pod--{suffix}"
            props.update(
                provisioningState="Succeeded",
                latestRevisionName=revision,
                latestReadyRevisionName=revision,
            )
            props.setdefault("configuration", {}).setdefault("ingress", {})["fqdn"] = (
                "ca-hussh-one-pod.happyfield.eastus2.azurecontainerapps.io"
            )
            identities = (stored.get("identity") or {}).get("userAssignedIdentities") or {}
            for key in identities:
                identities[key] = {"principalId": POD_PRINCIPAL, "clientId": POD_CLIENT}
            previous = self.resources.get(path)
            stored["systemData"] = (previous or {}).get("systemData") or {
                "createdAt": "2026-10-02T00:00:00Z"
            }
        return stored

    # -- the ArmClient surface the lane uses ------------------------------------------

    def get(self, path: str, *, api_version: str, op: str = "") -> dict[str, Any]:
        self.calls.append(("GET", path, None))
        self._maybe_fail("GET", path)
        if path.count("/") == 4 and "/providers/Microsoft." in path:
            return {"registrationState": "Registered"}  # /subscriptions/{s}/providers/{ns}
        if path not in self.resources:
            raise ArmError("not_found", status=404, code="ResourceNotFound", message="", op=op)
        return copy.deepcopy(self.resources[path])

    def get_or_none(self, path: str, *, api_version: str, op: str = "") -> Optional[dict]:
        try:
            return self.get(path, api_version=api_version, op=op)
        except ArmError as exc:
            if exc.kind == "not_found":
                return None
            raise

    def put(self, path: str, *, api_version: str, body: dict, op: str = "") -> dict[str, Any]:
        self.calls.append(("PUT", path, copy.deepcopy(body)))
        self._maybe_fail("PUT", path)
        self.resources[path] = self._enrich(path, body)
        return copy.deepcopy(self.resources[path])

    def post(
        self, path: str, *, api_version: str, body: Optional[dict] = None, op: str = ""
    ) -> dict:
        self.calls.append(("POST", path, copy.deepcopy(body)))
        self._maybe_fail("POST", path)
        return {"status": "Succeeded"}

    def delete(self, path: str, *, api_version: str, op: str = "") -> bool:
        self.calls.append(("DELETE", path, None))
        self._maybe_fail("DELETE", path)
        return self.resources.pop(path, None) is not None

    def request(self, method: str, path: str, *, api_version: str, body=None, op: str = ""):
        stored = self.put(path, api_version=api_version, body=body or {}, op=op)
        return ArmResponse(status=201, body=stored, headers={})

    @staticmethod
    def needs_poll(response: ArmResponse) -> bool:
        return False

    def wait(self, response: ArmResponse, op: str) -> dict[str, Any]:
        return {}

    # -- assertions -------------------------------------------------------------------

    def writes(self) -> list[tuple[str, str]]:
        return [(method, path) for method, path, _ in self.calls if method != "GET"]
