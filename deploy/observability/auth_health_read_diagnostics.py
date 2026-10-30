# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Closed, content-free diagnostics for auth-health HTTP reads."""

import http.client
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
