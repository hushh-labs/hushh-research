"""A failed memory proposal is not an empty review, and each admitted attempt
logs one content-free outcome after the route's own 503 decision.

The line carries only closed codes and counts, survives the log redactor, and
its logging-only capture source never reaches the memory agents.
"""

from __future__ import annotations

import logging

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes import pkm
from mcp_modules.log_redaction import SensitiveLogFilter
from tests.test_pkm_upgrade_routes import shared_owner_placement as shared_owner_placement


@pytest.mark.parametrize(
    "failed, expected_status, capture_source, expected_line",
    [
        (
            True,
            503,
            "app_activity_digest",
            "route=hub capture_source=app_activity_digest memory_profile=general"
            " outcome=unavailable status=503",
        ),
        (
            False,
            200,
            "pasted note text",
            "route=hub capture_source=unrecognized memory_profile=general"
            " outcome=nothing_durable status=200",
        ),
    ],
)
def test_memory_proposal_failure_is_not_a_successful_empty_review(
    monkeypatch,
    caplog,
    shared_owner_placement,
    failed,
    expected_status,
    capture_source,
    expected_line,
):
    class PreviewService:
        async def generate_structure_preview(self, **kwargs):
            # The logging-only source never reaches the memory agents.
            assert "capture_source" not in kwargs
            return {
                "agent_id": "pkm_structure",
                "agent_name": "Structure",
                "model": "test",
                "used_fallback": failed,
                "preview_cards": [],
                "candidate_payload": {},
                "structure_decision": {},
                "validation_hints": ["preview_generation_failed"] if failed else [],
                "error": "private provider diagnostic" if failed else None,
            }

    app = FastAPI()
    app.include_router(pkm.router)
    app.dependency_overrides[pkm.require_vault_owner_token] = lambda: {"user_id": "user_123"}
    monkeypatch.setattr(pkm, "get_pkm_agent_lab_service", lambda: PreviewService())
    monkeypatch.setattr(pkm, "get_pkm_service", lambda: object())
    caplog.set_level(logging.INFO, logger="api.routes.pkm")
    response = TestClient(app).post(
        "/api/pkm/memory/proposals",
        json={
            "user_id": "user_123",
            "message": "Synthetic memory review",
            "capture_source": capture_source,
        },
    )
    # An unrecognized source is recorded as such and never refuses the request.
    assert response.status_code == expected_status
    if failed:
        assert response.json()["detail"]["code"] == "PKM_PROPOSAL_UNAVAILABLE"
        assert "private provider diagnostic" not in response.text
    else:
        assert response.json()["preview_cards"] == []
    records = [
        record
        for record in caplog.records
        if record.getMessage().startswith("pkm.memory_proposal.outcome ")
    ]
    # The 503 is the terminal outcome, not the "completed" line written before it.
    assert len(records) == 1
    SensitiveLogFilter().filter(records[0])
    assert expected_line in records[0].getMessage()
    for private in ("Synthetic memory review", "private provider diagnostic", "pasted note text"):
        assert private not in caplog.text
