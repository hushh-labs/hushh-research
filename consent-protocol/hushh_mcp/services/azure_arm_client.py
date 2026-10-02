"""Raw Azure Resource Manager REST for a person's own subscription.

No Azure SDK (no new dependency): pinned api-versions, long-running-operation
polling (``Azure-AsyncOperation`` / ``Location``), throttling with ``Retry-After``,
and typed errors a caller can branch on without parsing prose.

NO ETAG RELIANCE. Container Apps returns no ETag on GET (measured 2026-10-02), so
ARM optimistic concurrency is not available for the agent's own resource. Callers
fence with Hussh's own records instead: the hub's upgrade lease, the creation-nonce
tag and ``systemData.createdAt``.

The bearer token is the caller's to choose (a person's delegated token during setup,
the Hussh observer token afterwards). It is only ever sent to ARM: a polling URL
that names any other host is refused rather than followed.
"""

from __future__ import annotations

import logging
import time
import urllib.parse
from dataclasses import dataclass, field
from typing import Any, Callable, Literal, Optional, Union

logger = logging.getLogger(__name__)

ARM_BASE = "https://management.azure.com"
_ARM_HOST = "management.azure.com"

#: Every ARM api-version this repo speaks, pinned in one place. A version is a
#: contract: bumping one is a reviewed change, never a silent default.
API_VERSIONS: dict[str, str] = {
    "resources": "2021-04-01",
    "subscriptions": "2022-12-01",
    "managed_identity": "2023-01-31",
    "key_vault": "2023-07-01",
    "storage": "2023-05-01",
    "container_registry": "2023-07-01",
    "cognitive_services": "2024-10-01",
    "container_apps": "2024-03-01",
    "authorization": "2022-04-01",
}

ArmErrorKind = Literal[
    "unauthorized",
    "forbidden",
    "not_found",
    "conflict",
    "throttled",
    "bad_request",
    "server",
    "failed",
    "timeout",
]

_TERMINAL_OK = {"succeeded"}
_TERMINAL_BAD = {"failed", "canceled", "cancelled"}
_DEFAULT_POLL_SECONDS = 5.0
_MAX_POLL_SECONDS = 30.0
_MESSAGE_LIMIT = 300


class ArmError(RuntimeError):
    """A typed ARM refusal. ``code`` is Azure's own error code when it sent one."""

    def __init__(self, kind: ArmErrorKind, *, status: int, code: str, message: str, op: str):
        super().__init__(f"{op}: {kind} ({status} {code}) {message}".strip())
        self.kind: ArmErrorKind = kind
        self.status = status
        self.code = code
        self.message = message
        self.op = op


@dataclass(frozen=True)
class ArmResponse:
    status: int
    body: dict[str, Any] = field(default_factory=dict)
    headers: dict[str, str] = field(default_factory=dict)


def _kind_for(status: int) -> ArmErrorKind:
    if status == 401:
        return "unauthorized"
    if status == 403:
        return "forbidden"
    if status == 404:
        return "not_found"
    if status in (409, 412):
        return "conflict"
    if status == 429:
        return "throttled"
    if 400 <= status < 500:
        return "bad_request"
    return "server"


def _error_detail(body: dict[str, Any]) -> tuple[str, str]:
    error = body.get("error") if isinstance(body, dict) else None
    if not isinstance(error, dict):
        return "", ""
    code = str(error.get("code") or "")
    message = " ".join(str(error.get("message") or "").split())[:_MESSAGE_LIMIT]
    return code, message


def _retry_after(headers: dict[str, str], default: float) -> float:
    raw = headers.get("retry-after") or ""
    try:
        return max(1.0, min(float(raw), _MAX_POLL_SECONDS))
    except ValueError:
        return default


def require_arm_url(url: str) -> str:
    """A URL the token may be sent to: https on the ARM host, nothing else."""
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname != _ARM_HOST:
        raise ArmError(
            "bad_request", status=0, code="UntrustedPollUrl", message=url[:120], op="poll"
        )
    return url


def _url(path: str, api_version: str) -> str:
    if not path.startswith("/") or "?" in path or "://" in path or ".." in path:
        raise ValueError(f"not an ARM resource path: {path[:120]!r}")
    query = urllib.parse.urlencode({"api-version": api_version})
    return f"{ARM_BASE}{urllib.parse.quote(path, safe='/:@')}?{query}"


class ArmClient:
    """One subscription-agnostic ARM session on one bearer token."""

    def __init__(
        self,
        token: Union[str, Callable[[], str]],
        *,
        session: Any = None,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
        lro_timeout_seconds: float = 900.0,
        throttle_retries: int = 4,
    ) -> None:
        self._token = token
        self._session = session
        self._sleep = sleep
        self._clock = clock
        self._lro_timeout = lro_timeout_seconds
        self._throttle_retries = throttle_retries

    def _bearer(self) -> str:
        token = self._token() if callable(self._token) else self._token
        if not token:
            raise ArmError("unauthorized", status=0, code="NoToken", message="", op="token")
        return token

    def _http(self) -> Any:
        if self._session is None:
            import requests  # type: ignore[import-untyped]  # noqa: PLC0415

            self._session = requests.Session()
        return self._session

    def _send(self, method: str, url: str, body: Optional[dict], op: str) -> ArmResponse:
        headers = {"Authorization": f"Bearer {self._bearer()}", "Accept": "application/json"}
        for attempt in range(self._throttle_retries + 1):
            raw = self._http().request(method, url, headers=headers, json=body, timeout=60)
            status = int(raw.status_code)
            lowered = {str(k).lower(): str(v) for k, v in (raw.headers or {}).items()}
            try:
                parsed = raw.json() if getattr(raw, "content", b"") else {}
            except ValueError:
                parsed = {}
            parsed = parsed if isinstance(parsed, dict) else {"value": parsed}
            if status in (429, 503) and attempt < self._throttle_retries:
                self._sleep(_retry_after(lowered, _DEFAULT_POLL_SECONDS * (attempt + 1)))
                continue
            return ArmResponse(status=status, body=parsed, headers=lowered)
        raise AssertionError("unreachable")  # pragma: no cover

    @staticmethod
    def _raise_for(response: ArmResponse, op: str) -> None:
        code, message = _error_detail(response.body)
        kind = _kind_for(response.status)
        logger.info("azure_arm.refused op=%s status=%s code=%s", op, response.status, code)
        raise ArmError(kind, status=response.status, code=code, message=message, op=op)

    def request(
        self,
        method: str,
        path: str,
        *,
        api_version: str,
        body: Optional[dict] = None,
        op: str = "",
    ) -> ArmResponse:
        """One call, no polling. Non-2xx raises a typed ``ArmError``."""
        response = self._send(method, _url(path, api_version), body, op or f"{method} {path}")
        if response.status >= 400:
            self._raise_for(response, op or f"{method} {path}")
        return response

    def get(self, path: str, *, api_version: str, op: str = "") -> dict[str, Any]:
        return self.request("GET", path, api_version=api_version, op=op).body

    def get_or_none(self, path: str, *, api_version: str, op: str = "") -> Optional[dict]:
        try:
            return self.get(path, api_version=api_version, op=op)
        except ArmError as exc:
            if exc.kind == "not_found":
                return None
            raise

    def put(self, path: str, *, api_version: str, body: dict, op: str = "") -> dict[str, Any]:
        """Create-or-update, waiting for a long-running operation to settle."""
        label = op or f"PUT {path}"
        response = self.request("PUT", path, api_version=api_version, body=body, op=label)
        if self.needs_poll(response):
            self.wait(response, label)
            return self.get(path, api_version=api_version, op=label)
        return response.body

    def post(
        self, path: str, *, api_version: str, body: Optional[dict] = None, op: str = ""
    ) -> dict[str, Any]:
        """An ARM action; returns the final operation body when it was asynchronous."""
        label = op or f"POST {path}"
        response = self.request("POST", path, api_version=api_version, body=body, op=label)
        if self.needs_poll(response):
            return self.wait(response, label)
        return response.body

    def delete(self, path: str, *, api_version: str, op: str = "") -> bool:
        """Delete and wait. Returns False when nothing was there (idempotent)."""
        label = op or f"DELETE {path}"
        try:
            response = self.request("DELETE", path, api_version=api_version, op=label)
        except ArmError as exc:
            if exc.kind == "not_found":
                return False
            raise
        if response.status == 204:
            return False
        if self.needs_poll(response):
            self.wait(response, label)
        return True

    @staticmethod
    def needs_poll(response: ArmResponse) -> bool:
        return response.status == 202 or bool(response.headers.get("azure-asyncoperation"))

    def wait(self, response: ArmResponse, op: str) -> dict[str, Any]:
        """Poll ``Azure-AsyncOperation`` (status body) or ``Location`` (202 until done)."""
        async_url = response.headers.get("azure-asyncoperation")
        location = response.headers.get("location")
        if not async_url and not location:
            return response.body
        deadline = self._clock() + self._lro_timeout
        delay = _retry_after(response.headers, _DEFAULT_POLL_SECONDS)
        while True:
            if self._clock() + delay > deadline:
                raise ArmError("timeout", status=0, code="OperationTimeout", message="", op=op)
            self._sleep(delay)
            if async_url:
                polled = self._send("GET", require_arm_url(async_url), None, op)
                if polled.status >= 400:
                    self._raise_for(polled, op)
                status = str(polled.body.get("status") or "").lower()
                if status in _TERMINAL_OK:
                    return polled.body
                if status in _TERMINAL_BAD:
                    code, message = _error_detail(polled.body)
                    raise ArmError(
                        "failed", status=polled.status, code=code, message=message, op=op
                    )
            else:
                polled = self._send("GET", require_arm_url(str(location)), None, op)
                if polled.status >= 400:
                    self._raise_for(polled, op)
                if polled.status != 202:
                    return polled.body
            delay = _retry_after(polled.headers, _DEFAULT_POLL_SECONDS)


__all__ = ["API_VERSIONS", "ARM_BASE", "ArmClient", "ArmError", "ArmResponse", "require_arm_url"]
