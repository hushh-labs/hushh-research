"""Secret-free ARM receipts inside the existing owner erasure record."""

from __future__ import annotations

from copy import deepcopy
from typing import Protocol

from hushh_mcp.services.azure_arm_mutations import (
    ArmMutationAcknowledgement,
    ArmMutationOutcome,
    ArmMutationRequest,
)
from hushh_mcp.services.azure_teardown_inventory import AzureTeardownRefused, TeardownResource


class TeardownJournal(Protocol):
    def state(self, resource: TeardownResource) -> dict | None: ...
    def retain(self, resource: TeardownResource, stage: str, receipt: dict) -> bool: ...
    def assert_admitted(self) -> None: ...
    def assert_parent_approved(self, resource: TeardownResource) -> None: ...
    def assert_group_approved(self) -> None: ...
    def retain_final_readback(self, resource_ids: tuple[str, ...]) -> bool: ...


def retain(journal: TeardownJournal, resource: TeardownResource, stage: str, receipt: dict) -> None:
    if journal.retain(resource, stage, receipt) is not True:
        raise AzureTeardownRefused("AZURE_CLEANUP_RECEIPT_UNCONFIRMED")


def can_retry(state: dict) -> bool:
    outcome = state.get("provider_terminal", {}).get("outcome")
    return outcome == "not_dispatched" or (
        outcome == "refused"
        and state.get("provider_ack", {}).get("status") in {400, 401, 403, 405, 412, 422, 429}
    )


def observed_absence_is_terminal(state: dict) -> bool:
    return (
        not state.get("provider_request")
        or can_retry(state)
        or state.get("provider_terminal", {}).get("outcome") == "succeeded"
        or (
            state.get("provider_terminal", {}).get("outcome") == "refused"
            and state.get("provider_ack", {}).get("status") == 404
        )
    )


def prepare_stage(state: dict, stage: str, receipt: dict) -> dict:
    """Prepare a monotonic resource update; SQL independently authorizes it."""
    next_state = deepcopy(state)
    if stage == "retry":
        if (
            receipt
            or not can_retry(state)
            or state.get("absence")
            or len(state.get("providerHistory", [])) >= 8
        ):
            raise AzureTeardownRefused("AZURE_CLEANUP_RETRY_UNQUALIFIED")
        previous = {
            key: next_state.pop(key)
            for key in ("provider_request", "provider_ack", "provider_terminal")
            if key in next_state
        }
        next_state.setdefault("providerHistory", []).append(previous)
    elif stage not in state:
        next_state[stage] = deepcopy(receipt)
    elif state[stage] != receipt:
        raise AzureTeardownRefused("AZURE_CLEANUP_RECEIPT_CHANGED")
    return next_state


class TeardownMutationJournal:
    """One DELETE, including its provider acknowledgement and settlement.

    The executor uses a no-mutation-retry ARM client. A lost acknowledgement is
    unresolved even when a resource temporarily answers404; no absence receipt
    can substitute for provider settlement.
    """

    def __init__(self, journal: TeardownJournal, resource: TeardownResource) -> None:
        self._journal, self._resource = journal, resource

    def admit(self, request_id: str, request: ArmMutationRequest) -> bool:
        if (
            request.body_sha256 is not None
            or request.method != "DELETE"
            or request.path != self._resource.path
            or request.api_version != self._resource.api_version
            or (self._journal.state(self._resource) or {}).get("provider_request") is not None
        ):
            return False
        self._journal.assert_admitted()
        return (
            self._journal.retain(
                self._resource,
                "provider_request",
                {
                    "requestId": request_id,
                    "method": request.method,
                    "path": request.path,
                    "apiVersion": request.api_version,
                },
            )
            is True
        )

    def _matches(self, request_id: str) -> bool:
        return bool(
            (self._journal.state(self._resource) or {}).get("provider_request", {}).get("requestId")
            == request_id
        )

    def acknowledge(self, request_id: str, receipt: ArmMutationAcknowledgement) -> bool:
        return (
            self._matches(request_id)
            and self._journal.retain(
                self._resource,
                "provider_ack",
                {
                    "requestId": request_id,
                    "status": receipt.status,
                    "operationUrl": receipt.operation_url,
                    "operationUrlSha256": receipt.operation_url_sha256,
                    **({"operationKind": receipt.operation_kind} if receipt.operation_kind else {}),
                },
            )
            is True
        )

    def terminal(self, request_id: str, outcome: ArmMutationOutcome) -> bool:
        return (
            self._matches(request_id)
            and self._journal.retain(
                self._resource, "provider_terminal", {"requestId": request_id, "outcome": outcome}
            )
            is True
        )
