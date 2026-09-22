"""Tests for manifest-owned Email single-turn genes."""

from __future__ import annotations

import pytest

from hushh_mcp.agents.email import runtime
from hushh_mcp.services import gmail_delivery_service
from hushh_mcp.services.gmail_delivery_service import GmailDeliveryService

_TEST_CONSENT_TOKEN = "owner-token"


def test_email_draft_gene_is_manifest_owned() -> None:
    gene = runtime.load_email_gene("agent_email_draft")

    assert gene.runtime.adk_mode == "single_turn"
    assert gene.runtime.transport == ["in_process"]
    assert gene.privacy.plaintext_telemetry is False
    assert gene.performance.max_output_tokens == 1200


@pytest.mark.asyncio
async def test_run_email_gene_uses_shared_single_turn_runtime(monkeypatch) -> None:
    calls: dict[str, object] = {}

    def build_agent(gene, **kwargs):
        calls["gene"] = gene.id
        calls["schema"] = kwargs["output_schema"]
        return "email-agent"

    async def run_agent(agent, **kwargs):
        calls["agent"] = agent
        calls["user_id"] = kwargs["user_id"]
        calls["consent_token"] = kwargs["consent_token"]
        return {
            "to": ["mat@example.com"],
            "cc": [],
            "bcc": [],
            "subject": "Hello",
            "body": "Hi",
            "missing_details": [],
        }

    monkeypatch.setattr(runtime, "build_managed_runtime_client", lambda provider: "client")
    monkeypatch.setattr(runtime, "Gemini", lambda **kwargs: "gemini-model")
    monkeypatch.setattr(runtime, "build_single_turn_agent", build_agent)
    monkeypatch.setattr(runtime, "run_single_turn", run_agent)

    result = await runtime.run_email_gene(
        gene_id="agent_email_draft",
        prompt="Write a short greeting",
        user_id="owner-1",
        consent_token=_TEST_CONSENT_TOKEN,
    )

    assert result["subject"] == "Hello"
    assert calls["gene"] == "agent_email_draft"
    assert calls["agent"] == "email-agent"
    assert calls["user_id"] == "owner-1"
    assert calls["consent_token"] == "owner-token"


@pytest.mark.asyncio
async def test_email_draft_requires_owner_authority() -> None:
    with pytest.raises(ValueError, match="authority"):
        await runtime.run_email_gene(
            gene_id="agent_email_draft",
            prompt="Write a short greeting",
            user_id="owner-1",
            consent_token="",
        )


@pytest.mark.asyncio
async def test_delivery_service_delegates_drafting_to_email_gene(monkeypatch) -> None:
    calls: dict[str, object] = {}

    async def fake_run_email_gene(**kwargs):
        calls.update(kwargs)
        return {
            "to": ["mat@example.com"],
            "cc": [],
            "bcc": [],
            "subject": "Partnership",
            "body": "Hello Mat",
            "missing_details": [],
        }

    monkeypatch.setattr(gmail_delivery_service, "run_email_gene", fake_run_email_gene)

    draft = await GmailDeliveryService().draft_from_instruction(
        instruction="Write a partnership note to Mat",
        user_id="owner-1",
        consent_token=_TEST_CONSENT_TOKEN,
    )

    assert draft["to"] == ["mat@example.com"]
    assert calls["gene_id"] == "agent_email_draft"
    assert calls["user_id"] == "owner-1"
    assert calls["consent_token"] == "owner-token"


@pytest.mark.asyncio
async def test_delivery_service_rejects_missing_owner_authority() -> None:
    with pytest.raises(gmail_delivery_service.GmailDeliveryError) as error:
        await GmailDeliveryService().draft_from_instruction(
            instruction="Write a partnership note",
            user_id="owner-1",
            consent_token="",
        )

    assert error.value.code == "OWNER_AUTHORITY_REQUIRED"
