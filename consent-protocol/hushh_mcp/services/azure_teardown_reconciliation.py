"""Observe an admitted deletion's original operation; never redispatch DELETE."""

from __future__ import annotations

import hashlib
import hmac
from urllib.parse import unquote, urlsplit

from hushh_mcp.services.azure_arm_client import ArmClient, ArmResponse, require_arm_url
from hushh_mcp.services.azure_teardown_inventory import AzureTeardownRefused, TeardownResource
from hushh_mcp.services.azure_teardown_receipts import (
    TeardownJournal,
    TeardownMutationJournal,
    observed_absence_is_terminal,
    retain,
)


def reconcile_delete(arm: ArmClient, resource: TeardownResource, journal: TeardownJournal) -> dict:
    state = journal.state(resource) or {}
    request = state.get("provider_request")
    if not request or observed_absence_is_terminal(state):
        return state
    journal.assert_admitted()
    ack = state.get("provider_ack") or {}
    if state.get("provider_terminal") or ack.get("requestId") != request.get("requestId"):
        raise AzureTeardownRefused("AZURE_CLEANUP_OUTCOME_UNCERTAIN")
    mutation = TeardownMutationJournal(journal, resource)
    if ack.get("status") == 404:
        if mutation.terminal(request["requestId"], "refused") is not True:
            raise AzureTeardownRefused("AZURE_CLEANUP_RECEIPT_UNCONFIRMED")
    elif ack.get("status") == 204 and not ack.get("operationUrlSha256"):
        if mutation.terminal(request["requestId"], "succeeded") is not True:
            raise AzureTeardownRefused("AZURE_CLEANUP_RECEIPT_UNCONFIRMED")
    else:
        url, kind = ack.get("operationUrl"), ack.get("operationKind")
        digest = ack.get("operationUrlSha256")
        if (
            ack.get("status") not in {200, 201, 202}
            or kind not in {"azure-asyncoperation", "location"}
            or not isinstance(url, str)
            or not isinstance(digest, str)
            or not hmac.compare_digest(hashlib.sha256(url.encode()).hexdigest(), digest)
        ):
            raise AzureTeardownRefused("AZURE_CLEANUP_OUTCOME_UNCERTAIN")
        require_arm_url(url)
        subscription = resource.path.split("/")[2]
        path = urlsplit(url).path
        if not path.startswith(f"/subscriptions/{subscription}/") or any(
            part in {".", ".."} for part in unquote(path).split("/")
        ):
            raise AzureTeardownRefused("AZURE_CLEANUP_OPERATION_CHANGED")
        original = ArmResponse(ack["status"], headers={kind: url}, mutation_id=request["requestId"])
        # Existing wait owns the two header protocols. It records a terminal
        # outcome only from the provider; transient reads never authorize replay.
        arm.with_mutations(mutation).wait(original, "account_cleanup_reconcile")
    state = journal.state(resource) or {}
    if not observed_absence_is_terminal(state):
        raise AzureTeardownRefused("AZURE_CLEANUP_OUTCOME_UNCERTAIN")
    retain(
        journal, resource, "acknowledgement", {"status": "provider_completed", "id": resource.path}
    )
    return journal.state(resource) or {}
