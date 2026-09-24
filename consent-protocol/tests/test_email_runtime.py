"""Tests for manifest-owned Email single-turn genes."""

from __future__ import annotations

import pytest
from pydantic import BaseModel

from hushh_mcp.agents.email import runtime
from hushh_mcp.hushh_adk.turn import SpecialistAdkTurn, SpecialistAdkTurnError
from hushh_mcp.services import gmail_delivery_service
from hushh_mcp.services.gmail_delivery_service import GmailDeliveryService

_TEST_CONSENT_TOKEN = "owner-token"


@pytest.mark.parametrize(
    ("gene_id", "output_schema"),
    [
        ("agent_email_request_classifier", runtime.EMAIL_REQUEST_CLASSIFIER_SCHEMA),
        ("agent_email_receipt_extractor", runtime.EMAIL_RECEIPT_EXTRACTOR_SCHEMA),
        ("agent_email_draft", runtime.EMAIL_DRAFT_SCHEMA),
        ("agent_email_receipt_memory_enrichment", runtime.EMAIL_RECEIPT_MEMORY_SCHEMA),
    ],
)
def test_email_genes_are_manifest_owned_and_adk_compatible(
    gene_id: str,
    output_schema: dict[str, object],
) -> None:
    gene = runtime.load_email_gene(gene_id)

    assert gene.runtime.adk_mode == "single_turn"
    assert gene.runtime.transport == ["in_process"]
    assert gene.privacy.plaintext_telemetry is False
    assert gene.performance.max_output_tokens > 0

    agent = runtime.build_single_turn_agent(gene, output_schema=output_schema)

    assert agent.name == gene_id


@pytest.mark.asyncio
async def test_run_email_gene_uses_shared_single_turn_runtime(monkeypatch) -> None:
    calls: dict[str, object] = {}

    def build_agent(gene, **kwargs):
        calls["gene"] = gene.id
        calls["schema"] = kwargs["output_schema"]
        calls["agent_kwargs"] = kwargs
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
    assert "model" not in calls["agent_kwargs"]
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
async def test_email_gene_retries_one_transient_vertex_failure(monkeypatch) -> None:
    calls = 0

    class RetryableVertexError(Exception):
        status_code = 429

    async def run_agent(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RetryableVertexError("RESOURCE_EXHAUSTED")
        return {
            "is_information_request": False,
            "confidence": 0,
            "requested_field_labels": [],
            "requested_domains": [],
        }

    async def no_sleep(*_args):
        return None

    monkeypatch.setattr(runtime, "build_single_turn_agent", lambda *_args, **_kwargs: "agent")
    monkeypatch.setattr(runtime, "run_single_turn", run_agent)
    monkeypatch.setattr(runtime.asyncio, "sleep", no_sleep)

    result = await runtime.run_email_gene(
        gene_id="agent_email_request_classifier",
        prompt="Classify this message",
        user_id="owner-1",
        consent_token=_TEST_CONSENT_TOKEN,
        output_schema=runtime.EMAIL_REQUEST_CLASSIFIER_SCHEMA,
    )

    assert result["is_information_request"] is False
    assert calls == 2


@pytest.mark.asyncio
async def test_email_gene_retries_one_malformed_model_response(monkeypatch) -> None:
    calls = 0

    async def run_agent(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise ValueError("single-turn agent returned invalid JSON")
        return {
            "to": ["mat@example.com"],
            "cc": [],
            "bcc": [],
            "subject": "Hello",
            "body": "Hi Mat",
            "missing_details": [],
        }

    async def no_sleep(*_args):
        return None

    monkeypatch.setattr(runtime, "build_single_turn_agent", lambda *_args, **_kwargs: "agent")
    monkeypatch.setattr(runtime, "run_single_turn", run_agent)
    monkeypatch.setattr(runtime.asyncio, "sleep", no_sleep)

    result = await runtime.run_email_gene(
        gene_id="agent_email_draft",
        prompt="Write a note to Mat",
        user_id="owner-1",
        consent_token=_TEST_CONSENT_TOKEN,
        output_schema=runtime.EMAIL_DRAFT_SCHEMA,
    )

    assert result["body"] == "Hi Mat"
    assert calls == 2


@pytest.mark.asyncio
async def test_email_gene_retries_one_adk_wrapped_timeout(monkeypatch) -> None:
    calls = 0

    async def run_agent(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            partial_turn = SpecialistAdkTurn(
                final_text="",
                tool_calls=(),
                tool_results=(),
                state={},
                llm_calls=1,
                elapsed_ms=30_000,
            )
            try:
                raise TimeoutError("email draft turn timed out")
            except TimeoutError as cause:
                raise SpecialistAdkTurnError(partial_turn) from cause
        return {
            "to": ["mat@example.com"],
            "cc": [],
            "bcc": [],
            "subject": "Hello",
            "body": "Hi Mat",
            "missing_details": [],
        }

    async def no_sleep(*_args):
        return None

    monkeypatch.setattr(runtime, "build_single_turn_agent", lambda *_args, **_kwargs: "agent")
    monkeypatch.setattr(runtime, "run_single_turn", run_agent)
    monkeypatch.setattr(runtime.asyncio, "sleep", no_sleep)

    result = await runtime.run_email_gene(
        gene_id="agent_email_draft",
        prompt="Write a note to Mat",
        user_id="owner-1",
        consent_token=_TEST_CONSENT_TOKEN,
        output_schema=runtime.EMAIL_DRAFT_SCHEMA,
        timeout_seconds=30,
    )

    assert result["body"] == "Hi Mat"
    assert calls == 2


@pytest.mark.asyncio
async def test_email_gene_retries_one_schema_validation_failure(monkeypatch) -> None:
    calls = 0

    class DraftPayload(BaseModel):
        body: str

    async def run_agent(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            DraftPayload.model_validate({})
        return {
            "to": ["mat@example.com"],
            "cc": [],
            "bcc": [],
            "subject": "Hello",
            "body": "Hi Mat",
            "missing_details": [],
        }

    async def no_sleep(*_args):
        return None

    monkeypatch.setattr(runtime, "build_single_turn_agent", lambda *_args, **_kwargs: "agent")
    monkeypatch.setattr(runtime, "run_single_turn", run_agent)
    monkeypatch.setattr(runtime.asyncio, "sleep", no_sleep)

    result = await runtime.run_email_gene(
        gene_id="agent_email_draft",
        prompt="Write a note to Mat",
        user_id="owner-1",
        consent_token=_TEST_CONSENT_TOKEN,
        output_schema=runtime.EMAIL_DRAFT_SCHEMA,
    )

    assert result["body"] == "Hi Mat"
    assert calls == 2


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
async def test_delivery_service_rejects_an_empty_model_draft(monkeypatch) -> None:
    async def fake_run_email_gene(**_kwargs):
        return {
            "to": ["mat@example.com"],
            "cc": [],
            "bcc": [],
            "subject": "Hello",
            "body": "",
            "missing_details": ["message"],
        }

    monkeypatch.setattr(gmail_delivery_service, "run_email_gene", fake_run_email_gene)

    with pytest.raises(gmail_delivery_service.GmailDeliveryError) as error:
        await GmailDeliveryService().draft_from_instruction(
            instruction="Write a partnership note to Mat",
            user_id="owner-1",
            consent_token=_TEST_CONSENT_TOKEN,
        )

    assert error.value.code == "DRAFT_INVALID"


@pytest.mark.asyncio
async def test_delivery_service_classifies_exhausted_schema_retries_as_invalid_draft(
    monkeypatch,
) -> None:
    async def fake_run_email_gene(**_kwargs):
        raise ValueError("single-turn response does not match output schema")

    monkeypatch.setattr(gmail_delivery_service, "run_email_gene", fake_run_email_gene)

    with pytest.raises(gmail_delivery_service.GmailDeliveryError) as error:
        await GmailDeliveryService().draft_from_instruction(
            instruction="Write a partnership note to Mat",
            user_id="owner-1",
            consent_token=_TEST_CONSENT_TOKEN,
        )

    assert error.value.code == "DRAFT_INVALID"
    assert error.value.status_code == 502


@pytest.mark.asyncio
async def test_delivery_service_rejects_missing_owner_authority() -> None:
    with pytest.raises(gmail_delivery_service.GmailDeliveryError) as error:
        await GmailDeliveryService().draft_from_instruction(
            instruction="Write a partnership note",
            user_id="owner-1",
            consent_token="",
        )

    assert error.value.code == "OWNER_AUTHORITY_REQUIRED"
