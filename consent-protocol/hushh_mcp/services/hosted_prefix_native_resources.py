"""Incarnation-bound native operations for an unhosted managed core prefix.

Storage with retained objects refuses here; ordinary hosted erasure owns that
larger lifecycle. No credential discovery or authority is established here.
"""

from __future__ import annotations

import time
from typing import Any, cast
from urllib.parse import quote

from hushh_mcp.services import byoc_substrate as identities
from hushh_mcp.services.byoc_oauth_authorizer import _check
from hushh_mcp.services.hosted_native_inventory import NativeProjectInventory
from hushh_mcp.services.provision_attempt import ProvisionReconciliationRequired


class PrefixNativeResources:
    def __init__(
        self,
        *,
        project: str,
        number: str,
        region: str,
        token: str,
        session: Any,
        deadline: float | None = None,
    ) -> None:
        if not token:
            raise ProvisionReconciliationRequired("Prefix operator credential unavailable")
        self.project, self.number, self.region = project, number, region
        self.token = token
        self.headers = {"Authorization": "Bearer " + token}
        self.deadline = deadline if deadline is not None else time.monotonic() + 240
        self.session = BoundedPrefixSession(session, self.deadline)

    def request(self, method: str, url: str, **options: Any) -> Any:
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise ProvisionReconciliationRequired("Prefix native cleanup deadline exhausted")
        return self.session.request(
            method,
            url,
            headers=self.headers,
            timeout=min(20, remaining),
            allow_redirects=False,
            **options,
        )

    def url(self, item: dict) -> str:
        kind, rid = item["type"], quote(item["id"], safe="")
        roots = {
            "service_account": f"https://iam.googleapis.com/v1/projects/{self.project}/serviceAccounts/{rid}",
            "gcs_bucket": f"https://storage.googleapis.com/storage/v1/b/{rid}",
            "secret": f"https://secretmanager.googleapis.com/v1/projects/{self.project}/secrets/{rid}",
            "artifact_repository": f"https://artifactregistry.googleapis.com/v1/projects/{self.project}/locations/{self.region}/repositories/{rid}",
            "kms_key": f"https://cloudkms.googleapis.com/v1/projects/{self.project}/locations/{self.region}/keyRings/hushh-one/cryptoKeys/{rid}",
            "cloud_run_service": f"https://run.googleapis.com/v2/projects/{self.project}/locations/{self.region}/services/{rid}",
        }
        if kind not in roots:
            raise ProvisionReconciliationRequired("Unsupported prefix resource")
        return roots[kind]

    def observe(self, item: dict) -> dict | None:
        response = self.request("GET", self.url(item))
        if response.status_code == 404:
            return None
        body = _check(response, "observe managed prefix resource")
        if not isinstance(body, dict):
            raise ProvisionReconciliationRequired("Managed prefix resource response is malformed")
        if item["disposition"] != "created":
            raise ProvisionReconciliationRequired("Uncreated prefix resource exists")
        expected, kind, rid = item["identity"], item["type"], item["id"]
        if kind == "service_account":
            actual = identities._service_account_creation_identity(body, rid)
        elif kind == "gcs_bucket":
            actual = identities._bucket_creation_identity(body, rid)
        elif kind == "kms_key":
            actual = identities._kms_key_creation_identity(body, expected["name"])
        elif kind == "artifact_repository":
            actual = identities._artifact_repository_creation_identity(body, expected["name"])
        elif kind == "secret":
            candidate = {**body, "projectId": self.project}
            if "projectNumber" in expected:
                candidate["projectNumber"] = self.number
            actual = identities._secret_creation_identity(candidate, rid, self.project)
        else:
            raise ProvisionReconciliationRequired("Created compute is outside prefix cleanup")
        if actual != expected:
            raise ProvisionReconciliationRequired(f"Managed prefix {kind} incarnation changed")
        return body

    def versions(self, item: dict) -> list[dict]:
        if self.observe(item) is None:
            raise ProvisionReconciliationRequired(
                "Captured KMS key cannot be independently observed"
            )
        reader = NativeProjectInventory(
            project=self.project, number=self.number, token=self.token, session=self.session
        )
        values = reader.pages(self.url(item) + "/cryptoKeyVersions", "cryptoKeyVersions")
        prefix = item["identity"]["name"] + "/cryptoKeyVersions/"
        if not values or len(values) > 32000:
            raise ProvisionReconciliationRequired("Prefix KMS versions unavailable")
        names = [value.get("name", "") for value in values]
        if len(set(names)) != len(names) or any(
            not name.startswith(prefix)
            or not name[len(prefix) :].isdigit()
            or int(name[len(prefix) :]) < 1
            for name in names
        ):
            raise ProvisionReconciliationRequired("Prefix KMS version authority changed")
        return cast(list[dict], values)

    def erase(self, item: dict, admitted: dict) -> dict:
        if item["type"] == "kms_key" and item["disposition"] == "created":
            return self.destroy_versions(item, admitted)
        body = self.observe(item)
        if body is not None:
            options = self.delete_options(item, body)
            _check(
                self.request("DELETE", self.delete_url(item), **options),
                "delete admitted managed prefix resource",
                ok_statuses=(200, 204),
            )
            if self.observe(item) is not None:
                raise ProvisionReconciliationRequired("Managed prefix deletion awaits observation")
        status = "observed_absent" if item["disposition"] == "created" else item["disposition"]
        return {**admitted, "status": status}

    def delete_url(self, item: dict) -> str:
        if item["type"] == "service_account":
            return f"https://iam.googleapis.com/v1/projects/{self.project}/serviceAccounts/{item['identity']['uniqueId']}"
        return self.url(item)

    def delete_options(self, item: dict, body: dict) -> dict:
        if item["type"] == "service_account":
            if body.get("disabled") is not True:
                raise ProvisionReconciliationRequired("Prefix writer is not disabled")
        elif item["type"] == "gcs_bucket":
            self.require_empty_bucket(item)
            meta = str(body.get("metageneration", ""))
            if not meta.isdigit() or int(meta) < 1:
                raise ProvisionReconciliationRequired(
                    "Prefix bucket conditional authority unavailable"
                )
            if str(body.get("softDeletePolicy", {}).get("retentionDurationSeconds", "0")) != "0":
                _check(
                    self.request(
                        "PATCH",
                        self.url(item),
                        params={"ifMetagenerationMatch": meta},
                        json={"softDeletePolicy": {"retentionDurationSeconds": "0"}},
                    ),
                    "disable admitted prefix bucket soft deletion",
                )
                refreshed = self.observe(item)
                if refreshed is None:
                    raise ProvisionReconciliationRequired(
                        "Prefix bucket changed during policy update"
                    )
                if (
                    str(refreshed.get("softDeletePolicy", {}).get("retentionDurationSeconds", "0"))
                    != "0"
                ):
                    raise ProvisionReconciliationRequired(
                        "Prefix bucket policy update is unconfirmed"
                    )
                meta = str(refreshed.get("metageneration", ""))
                if not meta.isdigit() or int(meta) < 1:
                    raise ProvisionReconciliationRequired(
                        "Prefix bucket conditional authority changed"
                    )
            return {"params": {"ifMetagenerationMatch": meta}}
        elif item["type"] == "secret":
            if not isinstance(body.get("etag"), str) or not body["etag"]:
                raise ProvisionReconciliationRequired(
                    "Prefix secret conditional authority unavailable"
                )
            return {"params": {"etag": body["etag"]}}
        return {}

    def require_empty_bucket(self, item: dict) -> None:
        for query in ({"versions": "true"}, {"softDeleted": "true"}):
            seen: set[str] = set()
            for _ in range(1000):
                body = _check(
                    self.request("GET", self.url(item) + "/o", params=query),
                    "observe prefix bucket objects",
                )
                if body.get("error") or body.get("unreachable"):
                    raise ProvisionReconciliationRequired("Prefix object inventory is unverified")
                if not isinstance(body.get("items", []), list) or body.get("items"):
                    raise ProvisionReconciliationRequired(
                        "Prefix storage requires full object erasure"
                    )
                page = body.get("nextPageToken", "")
                if not isinstance(page, str) or page in seen:
                    raise ProvisionReconciliationRequired("Prefix object pagination is unverified")
                if not page:
                    break
                seen.add(page)
                query = {**query, "pageToken": page}
            else:
                raise ProvisionReconciliationRequired("Prefix object inventory limit exhausted")

    def destroy_versions(self, item: dict, admitted: dict) -> dict:
        expected = set(admitted["versionNames"])
        values = self.versions(item)
        if {value["name"] for value in values} != expected:
            raise ProvisionReconciliationRequired("Prefix KMS inventory expanded")
        for value in values:
            if value.get("state") in {"ENABLED", "DISABLED"}:
                self.observe(item)
                _check(
                    self.request(
                        "POST",
                        "https://cloudkms.googleapis.com/v1/" + value["name"] + ":destroy",
                        json={},
                    ),
                    "schedule admitted prefix KMS destruction",
                )
            elif value.get("state") not in {"DESTROYED", "DESTROY_SCHEDULED"}:
                raise ProvisionReconciliationRequired("Prefix KMS version state is unverified")
        observed = self.versions(item)
        if {value["name"] for value in observed} != expected or any(
            value.get("state") != "DESTROYED" for value in observed
        ):
            raise ProvisionReconciliationRequired("Prefix key destruction is pending")
        return {
            **admitted,
            "status": "destroyed",
            "destroyedVersions": [
                {"name": value["name"], "state": "DESTROYED"} for value in observed
            ],
        }


class BoundedPrefixSession:
    def __init__(self, session: Any, deadline: float) -> None:
        self._session, self._deadline = session, deadline

    def request(self, method: str, url: str, **options: Any) -> Any:
        remaining = self._deadline - time.monotonic()
        if remaining <= 0:
            raise ProvisionReconciliationRequired("Prefix native deadline exhausted")
        options["timeout"] = min(float(options.get("timeout", 20)), 20, remaining)
        options["allow_redirects"] = False
        return self._session.request(method, url, **options)

    def get(self, url: str, **options: Any) -> Any:
        return self.request("GET", url, **options)

    def post(self, url: str, **options: Any) -> Any:
        return self.request("POST", url, **options)

    def put(self, url: str, **options: Any) -> Any:
        return self.request("PUT", url, **options)
