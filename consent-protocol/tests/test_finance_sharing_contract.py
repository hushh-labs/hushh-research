import hashlib
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from pydantic import TypeAdapter, ValidationError

from hushh_mcp.one_adk.consent_continuation import (
    STATE_CONSENT_CONTINUATION,
    ConsentContinuationError,
)
from hushh_mcp.one_adk.finance_share_context import (
    admit_finance_share,
    finance_lifecycle,
    validate_finance_review,
)
from hushh_mcp.services.finance_projection_contract import validate_finance_projection
from hushh_mcp.services.finance_sharing_contract import (
    FinanceAdvisorPolicy,
    FinanceSharePolicy,
    RecipientEnvelope,
    finance_envelope_context,
)

GRANT = "11111111-1111-4111-8111-111111111111"
PROJECTION = {
    "schema": "finance-share-v1",
    "source": "statement",
    "sourcePeriod": None,
    "allocation": [{"name": "Equities", "percent": 80}],
    "commitmentNonce": "1" * 64,
}


def authority(**overrides):
    return {
        "sourceRef": f"finance:{GRANT}:1",
        "recipientUserId": "recipient",
        "senderName": "Owner",
        "revision": 1,
        "contentHash": hashlib.sha256(json.dumps(PROJECTION).encode()).hexdigest(),
        "status": "active",
        "modelProcessingAllowed": True,
        "sections": ["allocation"],
        "showAmounts": False,
        **overrides,
    }


def policy(**overrides):
    return {
        "mode": "snapshot",
        "sections": ["allocation"],
        "selectionHash": "a" * 64,
        "durationSeconds": 3600,
        **overrides,
    }


def test_policy_requires_finite_snapshot_and_strict_independent_model_permission():
    assert FinanceSharePolicy(**policy()).model_processing.allowed is False
    for change in [
        {"durationSeconds": None},
        {"showAmounts": "true"},
        {"model_processing": {"allowed": 1}},
        {"sections": ["allocation", "allocation"]},
        {"extra": "raw"},
    ]:
        with pytest.raises(ValidationError):
            FinanceSharePolicy(**policy(**change))
    assert (
        FinanceSharePolicy(**policy(mode="ongoing", durationSeconds=None)).durationSeconds is None
    )


def test_advisor_policy_requires_complete_finite_non_model_snapshot():
    base = {
        "version": 2,
        "purpose": "verified_ria_review",
        "mode": "snapshot",
        "sections": ["allocation", "performance", "holdings"],
        "selectionHash": "a" * 64,
        "showAmounts": True,
        "model_processing": {"version": 1, "allowed": False},
        "durationSeconds": 3600,
    }
    assert FinanceAdvisorPolicy(**base).durationSeconds == 3600
    assert isinstance(
        TypeAdapter(FinanceSharePolicy | FinanceAdvisorPolicy).validate_python(base),
        FinanceAdvisorPolicy,
    )
    for change in (
        {"durationSeconds": None},
        {"mode": "ongoing"},
        {"showAmounts": False},
        {"model_processing": {"version": 1, "allowed": True}},
        {"sections": ["allocation", "allocation", "holdings"]},
        {"purpose": "other"},
    ):
        with pytest.raises(ValidationError):
            FinanceAdvisorPolicy(**{**base, **change})
    args = {
        "request_id": "request",
        "grant_id": "grant",
        "owner": "owner",
        "recipient": "recipient",
        "revision": 1,
    }
    advisor_context = finance_envelope_context(**args, policy=base)
    legacy = {**base, "version": 1}
    assert advisor_context != finance_envelope_context(**args, policy=legacy)


def test_advisor_authority_fails_closed_on_missing_schema_or_unverified_status(monkeypatch):
    from hushh_mcp.services import finance_sharing_service as sharing
    from hushh_mcp.services.ria_iam_service import _IAM_REQUIRED_TABLES

    state = {"ready": len(_IAM_REQUIRED_TABLES), "status": "verified"}

    def query(_conn, sql, _params=None):
        return (
            {"count": state["ready"]}
            if "pg_catalog.pg_tables" in sql
            else {"status": state["status"]}
        )

    monkeypatch.setattr(sharing, "one", query)
    sharing.require_advisor(None, "advisor")
    state["status"] = "draft"
    with pytest.raises(sharing.FinanceSharingError, match="ADVISOR_NOT_VERIFIED"):
        sharing.require_advisor(None, "advisor")
    state.update(ready=0, status="verified")
    with pytest.raises(sharing.FinanceSharingError, match="SHARE_NOT_READY"):
        sharing.require_advisor(None, "advisor")


def test_envelope_never_accepts_plaintext_or_private_key_fields():
    key = {"kty": "EC", "crv": "P-256", "x": "A" * 43, "y": "A" * 43}
    valid = {
        "algorithm": "ECDH-P256-AES256-GCM",
        "recipientKeyId": "key",
        "ciphertext": "A" * 64,
        "iv": "A" * 16,
        "senderEphemeralPublicKeyJwk": key,
    }
    RecipientEnvelope(**valid)
    for change in [
        {"pan": "secret"},
        {"senderEphemeralPublicKeyJwk": {**key, "d": "secret"}},
        {"ciphertext": '{"balance":999}'},
    ]:
        with pytest.raises(ValidationError):
            RecipientEnvelope(**{**valid, **change})


@pytest.mark.parametrize(
    "change",
    [
        {"account_number": "secret"},
        {"note": "not selected"},
        {
            "allocation": [
                {"name": "Equities", "percent": 80, "amount": {"value": 1000, "currency": "USD"}}
            ]
        },
    ],
)
def test_model_projection_rejects_raw_unselected_or_hidden_amounts(change):
    with pytest.raises((ValidationError, ValueError)):
        validate_finance_projection({**PROJECTION, **change}, ["allocation"], False)


@pytest.mark.parametrize(
    "change",
    [
        {"recipientUserId": "other"},
        {"status": "expired"},
        {"status": "stopped"},
        {"modelProcessingAllowed": False},
        {"revision": 2},
        {"contentHash": "0" * 64},
    ],
)
def test_model_authority_is_exact_and_fails_closed(change):
    payload = {"grantId": GRANT, "revision": 1, "projectionText": json.dumps(PROJECTION)}
    checked = json.loads(validate_finance_review(payload, authority(), "recipient"))
    assert "commitmentNonce" not in checked
    assert checked["allocation"] == PROJECTION["allocation"]
    with pytest.raises(ValueError):
        validate_finance_review(payload, authority(**change), "recipient")


def test_model_review_rejects_an_unsalted_projection_even_when_its_digest_matches():
    unsalted = {key: value for key, value in PROJECTION.items() if key != "commitmentNonce"}
    text = json.dumps(unsalted)
    with pytest.raises(ValidationError):
        validate_finance_review(
            {"grantId": GRANT, "revision": 1, "projectionText": text},
            authority(contentHash=hashlib.sha256(text.encode()).hexdigest()),
            "recipient",
        )


@pytest.mark.asyncio
async def test_model_review_requires_explicit_intent_and_stores_only_a_transient_secret_reference():
    payload = {"grantId": GRANT, "revision": 1, "projectionText": json.dumps(PROJECTION)}
    lookup = AsyncMock(return_value=authority())
    with pytest.raises(ConsentContinuationError):
        await admit_finance_share(
            {"financeShare": payload},
            owner_id="recipient",
            messages=[SimpleNamespace(role="user", content="Hi")],
            lookup=lookup,
        )
    lookup.assert_not_called()
    state = await admit_finance_share(
        {"financeShare": payload},
        owner_id="recipient",
        messages=[SimpleNamespace(role="user", content="Review shared Finance")],
        lookup=lookup,
    )
    assert state[STATE_CONSENT_CONTINUATION]["kind"] == "finance"
    assert json.dumps(PROJECTION) not in json.dumps(state)
    assert finance_lifecycle(authority(status="expired"))["progress"]["outcome"] == "expired"
