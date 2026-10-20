"""Secret-free mutation receipts for the existing Azure owner operation.

The storage adapter owns durable admission. This port never receives request
bodies, credentials or provider response bodies. Missing acknowledgement or
terminal evidence leaves an operation unresolved; it does not permit replay.
"""

from __future__ import annotations

import hashlib
import json
import re
import urllib.parse
import uuid
from collections.abc import Callable
from copy import deepcopy
from dataclasses import dataclass
from typing import Literal, NoReturn, Protocol

ArmMutationOutcome = Literal["succeeded", "refused", "failed", "not_dispatched"]


@dataclass(frozen=True)
class ArmMutationRequest:
    method: str
    path: str
    api_version: str
    purpose: str
    body_sha256: str | None = None


def body_commitment(body: dict) -> str:
    """Commit the complete JSON value; retain no script, credential or body in receipts."""
    encoded = json.dumps(body, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    return hashlib.sha256(encoded).hexdigest()


def bound_body(
    method: str, body: dict | None, expected: str | None, *, refuse: Callable[[str], NoReturn]
) -> dict | None:
    """Freeze the approved JSON before token acquisition and asynchronous guards."""
    if expected is None:
        return body  # Preserve legacy secret-bearing request behavior.
    try:
        frozen = deepcopy(body)
        if (
            method in {"GET", "HEAD"}
            or not isinstance(frozen, dict)
            or body_commitment(frozen) != expected
        ):
            refuse("MutationBodyChanged")
        return frozen
    except (TypeError, ValueError, RecursionError):
        refuse("MutationBodyChanged")


@dataclass(frozen=True)
class ArmMutationAcknowledgement:
    status: int
    operation_url: str | None
    operation_url_sha256: str | None
    operation_kind: Literal["azure-asyncoperation", "location"] | None = None


class ArmMutationJournal(Protocol):
    def admit(self, request_id: str, request: ArmMutationRequest) -> bool: ...

    def acknowledge(self, request_id: str, receipt: ArmMutationAcknowledgement) -> bool: ...

    def terminal(self, request_id: str, outcome: ArmMutationOutcome) -> bool: ...


class ArmMutationRecorder:
    """Compose a durable journal with the transport's URL and failure contracts."""

    def __init__(
        self,
        journal: ArmMutationJournal | None,
        *,
        validate_url: Callable[[str], str],
        refuse: Callable[[str], NoReturn],
    ) -> None:
        self._journal = journal
        self._validate_url = validate_url
        self._refuse = refuse

    def admit(self, request: ArmMutationRequest) -> str:
        if self._journal is None:
            return ""
        request_id = str(uuid.uuid4())
        if self._journal.admit(request_id, request) is not True:
            self._refuse("MutationAdmissionUnconfirmed")
        return request_id

    def acknowledge(
        self,
        request_id: str,
        status: int,
        operation_url: str | None,
        *,
        operation_kind: Literal["azure-asyncoperation", "location"] | None = None,
    ) -> None:
        if not request_id:
            return
        digest = hashlib.sha256(operation_url.encode()).hexdigest() if operation_url else None
        if operation_url:
            self._validate_url(operation_url)
            parsed = urllib.parse.urlsplit(operation_url)
            pairs = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
            safe = all(
                (key == "api-version" and re.fullmatch(r"\d{4}-\d{2}-\d{2}(?:-preview)?", value))
                or (key == "monitor" and value == "true")
                for key, value in pairs
            )
            if not safe or len({key for key, _ in pairs}) != len(pairs):
                operation_url = None
        receipt = ArmMutationAcknowledgement(status, operation_url, digest, operation_kind)
        if self._journal is None or self._journal.acknowledge(request_id, receipt) is not True:
            self._refuse("MutationAcknowledgementUnconfirmed")

    def terminal(self, request_id: str, outcome: ArmMutationOutcome) -> None:
        if request_id and (
            self._journal is None or self._journal.terminal(request_id, outcome) is not True
        ):
            self._refuse("MutationTerminalUnconfirmed")
