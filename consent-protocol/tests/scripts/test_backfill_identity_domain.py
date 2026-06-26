"""Tests for the bespoke identity-domain backfill (Wave 4 / D-14).

Covers detection (positive/negative), the single-move plan for the phase-01
mis-stored address, dry-run = zero writes, idempotent second run = zero moves,
and the SSN-skip invariant. The PKM service and the domain reader are mocked so
no live DB or encryption is touched.
"""

from __future__ import annotations

from typing import Any, Optional

import pytest

from hushh_mcp.services.domain_inferrer import DomainInferrer
from scripts.backfill_identity_domain import (
    DEST_DOMAIN,
    _detect_identity_entities,
    _is_identity_field,
    _is_ssn_field,
    plan_moves,
    run_backfill_for_user,
)

USER_ID = "user-test-001"


class _RecordingPKMService:
    """Captures record_mutation_event calls without persisting anything."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def record_mutation_event(self, **kwargs: Any) -> bool:
        self.calls.append(kwargs)
        return True


def _make_reader(state: dict[str, dict[str, Any]]):
    """Build a DomainReader over an in-memory {domain: payload} mapping."""

    async def _reader(user_id: str, domain: str) -> Optional[dict[str, Any]]:
        payload = state.get(domain)
        return dict(payload) if isinstance(payload, dict) else None

    return _reader


# ---------------------------------------------------------------------------
# Detection: positive / negative
# ---------------------------------------------------------------------------


def test_detect_classifies_identity_fields_positive():
    inferrer = DomainInferrer()
    payload = {
        "address": "123 Main St",
        "full_name": "Jane Doe",
        "date_of_birth": "1990-01-01",
        "schema_version": 3,
    }
    detected = dict(_detect_identity_entities("financial", payload, inferrer=inferrer))
    assert set(detected.keys()) == {"address", "full_name", "date_of_birth"}
    # Structural keys are never treated as identity fields.
    assert "schema_version" not in detected


def test_detect_leaves_non_identity_fields_untouched():
    inferrer = DomainInferrer()
    payload = {
        "portfolio": {"holdings": []},
        "risk_tolerance": "aggressive",
        "net_worth": 100000,
    }
    detected = _detect_identity_entities("financial", payload, inferrer=inferrer)
    assert detected == []


def test_is_identity_field_matches_inferrer_rule():
    inferrer = DomainInferrer()
    assert _is_identity_field("address", inferrer=inferrer) is True
    assert _is_identity_field("full_name", inferrer=inferrer) is True
    assert _is_identity_field("risk_tolerance", inferrer=inferrer) is False


# ---------------------------------------------------------------------------
# Plan: the single mis-stored address move (phase-01 UAT regression)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_plan_moves_single_address_from_financial():
    reader = _make_reader(
        {
            "financial": {"address": "123 Main St, New York, NY, 10001", "portfolio": {}},
            # No identity domain yet.
        }
    )
    result = await plan_moves(USER_ID, reader=reader)

    assert len(result.planned) == 1
    move = result.planned[0]
    assert move.source_domain == "financial"
    assert move.field_key == "address"
    assert move.dest_domain == DEST_DOMAIN
    assert move.source_path == "financial.address"


# ---------------------------------------------------------------------------
# Dry-run: zero writes
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_dry_run_makes_zero_writes():
    reader = _make_reader({"financial": {"address": "123 Main St"}})
    pkm = _RecordingPKMService()

    result = await run_backfill_for_user(USER_ID, reader=reader, pkm_service=pkm, dry_run=True)

    assert len(result.planned) == 1
    assert result.applied == []
    assert pkm.calls == []  # record_mutation_event never called in dry-run


@pytest.mark.asyncio
async def test_apply_writes_reversible_mutation_event():
    reader = _make_reader({"financial": {"address": "123 Main St"}})
    pkm = _RecordingPKMService()

    result = await run_backfill_for_user(USER_ID, reader=reader, pkm_service=pkm, dry_run=False)

    assert len(result.applied) == 1
    assert len(pkm.calls) == 1
    call = pkm.calls[0]
    assert call["domain"] == DEST_DOMAIN
    assert call["operation_type"] == "identity_backfill_move"
    # Reversible: the source domain/path are recorded in the event metadata.
    meta = call["metadata"]
    assert meta["source_domain"] == "financial"
    assert meta["source_path"] == "financial.address"
    assert meta["reversible"] is True


# ---------------------------------------------------------------------------
# Idempotency: second run after the move plans nothing
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_idempotent_second_run_plans_zero_moves():
    # After a successful move the address now lives in `identity`.
    reader = _make_reader(
        {
            "financial": {"address": "123 Main St"},
            "identity": {"address": "123 Main St"},
        }
    )
    result = await plan_moves(USER_ID, reader=reader)

    assert result.planned == []
    assert "financial.address" in result.already_present


# ---------------------------------------------------------------------------
# SSN: never planned, never moved (D-A)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ssn_field_is_never_planned():
    reader = _make_reader(
        {
            "financial": {
                "address": "123 Main St",
                "ssn": "000-00-0000",
                "social_security_number": "111-22-3333",
            }
        }
    )
    pkm = _RecordingPKMService()
    result = await run_backfill_for_user(USER_ID, reader=reader, pkm_service=pkm, dry_run=False)

    planned_keys = {m.field_key for m in result.planned}
    assert "ssn" not in planned_keys
    assert "social_security_number" not in planned_keys
    # The address still moves; SSN-shaped fields are flagged for the operator.
    assert "address" in planned_keys
    assert any("ssn" in flag for flag in result.skipped_ssn)
    # No mutation event ever references an SSN field.
    for call in pkm.calls:
        assert not _is_ssn_field(call["metadata"]["field_key"])


def test_is_ssn_field_detects_variants():
    assert _is_ssn_field("ssn") is True
    assert _is_ssn_field("ssn_last4") is True
    assert _is_ssn_field("social_security_number") is True
    assert _is_ssn_field("address") is False


# ---------------------------------------------------------------------------
# D-B: canonical full_name derived from first/last name components on move
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_name_components_move_as_canonical_full_name():
    reader = _make_reader({"general": {"first_name": "Jane", "last_name": "Doe"}})
    result = await plan_moves(USER_ID, reader=reader)

    full_name_moves = [m for m in result.planned if m.field_key == "full_name"]
    assert full_name_moves, "expected a canonical full_name move"
    assert full_name_moves[0].value == "Jane Doe"
