"""The transient selection must exactly match the user's confirmation."""

import hashlib
import json
from copy import deepcopy

import pytest
from pydantic import ValidationError

from hushh_mcp.services import location_command_audience_receipts as audience
from hushh_mcp.services.action_directive_ledger import (
    ActionDirectiveAuthorityError,
    ActionDirectiveStore,
)
from hushh_mcp.services.location_command_membership_receipts import MembershipPreparation


def prepared(value):
    wire = json.dumps(value, sort_keys=True, separators=(",", ":"))
    nonce = "a" * 64
    return MembershipPreparation(nonce=nonce, binding_json=wire), hashlib.sha256(
        f"{nonce}:{wire}".encode()
    ).hexdigest()


def binding():
    return {
        "owner": "owner",
        "recipientIds": ["person"],
        "people": [{"id": "person", "name": "A person", "keyId": "key", "ready": True}],
        "duration": "2",
        "message": "Meet here",
        "replacements": [],
        "sourceCircleByRecipient": {},
    }


@pytest.mark.parametrize(
    "change",
    [
        "array",
        "object_id",
        "duplicate",
        "missing",
        "owner",
        "self",
        "unready",
        "no_key",
        "duration",
        "extra_scope",
        "coordinates",
        "extra_person",
    ],
)
def test_bad_selection_is_bounded_validation_error(change, monkeypatch):
    monkeypatch.setattr(
        audience, "ActionDirectiveStore", lambda: ActionDirectiveStore(hmac_key="fixture")
    )
    value = binding()
    if change == "array":
        value = []
    if change == "object_id":
        value["recipientIds"] = [{}]
    if change == "duplicate":
        value["people"] *= 2
    if change == "missing":
        value["recipientIds"] = ["different"]
    if change == "owner":
        value["owner"] = "other"
    if change == "self":
        value["recipientIds"] = ["owner"]
        value["people"][0]["id"] = "owner"
    if change == "unready":
        value["people"][0]["ready"] = False
    if change == "no_key":
        value["people"][0]["keyId"] = None
    if change == "duration":
        value["duration"] = "NaN"
    if change == "extra_scope":
        value["sourceCircleByRecipient"] = {"unreviewed": None}
    if change == "coordinates":
        value["point"] = {"latitude": 0, "longitude": 0}
    if change == "extra_person":
        value["people"].append({**value["people"][0], "id": "extra"})
    preparation, digest = prepared(value)
    with pytest.raises((ValidationError, ActionDirectiveAuthorityError)):
        audience.prepare_audience_plan(
            preparation, action="location.share_selected", owner="owner", binding_digest=digest
        )


def test_terms_use_exact_action_kind_and_confirmation_commitment(monkeypatch):
    store = ActionDirectiveStore(hmac_key="fixture")
    monkeypatch.setattr(audience, "ActionDirectiveStore", lambda: store)
    selection = binding()
    prep, digest = prepared(selection)
    plan = audience.prepare_audience_plan(
        prep, action="location.share_selected", owner="owner", binding_digest=digest
    )
    assert list(plan) == [store._hmac("person")]
    assert "Meet here" not in repr(plan) and "A person" not in repr(plan)
    changed = deepcopy(selection)
    changed["duration"] = "4"
    with pytest.raises(ActionDirectiveAuthorityError):
        audience.prepare_audience_plan(
            prepared(changed)[0],
            action="location.share_selected",
            owner="owner",
            binding_digest=digest,
        )
    check_in = audience.prepare_audience_plan(
        prep, action="location.send_check_in", owner="owner", binding_digest=digest
    )
    assert check_in != plan
