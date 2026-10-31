# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Closed, content-free diagnostics for auth-health HTTP reads."""

import http.client
import json
import socket
import ssl
import urllib.error
from enum import Enum

from process_group import BoundedReadError


class HealthCommandStage(str, Enum):
    OPERATION = "operation"
    LEASE_CLAIM = "lease_claim"
    LEASE_READ = "lease_read"
    LEASE_RELEASE = "lease_release"
    PROTECTED_LIST_CHECK = "protected_list_check"


class BoundedFailureReason(str, Enum):
    ARGUMENTS = "arguments"
    TIMEOUT = "timeout"
    READ = "read"
    SIZE = "size"
    EXIT = "exit"
    CLEANUP = "cleanup"
    UNCLASSIFIED = "unclassified"


class HealthOutcomeStatus(str, Enum):
    HEALTHY = "healthy"
    FAILED = "failed"
    UNAVAILABLE = "unavailable"


class HealthOutcomeReason(str, Enum):
    VERSION_LIST_UNAVAILABLE = "version_list_unavailable"
    CURRENT_VERSION_UNAVAILABLE = "current_version_unavailable"
    PREVIOUS_VERSION_UNAVAILABLE = "previous_version_unavailable"
    PROTECTED_LIST_FAILED = "protected_list_failed"
    PHONE_LIST_UNCONFIGURED = "phone_list_unconfigured"
    PHONE_RUNTIME_UNAVAILABLE = "phone_runtime_unavailable"
    HEALTH_PUBLICATION_UNAVAILABLE = "health_publication_unavailable"


class HealthRuntimeStatus(str, Enum):
    HEALTHY = "healthy"
    UNAVAILABLE = "unavailable"
    NOT_REQUESTED = "not_requested"


class HealthCommandFailure(BoundedReadError):
    def __init__(
        self,
        stage: HealthCommandStage,
        reason: BoundedFailureReason,
        *,
        exitcode: int | None = None,
        http_status: int | None = None,
        diagnostic: tuple[str, str, str | None] | None = None,
    ):
        super().__init__(reason.value, exitcode=exitcode)
        self.stage = stage
        self.reason = reason
        self.http_status = (
            http_status
            if type(http_status) is int and 100 <= http_status <= 599
            else None
        )
        self.diagnostic = diagnostic

_READ_STEPS = frozenset(
    {"metadata_identity", "metadata_token", "storage_generation", "storage_lease_body", "storage_range"}
)
_FAILURE_KINDS = frozenset(
    {"transport", "body_read", "range_validation", "json_parse", "http_status"}
)

_HEALTH_OUTCOME_FIELDS = frozenset(
    {"status", "reason_codes", "checked_lists", "runtime_status"}
)


def validate_health_outcome(value: object) -> dict:
    """Accept only the checker's fixed, content-free result contract."""
    if not isinstance(value, dict) or set(value) != _HEALTH_OUTCOME_FIELDS:
        raise ValueError("Invalid auth health outcome")
    status = value.get("status")
    reason_codes = value.get("reason_codes")
    checked_lists = value.get("checked_lists")
    runtime_status = value.get("runtime_status")
    allowed_reasons = {item.value for item in HealthOutcomeReason}
    if (
        not isinstance(status, str)
        or status not in {item.value for item in HealthOutcomeStatus}
        or not isinstance(reason_codes, list)
        or len(reason_codes) > len(HealthOutcomeReason)
        or any(
            not isinstance(item, str) or item not in allowed_reasons
            for item in reason_codes
        )
        or reason_codes != sorted(set(reason_codes))
        or type(checked_lists) is not int
        or not 0 <= checked_lists <= 32
        or not isinstance(runtime_status, str)
        or runtime_status not in {item.value for item in HealthRuntimeStatus}
    ):
        raise ValueError("Invalid auth health outcome")
    if status == HealthOutcomeStatus.HEALTHY.value:
        if reason_codes or runtime_status == HealthRuntimeStatus.UNAVAILABLE.value:
            raise ValueError("Invalid auth health outcome")
    elif status == HealthOutcomeStatus.FAILED.value:
        if HealthOutcomeReason.PROTECTED_LIST_FAILED.value not in reason_codes:
            raise ValueError("Invalid auth health outcome")
    elif (
        not reason_codes
        or HealthOutcomeReason.PROTECTED_LIST_FAILED.value in reason_codes
    ):
        raise ValueError("Invalid auth health outcome")
    reason_set = set(reason_codes)
    runtime_unavailable = (
        HealthOutcomeReason.PHONE_RUNTIME_UNAVAILABLE.value in reason_set
    )
    if (runtime_status == HealthRuntimeStatus.UNAVAILABLE.value) != runtime_unavailable:
        raise ValueError("Invalid auth health outcome")
    if (
        HealthOutcomeReason.PHONE_LIST_UNCONFIGURED.value in reason_set
        and checked_lists != 0
    ):
        raise ValueError("Invalid auth health outcome")
    return {
        "status": status,
        "reason_codes": reason_codes,
        "checked_lists": checked_lists,
        "runtime_status": runtime_status,
    }


def parse_health_outcome(raw: bytes) -> dict:
    """Parse a bounded JSON result without retaining arbitrary child output."""
    if type(raw) is not bytes or not 1 <= len(raw) <= 2048:
        raise ValueError("Invalid auth health outcome")
    try:
        payload = json.loads(raw)
    except (UnicodeDecodeError, ValueError, TypeError):
        raise ValueError("Invalid auth health outcome") from None
    return validate_health_outcome(payload)


def summarize_health_outcome(raw: bytes) -> tuple[int, str]:
    """Map a checked result to a fixed job exit code and content-free log line."""
    outcome = parse_health_outcome(raw)
    message = (
        f"Auth health check; status={outcome['status']}; "
        f"checked_lists={outcome['checked_lists']}; "
        f"runtime_status={outcome['runtime_status']}"
    )
    if outcome["reason_codes"]:
        message += f"; reason_codes={','.join(outcome['reason_codes'])}"
    return (
        {"healthy": 0, "failed": 1, "unavailable": 2}[outcome["status"]],
        message,
    )


def read_diagnostic(step: str | None, kind: str, error: BaseException | None = None):
    if step not in _READ_STEPS or kind not in _FAILURE_KINDS:
        return None
    exception_type = None
    if error is not None:
        if isinstance(error, urllib.error.URLError):
            error = error.reason
        if isinstance(error, socket.gaierror):
            exception_type = "dns"
        elif isinstance(error, ssl.SSLError):
            exception_type = "tls"
        elif isinstance(error, TimeoutError):
            exception_type = "timeout"
        elif isinstance(error, http.client.HTTPException):
            exception_type = "protocol"
        elif isinstance(error, ConnectionError):
            exception_type = "connection"
        else:
            exception_type = "other"
    return step, kind, exception_type
