"""Email tool-selection boundary through the installed IndexedRouter.

The numerical encoder fixture isolates the library's threshold/multi-route
contract without network or model weights. The opt-in local test additionally
qualifies actual FastEmbed inference; it never accesses a mailbox or provider.
"""

from __future__ import annotations

import asyncio
import math
import os

import pytest
from semantic_router.encoders import DenseEncoder, FastEmbedEncoder
from semantic_router.index import LocalIndex
from semantic_router.routers import IndexedRouter

from hushh_mcp.services.email_oss import routing


class CoordinateEncoder(DenseEncoder):
    name: str = "fixture-coordinates"
    type: str = "fixture"
    orthogonal: bool = False

    def __call__(self, docs: list[str]) -> list[list[float]]:
        coordinates = {
            example: [float(column == row) for column in range(7)]
            for row, examples in enumerate(routing._EXAMPLES.values())
            for example in examples
        }
        # Two nearby route centroids, so both independently clear the actual
        # production threshold for this synthetic multi-intent vector.
        if not self.orthogonal:
            for example in routing._EXAMPLES["4_gmail_draft_safe"]:
                coordinates[example] = [0.8, 0, 0, 0.6, 0, 0, 0]
        norm = math.sqrt(0.95**2 + 0.3**2)
        coordinates["synthetic compound"] = [0.95 / norm, 0, 0, 0.3 / norm, 0, 0, 0]
        coordinates["synthetic unmatched"] = [0, 0, 0, 0, 0, 0, 1]
        return [coordinates[doc] for doc in docs]

    async def acall(self, docs: list[str]) -> list[list[float]]:
        return self(docs)


@pytest.fixture
def indexed_router(monkeypatch):
    router = routing.create_email_router(encoder=CoordinateEncoder(), index=LocalIndex())
    assert isinstance(router, IndexedRouter)
    monkeypatch.setattr(routing, "_router", router)
    return router


async def test_real_indexed_router_merges_compound_routes_and_retains_retrieval(indexed_router):
    stored_examples = indexed_router.index.get_routes()
    selected = await routing.select_email_tools("synthetic compound")

    assert selected.route_ids == ("1_gmail_search_query", "4_gmail_draft_safe")
    assert set(selected.tool_names) == {
        *routing.ALWAYS_AVAILABLE_TOOLS,
        "search_threads",
        "get_thread",
        "get_message",
        "get_attachment",
        "create_draft",
    }
    # Negative controls: selection neither loses PDF access nor exposes a
    # mutation group which the actual library did not match.
    assert "send_email" not in selected.tool_names
    assert "trash_message" not in selected.tool_names
    assert selected.fallback_reason is None
    assert selected.confidence == pytest.approx(0.95 / math.sqrt(0.95**2 + 0.3**2))
    assert selected.elapsed_ms >= 0
    assert indexed_router.index.get_routes() == stored_examples


async def test_concurrent_first_selections_build_one_process_router(indexed_router, monkeypatch):
    builds = []

    def build():
        builds.append(True)
        return indexed_router

    monkeypatch.setattr(routing, "_router", None)
    monkeypatch.setattr(routing, "create_email_router", build)
    results = await asyncio.gather(
        *(routing.select_email_tools("synthetic compound") for _ in range(4))
    )
    assert len(builds) == 1
    assert all(result.route_ids == results[0].route_ids for result in results)


async def test_low_confidence_uses_only_email_tools_not_other_domains(indexed_router):
    selected = await routing.select_email_tools("synthetic unmatched")

    assert selected.route_ids == ()
    assert selected.fallback_reason == "low_confidence"
    assert set(selected.tool_names) == {*routing.EMAIL_TOOL_NAMES, *routing.ALWAYS_AVAILABLE_TOOLS}
    assert set(selected.tool_names) == {
        "search_threads",
        "get_thread",
        "get_message",
        "get_attachment",
        "create_draft",
        "send_email",
        "reply_to_thread",
        "batch_modify_messages",
        "trash_message",
        "read_memory_md",
        "save_to_memory_md",
        "get_connection_status",
    }


async def test_router_failure_does_not_log_private_request_or_exception(monkeypatch, caplog):
    private_marker = "fixture-private-query-do-not-log"

    def unavailable():
        raise RuntimeError(private_marker)

    monkeypatch.setattr(routing, "_get_router", unavailable)
    with pytest.raises(RuntimeError, match="Email tool selection is unavailable") as error:
        await routing.select_email_tools(private_marker)
    assert private_marker not in caplog.text
    assert private_marker not in str(error.value)


async def test_uat_startup_requires_successful_router_before_readiness(monkeypatch):
    import logging
    from unittest.mock import AsyncMock

    from api.email_router_lifecycle import warm_email_router_for_startup

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "uat")
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("HUSHH_EMAIL_ROUTER_MODEL_CACHE", "/synthetic/baked-router")
    warm = AsyncMock()
    monkeypatch.setattr(routing, "warm_email_router", warm)
    await warm_email_router_for_startup(logging.getLogger(__name__))
    warm.assert_awaited_once()

    warm.side_effect = ValueError("synthetic corrupt model")
    with pytest.raises(RuntimeError, match="required UAT Email router could not start"):
        await warm_email_router_for_startup(logging.getLogger(__name__))
    monkeypatch.delenv("HUSHH_EMAIL_ROUTER_MODEL_CACHE")
    with pytest.raises(RuntimeError, match="required UAT Email router cache"):
        await warm_email_router_for_startup(logging.getLogger(__name__))

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "production")
    warm.reset_mock()
    await warm_email_router_for_startup(logging.getLogger(__name__))
    warm.assert_not_awaited()


@pytest.mark.skipif(
    os.getenv("EMAIL_OSS_LOCAL_ROUTER_SMOKE") != "1",
    reason="Opt-in local model qualification; may populate the FastEmbed model cache",
)
async def test_actual_fastembed_selects_pdf_retrieval_and_compound_draft(monkeypatch):
    # No substitute encoder/index/router: this is the production factory.
    router = await asyncio.to_thread(routing.create_email_router)
    assert isinstance(router, IndexedRouter)
    assert isinstance(router.encoder, FastEmbedEncoder)
    assert isinstance(router.index, LocalIndex)
    monkeypatch.setattr(routing, "_router", router)

    # Held-out paraphrases rather than a self-match against indexed examples.
    invoices = await routing.select_email_tools(
        "Look through my mail for PDF bills and inspect the attached files"
    )
    assert invoices.fallback_reason is None
    assert "3_gmail_attachment_ops" in invoices.route_ids
    assert {"search_threads", "get_thread", "get_message", "get_attachment"} <= set(
        invoices.tool_names
    )
    assert "send_email" not in invoices.tool_names
    assert "trash_message" not in invoices.tool_names

    compound = await routing.select_email_tools(
        "Locate emails about overdue invoices and prepare a draft response to the sender"
    )
    assert compound.fallback_reason is None
    assert "4_gmail_draft_safe" in compound.route_ids
    assert "1_gmail_search_query" in compound.route_ids
    assert {"search_threads", "get_thread", "get_message", "get_attachment", "create_draft"} <= set(
        compound.tool_names
    )


@pytest.mark.parametrize(
    "route",
    ["2_gmail_read_thread", "4_gmail_draft_safe", "5_gmail_send_mutate", "6_gmail_triage_organize"],
)
async def test_isolated_read_draft_reply_routes_keep_native_source_lookup(monkeypatch, route):
    router = routing.create_email_router(
        encoder=CoordinateEncoder(orthogonal=True), index=LocalIndex()
    )
    monkeypatch.setattr(routing, "_router", router)
    selected = await routing.select_email_tools(routing._EXAMPLES[route][0])
    assert selected.route_ids == (route,)
    assert {"search_threads", "get_thread", "get_message", "get_attachment"} <= set(
        selected.tool_names
    )
    assert ("send_email" in selected.tool_names) is (route == "5_gmail_send_mutate")
    assert ("create_draft" in selected.tool_names) is (route == "4_gmail_draft_safe")
