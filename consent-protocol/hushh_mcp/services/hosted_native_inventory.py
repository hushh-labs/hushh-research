"""Bounded native project inventory for the operator's managed-pod cleanup.

This reader grants no deletion authority. Disabled APIs, incomplete pagination,
unreachable locations and ambiguous regional errors remain unverified.
"""

from __future__ import annotations

import re
import time
from typing import Any, Callable
from urllib.parse import urlsplit

from hushh_mcp.services.provision_attempt import ProvisionReconciliationRequired


class NativeInventoryReadError(ProvisionReconciliationRequired):
    def __init__(self, status: int, host: str, location: str) -> None:
        super().__init__("Native inventory provider read is unverified")
        self.http_status, self.api_host, self.location = status, host, location


class NativeProjectInventory:
    def __init__(
        self,
        *,
        project: str,
        number: str,
        token: str,
        session: Any,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if not re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", project) or not re.fullmatch(
            r"[1-9][0-9]{0,19}", number
        ):
            raise ValueError("Invalid managed inventory project")
        if not token:
            raise ValueError("Managed inventory credential is unavailable")
        self.project, self.number = project, number
        self._session, self._clock = session, clock
        self._deadline = clock() + 240
        self._headers = {"Authorization": "Bearer " + token}
        self.coverage: list[dict[str, Any]] = []

    def _read(self, url: str, params: dict) -> dict:
        response = self.response(url, params)
        if response.status_code != 200:
            parts = urlsplit(url)
            match = re.search(r"/locations/([^/]+)", parts.path)
            raise NativeInventoryReadError(
                response.status_code, parts.netloc, match[1] if match else "global"
            )
        return self.body(response)

    def response(self, url: str, params: dict) -> Any:
        """Keep response classification separate while retaining target/deadline checks."""
        self._require_target(url, params)
        remaining = self._deadline - self._clock()
        if remaining <= 0:
            raise ProvisionReconciliationRequired("Native inventory deadline exhausted")
        return self._session.get(
            url,
            params=params,
            headers=self._headers,
            timeout=min(20, remaining),
            allow_redirects=False,
        )

    @staticmethod
    def body(response: Any) -> dict:
        if response.status_code != 200:
            raise ProvisionReconciliationRequired("Native inventory provider read is unverified")
        value = response.json()
        if not isinstance(value, dict) or value.get("unreachable"):
            raise ProvisionReconciliationRequired("Native inventory coverage is incomplete")
        return value

    def _require_target(self, url: str, params: dict) -> None:
        parts = urlsplit(url)
        host = parts.netloc
        allowed_host = host in {
            "run.googleapis.com",
            "storage.googleapis.com",
            "cloudkms.googleapis.com",
            "secretmanager.googleapis.com",
            "aiplatform.googleapis.com",
            "cloudresourcemanager.googleapis.com",
        } or re.fullmatch(
            r"(?:(?:secretmanager|aiplatform)\.[a-z0-9-]+\.rep|[a-z0-9-]+-aiplatform)\.googleapis\.com",
            host,
        )
        scoped = any(
            parts.path == f"/{version}/projects/{project}"
            or parts.path.startswith(f"/{version}/projects/{project}/")
            for version in ("v1", "v2", "v1beta1")
            for project in (self.project, self.number)
        )
        storage = (
            host == "storage.googleapis.com"
            and parts.path == "/storage/v1/b"
            and params.get("project") in {self.project, self.number}
        )
        regional = re.fullmatch(
            r"(?:(?:secretmanager|aiplatform)\.([a-z0-9-]+)\.rep|([a-z0-9-]+)-aiplatform)\.googleapis\.com",
            host,
        )
        region = next((value for value in regional.groups() if value), None) if regional else None
        location = re.search(r"/locations/([^/]+)(?:/|$)", parts.path)
        if (
            parts.scheme != "https"
            or not allowed_host
            or parts.query
            or parts.fragment
            or "%" in parts.path
            or any(part in {".", ".."} for part in parts.path.split("/"))
            or not (scoped or storage)
            or (region is not None and (location is None or location[1] != region))
        ):
            raise ProvisionReconciliationRequired("Native inventory target is outside its project")

    def pages(
        self,
        url: str,
        field: str,
        *,
        params: dict | None = None,
    ) -> list[dict]:
        """Google's omitted empty arrays are valid; denied/malformed reads are not."""
        query = dict(params or {})
        values: list[dict] = []
        seen: set[str] = set()
        for _ in range(1000):
            body = self._read(url, query)
            items = body.get(field, [])
            token = body.get("nextPageToken", "")
            if (
                not isinstance(items, list)
                or any(not isinstance(item, dict) for item in items)
                or not isinstance(token, str)
                or len(values) + len(items) > 100000
                or token in seen
            ):
                raise ProvisionReconciliationRequired("Native inventory pagination is unverified")
            values.extend(items)
            if not token:
                self.coverage.append(
                    {
                        "url": url,
                        "filters": dict(params or {}),
                        "pages": len(seen) + 1,
                        "complete": True,
                    }
                )
                return values
            seen.add(token)
            query["pageToken"] = token
        raise ProvisionReconciliationRequired("Native inventory pagination limit exhausted")

    def locations(self, service: str) -> list[str]:
        if service not in {"cloudkms", "secretmanager", "aiplatform"}:
            raise ValueError("Unsupported native inventory service")
        values = self.pages(
            f"https://{service}.googleapis.com/v1/projects/{self.project}/locations", "locations"
        )
        locations = []
        for item in values:
            name = item.get("name", "")
            match = re.fullmatch(r"projects/([^/]+)/locations/([a-z0-9-]+)", name)
            if match is None or match[1] not in {self.project, self.number}:
                raise ProvisionReconciliationRequired("Native location authority changed")
            if "locationId" in item and item["locationId"] != match[2]:
                raise ProvisionReconciliationRequired("Native location identity changed")
            locations.append(match[2])
        if not locations or len(set(locations)) != len(locations):
            raise ProvisionReconciliationRequired("Native locations are unverified")
        return sorted(locations)

    def project_identity(self, expected: dict | None = None) -> dict:
        value = self._read(
            f"https://cloudresourcemanager.googleapis.com/v1/projects/{self.project}", {}
        )
        if (
            value.get("projectId") != self.project
            or value.get("projectNumber") != self.number
            or value.get("lifecycleState") != "ACTIVE"
            or (expected is not None and {key: value.get(key) for key in expected} != expected)
        ):
            raise ProvisionReconciliationRequired("Native project incarnation changed")
        return value

    def core(self) -> dict[str, list[dict]]:
        """Collect global compute/storage and every KMS/Secret Manager location."""
        self.project_identity()
        project = self.project
        inventory = {
            "cloud_run_services": self.pages(
                f"https://run.googleapis.com/v2/projects/{project}/locations/-/services",
                "services",
            ),
            "cloud_run_jobs": self.pages(
                f"https://run.googleapis.com/v2/projects/{project}/locations/-/jobs", "jobs"
            ),
            "buckets": self.pages(
                "https://storage.googleapis.com/storage/v1/b", "items", params={"project": project}
            ),
            "soft_deleted_buckets": self.pages(
                "https://storage.googleapis.com/storage/v1/b",
                "items",
                params={"project": project, "softDeleted": "true"},
            ),
            "kms_keys": [],
            "secrets": self.pages(
                f"https://secretmanager.googleapis.com/v1/projects/{project}/secrets", "secrets"
            ),
        }
        for location in self.locations("cloudkms"):
            rings = self.pages(
                f"https://cloudkms.googleapis.com/v1/projects/{project}/locations/{location}/keyRings",
                "keyRings",
            )
            for ring in rings:
                prefix = f"projects/{project}/locations/{location}/keyRings/"
                numeric = f"projects/{self.number}/locations/{location}/keyRings/"
                name = ring.get("name", "")
                if not any(
                    name.startswith(root) and "/" not in name[len(root) :]
                    for root in (prefix, numeric)
                ):
                    raise ProvisionReconciliationRequired("Native keyring authority changed")
                inventory["kms_keys"].extend(
                    self.pages(
                        f"https://cloudkms.googleapis.com/v1/{name}/cryptoKeys", "cryptoKeys"
                    )
                )
        for location in self.locations("secretmanager"):
            if location == "global":
                continue  # Global secrets were independently listed above.
            inventory["secrets"].extend(
                self.pages(
                    f"https://secretmanager.{location}.rep.googleapis.com/v1/"
                    f"projects/{project}/locations/{location}/secrets",
                    "secrets",
                )
            )
        return inventory
