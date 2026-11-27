# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Cloud Run Admin v2 Jobs REST mixin for Option A ephemeral CLI workers (#9511)."""

from __future__ import annotations

import math
import re
import time
from typing import Any, Optional

_JOB_ID_RE = re.compile(r"^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$")


class GcpRunJobsClientMixin:
    """Mixin on `GcpRunClient` for Cloud Run Admin v2 `jobs` and `jobs:run`."""

    _project: str
    _region: str

    def _headers(self) -> dict[str, str]:  # pragma: no cover - supplied by GcpRunClient
        raise NotImplementedError

    def _validate_job_id(self, job_id: str) -> str:
        cleaned = str(job_id or "").strip()
        if not _JOB_ID_RE.fullmatch(cleaned):
            raise ValueError(f"invalid Cloud Run Job ID {job_id!r}")
        return cleaned

    def _jobs_parent(self) -> str:
        return f"projects/{self._project}/locations/{self._region}"

    def _poll_v2_operation(
        self,
        operation_body: dict[str, Any],
        *,
        http: Any,
        timeout_s: float,
        interval_s: float,
        label: str,
    ) -> dict[str, Any]:
        parent = self._jobs_parent()
        op_prefix = f"{parent}/operations/"
        op_name = operation_body.get("name")
        if (
            not isinstance(op_name, str)
            or not op_name.startswith(op_prefix)
            or not re.fullmatch(r"[A-Za-z0-9_.-]+", op_name[len(op_prefix) :])
        ):
            raise RuntimeError(f"Cloud Run {label} operation identity invalid")

        deadline = time.monotonic() + timeout_s
        current = operation_body
        while True:
            if "error" in current and current["error"]:
                raise RuntimeError(f"Cloud Run {label} operation failed")
            if current.get("done") is True:
                response_obj = current.get("response")
                if not isinstance(response_obj, dict):
                    raise RuntimeError(f"Cloud Run {label} operation missing settled response")
                return response_obj
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError(f"Cloud Run {label} operation timed out")
            time.sleep(min(interval_s, remaining))
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError(f"Cloud Run {label} operation timed out")
            poll = http.get(
                f"https://run.googleapis.com/v2/{op_name}",
                headers=self._headers(),
                timeout=min(30.0, remaining),
                allow_redirects=False,
            )
            if poll.status_code != 200:
                raise RuntimeError(
                    f"Cloud Run {label} operation poll failed status={poll.status_code}"
                )
            polled = poll.json()
            if not isinstance(polled, dict) or polled.get("name") != op_name:
                raise RuntimeError(f"Cloud Run {label} operation identity drifted")
            current = polled

    def get_job(self, job_id: str, *, session: Any = None) -> Optional[dict[str, Any]]:
        import requests  # type: ignore[import-untyped]

        clean_id = self._validate_job_id(job_id)
        http = session if session is not None else requests
        url = f"https://run.googleapis.com/v2/{self._jobs_parent()}/jobs/{clean_id}"
        res = http.get(url, headers=self._headers(), timeout=30, allow_redirects=False)
        if res.status_code == 404:
            return None
        if res.status_code != 200:
            raise RuntimeError(f"Cloud Run get_job failed status={res.status_code}")
        body = res.json()
        if not isinstance(body, dict):
            raise RuntimeError("Cloud Run get_job returned malformed payload")
        return body

    def upsert_job(
        self,
        job_id: str,
        body: dict[str, Any],
        *,
        timeout_s: float = 180.0,
        interval_s: float = 1.0,
        session: Any = None,
    ) -> dict[str, Any]:
        import requests  # type: ignore[import-untyped]

        clean_id = self._validate_job_id(job_id)
        if not math.isfinite(timeout_s) or timeout_s <= 0:
            raise ValueError("timeout_s must be positive")
        http = session if session is not None else requests
        parent = self._jobs_parent()
        existing = self.get_job(clean_id, session=http)
        if existing is None:
            create_res = http.post(
                f"https://run.googleapis.com/v2/{parent}/jobs",
                params={"jobId": clean_id},
                headers=self._headers(),
                json=body,
                timeout=min(60.0, timeout_s),
                allow_redirects=False,
            )
            if create_res.status_code == 409:
                existing = self.get_job(clean_id, session=http)
            elif create_res.status_code == 200:
                op = create_res.json()
                return self._poll_v2_operation(
                    op,
                    http=http,
                    timeout_s=timeout_s,
                    interval_s=interval_s,
                    label="job create",
                )
            else:
                raise RuntimeError(f"Cloud Run job create failed status={create_res.status_code}")

        patch_body = dict(body)
        if isinstance(existing, dict) and isinstance(existing.get("etag"), str):
            patch_body["etag"] = existing["etag"]
        patch_res = http.patch(
            f"https://run.googleapis.com/v2/{parent}/jobs/{clean_id}",
            headers=self._headers(),
            json=patch_body,
            timeout=min(60.0, timeout_s),
            allow_redirects=False,
        )
        if patch_res.status_code != 200:
            raise RuntimeError(f"Cloud Run job update failed status={patch_res.status_code}")
        return self._poll_v2_operation(
            patch_res.json(),
            http=http,
            timeout_s=timeout_s,
            interval_s=interval_s,
            label="job update",
        )

    def run_job_execution(
        self,
        job_id: str,
        overrides_body: dict[str, Any],
        *,
        timeout_s: float = 300.0,
        interval_s: float = 1.0,
        session: Any = None,
    ) -> dict[str, Any]:
        import requests  # type: ignore[import-untyped]

        clean_id = self._validate_job_id(job_id)
        if not math.isfinite(timeout_s) or timeout_s <= 0:
            raise ValueError("timeout_s must be positive")
        http = session if session is not None else requests
        parent = self._jobs_parent()
        run_res = http.post(
            f"https://run.googleapis.com/v2/{parent}/jobs/{clean_id}:run",
            headers=self._headers(),
            json=overrides_body,
            timeout=min(60.0, timeout_s),
            allow_redirects=False,
        )
        if run_res.status_code != 200:
            raise RuntimeError(f"Cloud Run jobs:run failed status={run_res.status_code}")
        return self._poll_v2_operation(
            run_res.json(),
            http=http,
            timeout_s=timeout_s,
            interval_s=interval_s,
            label="job execution",
        )
