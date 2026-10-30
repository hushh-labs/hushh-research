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

import copy
import logging
import time
import urllib.parse
from dataclasses import dataclass, field, replace
from typing import Any, Callable, Literal, NoReturn, Optional, Union

from hushh_mcp.services.azure_arm_mutations import (
    ArmMutationJournal,
    ArmMutationRecorder,
    ArmMutationRequest,
    bound_body,
)

logger = logging.getLogger(__name__)

ARM_BASE = "https://management.azure.com"
_ARM_HOST = "management.azure.com"

#: Every ARM api-version this repo speaks, pinned in one place. A version is a
#: contract: bumping one is a reviewed change, never a silent default.
API_VERSIONS: dict[str, str] = {
    "resources": "2021-04-01",
    "tags": "2021-04-01",
    "subscriptions": "2022-12-01",
    "managed_identity": "2023-01-31",
    "key_vault": "2023-07-01",
    "storage": "2023-05-01",
    "container_registry": "2023-07-01",
    "cognitive_services": "2024-10-01",
    # Stable schema with CustomScaleRule.identity for secretless Files queue wake.
    "container_apps": "2025-01-01",
    "virtual_machines": "2024-03-01",
    "network": "2024-05-01",
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

#: Refusals Azure gives while something it just created is still settling. Each one
#: clears within a minute or two; failing the person's setup on it was a bug
#: (``VaultRegisteringDns`` on the key, right after the vault was created, measured
#: 2026-10-04 on the first live Connect Azure).
TRANSIENT_CODES = frozenset(
    {
        "VaultRegisteringDns",  # a new Key Vault's name is not resolvable yet
        "AnotherOperationInProgress",  # the same resource is mid-update
    }
)
# ``PrincipalNotFound`` is not here: the applier already retries role assignments on
# its own schedule while a new identity replicates, and two loops would compound.
_TRANSIENT_WAIT_SECONDS = 10.0

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
    mutation_id: str = ""


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
    try:
        parsed = urllib.parse.urlsplit(url)
        trusted = (
            parsed.scheme == "https"
            and parsed.hostname == _ARM_HOST
            and parsed.port in (None, 443)
            and parsed.username is None
            and parsed.password is None
            and not parsed.fragment
            and len(url) <= 16_384
            and not any(ord(c) < 32 or ord(c) == 127 for c in url)
        )
    except ValueError:
        trusted = False
    if not trusted:
        raise ArmError(
            "bad_request",
            status=0,
            code="UntrustedPollUrl",
            message="Operation URL is not permitted.",
            op="poll",
        )
    return url


def _url(path: str, api_version: str) -> str:
    if not path.startswith("/") or "?" in path or "://" in path or ".." in path:
        raise ValueError(f"not an ARM resource path: {path[:120]!r}")
    query = urllib.parse.urlencode({"api-version": api_version})
    return f"{ARM_BASE}{urllib.parse.quote(path, safe='/:@')}?{query}"


def _mutation_refused(code: str) -> NoReturn:
    raise ArmError("timeout", status=0, code=code, message="", op="receipt")


def _provisioning_state(body: dict[str, Any]) -> str:
    properties = body.get("properties")
    if properties is not None and not isinstance(properties, dict):
        raise ArmError("failed", status=0, code="InvalidOperationBody", message="", op="poll")
    state = (properties or {}).get("provisioningState")
    if state is not None and not isinstance(state, str):
        raise ArmError("failed", status=0, code="InvalidOperationBody", message="", op="poll")
    return (state or "").lower()


def _operation_state(body: dict[str, Any]) -> str:
    state = _provisioning_state(body)
    status = body.get("status")
    if status is None:
        return state
    if not isinstance(status, str):
        raise ArmError("failed", status=0, code="InvalidOperationBody", message="", op="poll")
    status = status.lower()
    if status not in _TERMINAL_OK | _TERMINAL_BAD | {"running", "inprogress", "accepted"}:
        raise ArmError("timeout", status=0, code="OperationUnconfirmed", message="", op="poll")
    if status in _TERMINAL_BAD:
        return status
    return state if status in _TERMINAL_OK else status


def _location_finished(response: ArmResponse) -> bool:
    state = _operation_state(response.body)
    return response.status in (200, 204) and (not state or state in _TERMINAL_OK | _TERMINAL_BAD)


def _finished_body(
    response: ArmResponse, op: str, mutations: ArmMutationRecorder
) -> dict[str, Any]:
    state = _operation_state(response.body)
    if state in _TERMINAL_BAD:
        mutations.terminal(response.mutation_id, "failed")
        raise ArmError("failed", status=response.status, code="OperationFailed", message="", op=op)
    if state and state not in _TERMINAL_OK:
        raise ArmError(
            "timeout", status=response.status, code="OperationUnconfirmed", message="", op=op
        )
    mutations.terminal(response.mutation_id, "succeeded")
    return response.body


def _parse_response(raw: Any, method: str) -> ArmResponse:
    if 300 <= int(raw.status_code) < 400:
        raise ArmError(
            "bad_request",
            status=int(raw.status_code),
            code="UnsafeRedirect",
            message="ARM redirects are not permitted.",
            op=method,
        )
    lowered = {str(k).lower(): str(v) for k, v in (raw.headers or {}).items()}
    try:
        parsed = raw.json() if getattr(raw, "content", b"") else {}
    except ValueError as exc:
        raise ArmError(
            "failed",
            status=int(raw.status_code),
            code="InvalidOperationBody",
            message="",
            op=method,
        ) from exc
    if not isinstance(parsed, dict):
        raise ArmError(
            "failed",
            status=int(raw.status_code),
            code="InvalidOperationBody",
            message="",
            op=method,
        )
    return ArmResponse(status=int(raw.status_code), body=parsed, headers=lowered)


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
        transient_retries: int = 12,
        before_write: Callable[[], None] | None = None,
        mutations: ArmMutationJournal | None = None,
    ) -> None:
        self._token = token
        self._session = session
        self._owns_session = session is None
        self._request_budget: Callable[[], float] = lambda: 60.0
        self._sleep = sleep
        self._clock = clock
        self._lro_timeout = lro_timeout_seconds
        self._throttle_retries = throttle_retries
        self._transient_retries = transient_retries
        self._before_write = before_write
        self._mutations = ArmMutationRecorder(
            mutations, validate_url=require_arm_url, refuse=_mutation_refused
        )

    def with_write_guard(self, guard: Callable[[], None]) -> ArmClient:
        """Narrow this operation's writes without mutating a shared client."""
        fenced = self._fork()
        previous = self._before_write

        def check() -> None:
            if previous is not None:
                previous()
            # The narrower operation's check is closest to dispatch. Inherited
            # checks may perform I/O and cannot run after a final idle/lease fence.
            guard()

        fenced._before_write = check
        return fenced

    def with_mutations(self, journal: ArmMutationJournal) -> ArmClient:
        """Bind one cleanup request to its durable transport receipts.

        Cleanup reconciles refused or uncertain requests before another dispatch;
        it must not hide a second mutation behind a transport retry.
        """
        recorded = self._fork()
        recorded._mutations = ArmMutationRecorder(
            journal, validate_url=require_arm_url, refuse=_mutation_refused
        )
        recorded._throttle_retries = recorded._transient_retries = 0
        return recorded

    def _fork(self) -> ArmClient:
        derived = copy.copy(self)
        # An already open pool remains owned by the client that opened it.
        # A derived client owns only a pool it subsequently creates itself.
        if self._session is not None:
            derived._owns_session = False
        return derived

    def with_request_budget(self, remaining: Callable[[], float]) -> ArmClient:
        """Bound each provider request by the enclosing operation's remaining time."""
        bounded = self._fork()
        bounded._request_budget = remaining
        return bounded

    def _http(self) -> Any:
        if self._session is None:
            import requests  # type: ignore[import-untyped]  # noqa: PLC0415

            self._session = requests.Session()
        return self._session

    def close(self) -> None:
        """Release an internally created HTTP pool; borrowed sessions stay owned by callers."""
        if self._owns_session and self._session is not None:
            self._session.close()
            self._session = None

    def _send(
        self,
        method: str,
        url: str,
        body: Optional[dict],
        op: str,
        mutation: ArmMutationRequest | None = None,
    ) -> ArmResponse:
        token = self._token() if callable(self._token) else self._token
        if not token:
            raise ArmError("unauthorized", status=0, code="NoToken", message="", op="token")
        headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
        throttled = settling = 0
        while True:
            mutation_id = self._mutations.admit(mutation) if mutation is not None else ""
            if mutation_id:
                headers["x-ms-client-request-id"] = mutation_id
            if method not in ("GET", "HEAD") and self._before_write is not None:
                try:
                    self._before_write()
                except Exception:
                    self._mutations.terminal(mutation_id, "not_dispatched")
                    raise
            response = self._send_once(method, url, headers, body)
            if mutation_id:
                self._mutations.acknowledge(
                    mutation_id,
                    response.status,
                    response.headers.get("azure-asyncoperation")
                    or response.headers.get("location"),
                    operation_kind=(
                        "azure-asyncoperation"
                        if response.headers.get("azure-asyncoperation")
                        else "location"
                        if response.headers.get("location")
                        else None
                    ),
                )
                response = replace(response, mutation_id=mutation_id)
            if (
                response.status == 429 or (response.status == 503 and mutation is None)
            ) and throttled < self._throttle_retries:
                if response.status == 429:
                    self._mutations.terminal(mutation_id, "refused")
                # A dispatched write with 503 is uncertain: never replay it here.
                throttled += 1
                self._sleep(_retry_after(response.headers, _DEFAULT_POLL_SECONDS * throttled))
                continue
            code, _ = _error_detail(response.body)
            if (
                response.status in (400, 404, 409)
                and code in TRANSIENT_CODES
                and settling < self._transient_retries
            ):
                self._mutations.terminal(mutation_id, "refused")
                settling += 1
                logger.info("azure_arm.settling op=%s code=%s attempt=%s", op, code, settling)
                self._sleep(_TRANSIENT_WAIT_SECONDS)
                continue
            return response

    def _send_once(
        self, method: str, url: str, headers: dict[str, str], body: Optional[dict]
    ) -> ArmResponse:
        # Evaluate after token acquisition and the final authority guard. A slow
        # read or expired lease must not dispatch a later mutation.
        timeout = min(60.0, self._request_budget())
        if timeout <= 0:
            _mutation_refused("OperationDeadlineExpired")
        raw = self._http().request(
            method, url, headers=headers, json=body, timeout=timeout, allow_redirects=False
        )
        return _parse_response(raw, method)

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
        body_sha256: str | None = None,
    ) -> ArmResponse:
        """One call, no polling. Non-2xx raises a typed ``ArmError``."""
        label = op or f"{method} {path}"
        url = _url(path, api_version)
        body = bound_body(method, body, body_sha256, refuse=_mutation_refused)
        mutation = (
            ArmMutationRequest(method, path, api_version, label, body_sha256)
            if method not in ("GET", "HEAD")
            else None
        )
        response = self._send(method, url, body, label, mutation)
        if response.status >= 400:
            if response.status in (400, 401, 403, 404, 405, 412, 422, 429) or (
                response.status == 409 and _error_detail(response.body)[0] == "RoleAssignmentExists"
            ):
                self._mutations.terminal(response.mutation_id, "refused")
            self._raise_for(response, label)
        if mutation is not None and not self.needs_poll(response):
            _finished_body(response, label, self._mutations)
            response = replace(response, mutation_id="")  # already settled, including raw callers
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

    def put(
        self,
        path: str,
        *,
        api_version: str,
        body: dict,
        op: str = "",
        body_sha256: str | None = None,
    ) -> dict[str, Any]:
        """Create-or-update, waiting for a long-running operation to settle."""
        label = op or f"PUT {path}"
        response = self.request(
            "PUT", path, api_version=api_version, body=body, op=label, body_sha256=body_sha256
        )
        if self.needs_poll(response):
            self.wait(response, label)
            return _finished_body(
                ArmResponse(200, self.get(path, api_version=api_version, op=label)),
                label,
                self._mutations,
            )
        return _finished_body(response, label, self._mutations)

    def post(
        self,
        path: str,
        *,
        api_version: str,
        body: Optional[dict] = None,
        op: str = "",
        body_sha256: str | None = None,
    ) -> dict[str, Any]:
        """An ARM action; returns the final operation body when it was asynchronous."""
        label = op or f"POST {path}"
        response = self.request(
            "POST", path, api_version=api_version, body=body, op=label, body_sha256=body_sha256
        )
        if self.needs_poll(response):
            return self.wait(response, label)
        return _finished_body(response, label, self._mutations)

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
            self._mutations.terminal(response.mutation_id, "succeeded")
            return False
        if self.needs_poll(response):
            self.wait(response, label)
        else:
            _finished_body(response, label, self._mutations)
        return True

    @staticmethod
    def needs_poll(response: ArmResponse) -> bool:
        state = _operation_state(response.body)
        return (
            response.status == 202
            or bool(response.headers.get("azure-asyncoperation"))
            or bool(response.headers.get("location"))
            or bool(state and state not in _TERMINAL_OK | _TERMINAL_BAD)
        )

    def confirm_observed_mutation(self, response: ArmResponse, *, succeeded: bool) -> None:
        """Settle the original dispatch after exact owning-resource verification.

        This does not perform verification. Only the owning lifecycle may call it
        after proving that dispatch's incarnation, revision and immutable image.
        An unknown or timed-out observation must leave the receipt unresolved.
        """
        self._mutations.terminal(response.mutation_id, "succeeded" if succeeded else "failed")

    def wait(self, response: ArmResponse, op: str) -> dict[str, Any]:
        """Poll ``Azure-AsyncOperation`` (status body) or ``Location`` (202 until done)."""
        async_url = response.headers.get("azure-asyncoperation")
        location = response.headers.get("location")
        if not async_url and not location:
            raise ArmError(
                "timeout",
                status=response.status,
                code="OperationReferenceMissing",
                message="",
                op=op,
            )
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
                    self._mutations.terminal(response.mutation_id, "succeeded")
                    return polled.body
                if status in _TERMINAL_BAD:
                    self._mutations.terminal(response.mutation_id, "failed")
                    code, message = _error_detail(polled.body)
                    raise ArmError(
                        "failed", status=polled.status, code=code, message=message, op=op
                    )
            else:
                polled = self._send("GET", require_arm_url(str(location)), None, op)
                if polled.status >= 400:
                    self._raise_for(polled, op)
                if polled.status != 202 and _location_finished(polled):
                    return _finished_body(
                        replace(polled, mutation_id=response.mutation_id), op, self._mutations
                    )
            delay = _retry_after(polled.headers, _DEFAULT_POLL_SECONDS)


__all__ = ["API_VERSIONS", "ARM_BASE", "ArmClient", "ArmError", "ArmResponse", "require_arm_url"]
