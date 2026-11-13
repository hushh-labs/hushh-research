"""Source integrity, fallback and cancellation contracts for incremental import."""

from __future__ import annotations

import asyncio
import io
from unittest.mock import AsyncMock

import pytest
from pypdf import PdfReader, PdfWriter

from hushh_mcp.kai_import.csv_layout import CsvLayoutUnsupported, parse_csv_number
from hushh_mcp.kai_import.incremental_extract import incremental_statement_extract


def layout(first=1, last=1, header=0):
    return {
        "decision": "mapped",
        "header_row": header,
        "columns": [
            {"field": "symbol", "column": 0},
            {"field": "quantity", "column": 1},
            {"field": "market_value", "column": 2},
            {"field": "cost_basis", "column": 3},
        ],
        "position_ranges": [{"first": first, "last": last}],
        "other_ranges": [{"first": 0, "last": 0, "purpose": "header"}] if first == 1 else [],
        "metadata": [],
        "decimal_separator": ".",
        "group_separator": ",",
        "currency": None,
    }


def pdf_bytes(count=2):
    with PdfWriter() as writer, io.BytesIO() as output:
        for _ in range(count):
            writer.add_blank_page(width=100, height=100)
        writer.write(output)
        return output.getvalue()


def page(*, total=100, pending=False, continued=False):
    return {
        "statement_details": {"institution_name": "Synthetic broker"},
        "portfolio_summary": {"ending_value": total},
        "detailed_holdings": [
            {"symbol": "SAME", "market_value": 50, "starts_on_previous_page": continued}
        ],
        "cash_balance": 0,
        "total_value": total,
        "historical_values": [],
        "currency": None,
        "requires_full_document": False,
        "continuation_pending": pending,
        "continuation_context": "",
    }


def extract(monkeypatch, results, *, content=None, csv=False, guard=None, full=None):
    answers = iter(results)
    calls = []

    async def model(**kwargs):
        calls.append(kwargs)
        value = next(answers)
        if isinstance(value, Exception):
            raise value
        return value, 1

    monkeypatch.setattr("hushh_mcp.agents.portfolio_import.runtime.run_portfolio_gene", model)
    fallback = full or AsyncMock(
        return_value=({"detailed_holdings": [{"symbol": "FULL"}]}, "full", 1)
    )
    stream = incremental_statement_extract(
        content=content if content is not None else pdf_bytes(),
        is_csv=csv,
        prompt="extract synthetic",
        user_id="synthetic-owner",
        consent_token="synthetic-token",  # noqa: S106 - synthetic test authority
        model_name="gemini-default",
        guard=guard or AsyncMock(),
        cancelled=AsyncMock(return_value=False),
        full_extract=fallback,
    )
    return stream, calls, fallback


@pytest.mark.parametrize(
    "text,decimal,grouping,expected",
    [
        ("$1,234.56", ".", ",", 1234.56),
        ("1.234,56", ",", ".", 1234.56),
        ("(1,234.56)", ".", ",", -1234.56),
        ("0", ".", ",", 0),
        ("", ".", ",", None),
    ],
)
def test_source_numbers_preserve_zero_missing_and_explicit_locale(
    text, decimal, grouping, expected
):
    assert parse_csv_number(text, decimal=decimal, grouping=grouping) == expected


@pytest.mark.parametrize(
    "text", ["1,23", "(-1)", "1,234,56", "1.2,3", "NaN", "Infinity", "1-2", "--1"]
)
def test_ambiguous_numbers_request_fallback_instead_of_changing_value(text):
    with pytest.raises(CsvLayoutUnsupported):
        parse_csv_number(text, decimal=".", grouping=",")


@pytest.mark.asyncio
async def test_csv_every_batch_keeps_original_lots_and_missing_cost(monkeypatch):
    content = ("Symbol,Qty,Value,Cost\n" + "SAME,0,0,\n" * 151).encode()
    stream, calls, fallback = extract(
        monkeypatch, [layout(1, 149), layout(150, 151)], content=content, csv=True
    )
    first = await anext(stream)
    assert first["kind"] == "partial" and len(calls) == 1
    rest = [event async for event in stream]
    final = rest[-1]["parsed"]["detailed_holdings"]
    assert len(final) == 151
    assert len({row["_import_source"]["row"] for row in final}) == 151
    assert all(
        row["quantity"] == 0 and row["market_value"] == 0 and row["cost_basis"] is None
        for row in final
    )
    assert len(calls) == 2
    assert len(__import__("json").loads(calls[1]["prompt"])["records"]) == 2
    fallback.assert_not_awaited()


@pytest.mark.asyncio
async def test_uncovered_csv_row_resets_before_whole_document_fallback(monkeypatch):
    stream, _, fallback = extract(
        monkeypatch,
        [layout(1, 1)],
        csv=True,
        content=b"Symbol,Qty,Value,Cost\nONE,1,10,\nTWO,2,20,\n",
    )
    events = [event async for event in stream]
    assert [event["kind"] for event in events] == ["reset", "complete"]
    assert events[-1]["fallback_reason"] == "csv_row_coverage_incomplete"
    assert events[-1]["parsed"]["detailed_holdings"][0]["_import_source"]["kind"] == "full_document"
    fallback.assert_awaited_once()


@pytest.mark.asyncio
async def test_pdf_each_call_has_exactly_one_page_preserves_identical_lots(monkeypatch):
    stream, calls, fallback = extract(monkeypatch, [page(), page()])
    first = await anext(stream)
    assert first["update"]["unit_id"] == "pdf:1" and len(calls) == 1
    events = [event async for event in stream]
    final = events[-1]["parsed"]
    assert len(calls) == len(final["detailed_holdings"]) == 2
    assert final["total_value"] == 100  # repeated summaries are not added
    assert final["cash_balance"] == 0
    assert [row["_import_source"]["page"] for row in final["detailed_holdings"]] == [1, 2]
    for call in calls:
        assert len(PdfReader(io.BytesIO(call["document_parts"][0].inline_data.data)).pages) == 1
    fallback.assert_not_awaited()


@pytest.mark.parametrize("second", [page(total=200), page(continued=True), page(pending=True)])
@pytest.mark.asyncio
async def test_pdf_conflict_or_continuation_discards_provisional_units(monkeypatch, second):
    stream, _, fallback = extract(monkeypatch, [page(), second])
    events = [event async for event in stream]
    assert [event["kind"] for event in events] == ["partial", "reset", "complete"]
    assert events[-1]["parsed"]["detailed_holdings"][0]["symbol"] == "FULL"
    fallback.assert_awaited_once()


@pytest.mark.asyncio
async def test_pending_pdf_row_requests_fallback_before_it_can_be_dropped(monkeypatch):
    stream, calls, fallback = extract(monkeypatch, [page(pending=True)], content=pdf_bytes(3))
    assert [event["kind"] async for event in stream] == ["reset", "complete"]
    assert len(calls) == 1
    fallback.assert_awaited_once()


@pytest.mark.asyncio
async def test_provider_failure_never_becomes_partial_success_or_retry(monkeypatch):
    stream, _, fallback = extract(monkeypatch, [page(), RuntimeError("synthetic provider failure")])
    assert (await anext(stream))["kind"] == "partial"
    with pytest.raises(RuntimeError, match="synthetic provider failure"):
        await anext(stream)
    fallback.assert_not_awaited()


@pytest.mark.asyncio
async def test_revoked_authority_after_model_never_publishes_unit(monkeypatch):
    permitted = True

    async def guard():
        if not permitted:
            raise PermissionError("revoked")

    stream, _, fallback = extract(monkeypatch, [], guard=guard)

    async def revoke(**kwargs):
        nonlocal permitted
        permitted = False
        return page(), 1

    monkeypatch.setattr("hushh_mcp.agents.portfolio_import.runtime.run_portfolio_gene", revoke)
    with pytest.raises(PermissionError, match="revoked"):
        await anext(stream)
    fallback.assert_not_awaited()


@pytest.mark.asyncio
async def test_cancel_awaits_owned_provider_task_and_never_completes(monkeypatch):
    started, settled = asyncio.Event(), asyncio.Event()

    async def waiting(**kwargs):
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            settled.set()

    stream, _, fallback = extract(monkeypatch, [])
    monkeypatch.setattr("hushh_mcp.agents.portfolio_import.runtime.run_portfolio_gene", waiting)
    pending = asyncio.create_task(anext(stream))
    await asyncio.wait_for(started.wait(), 2)
    pending.cancel()
    with pytest.raises(asyncio.CancelledError):
        await pending
    assert settled.is_set()
    fallback.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("revoke", [False, True])
async def test_route_rechecks_authority_before_terminal_financial_output(monkeypatch, revoke):
    import json

    from api.routes.kai import portfolio

    permitted = True

    async def token_check(*args):
        return object() if permitted else None

    async def admission(user, surface, check):
        await check()

    async def extracted(**kwargs):
        yield {
            "kind": "complete",
            "parsed": {
                "statement_details": {},
                "portfolio_summary": {},
                "detailed_holdings": [
                    {
                        "symbol": "SYNTH",
                        "name": "Synthetic",
                        "quantity": 1,
                        "market_value": 100,
                        "_import_source": {"kind": "pdf", "page": 1, "row": 1},
                    }
                ],
                "cash_balance": 0,
                "total_value": 100,
                "historical_values": [],
            },
            "source": "pdf_pages",
            "elapsed_ms": 1,
            "units": 1,
            "fallback_reason": None,
        }

    monkeypatch.setattr(portfolio, "validate_first_party_owner_token", token_check)
    monkeypatch.setattr(portfolio, "require_hub_content_current", admission)
    monkeypatch.setattr(portfolio, "incremental_statement_extract", extracted)
    monkeypatch.setattr(portfolio, "_resolve_portfolio_import_model", lambda: "gemini-default")
    from types import SimpleNamespace

    stream = portfolio._portfolio_import_stream_generator(
        request=SimpleNamespace(is_disconnected=AsyncMock(return_value=False)),
        content=b"synthetic",
        filename="synthetic.pdf",
        is_csv_upload=False,
        user_id="synthetic-owner",
        consent_token="synthetic-token",  # noqa: S106 - synthetic test authority
    )
    frames = []
    async for frame in stream:
        body = json.loads(frame["data"])
        frames.append(body)
        if revoke and body["event"] == "stage" and body["payload"].get("stage") == "validating":
            permitted = False
    terminal = frames[-1]
    assert terminal["terminal"] is True
    assert terminal["event"] == ("error" if revoke else "complete")
    if revoke:
        assert not any(frame["event"] == "complete" for frame in frames)
    else:
        holdings = terminal["payload"]["portfolio_data_v2"]["holdings"]
        assert holdings[0]["provenance"]["source_record"]["page"] == 1


def test_explicit_statement_count_or_value_mismatch_requires_document_context():
    from api.routes.kai.portfolio import _incremental_needs_document_context

    parsed = {
        "detailed_holdings": [{"symbol": "SYNTH", "market_value": 50}],
        "portfolio_summary": {"securities_market_value": 50, "declared_security_count": 1},
    }
    assert not _incremental_needs_document_context(parsed)
    parsed["portfolio_summary"]["securities_market_value"] = 100
    assert _incremental_needs_document_context(parsed)
    parsed["portfolio_summary"] = {"declared_security_count": 2}
    assert _incremental_needs_document_context(parsed)


@pytest.mark.asyncio
async def test_final_printed_reconciliation_failure_invokes_one_full_fallback(monkeypatch):
    from api.routes.kai.portfolio import _incremental_needs_document_context

    result = page()
    result["portfolio_summary"]["securities_market_value"] = 101
    full = AsyncMock(return_value=({"detailed_holdings": [{"symbol": "FULL"}]}, "full", 1))

    async def model(**kwargs):
        return result, 1

    monkeypatch.setattr("hushh_mcp.agents.portfolio_import.runtime.run_portfolio_gene", model)
    stream = incremental_statement_extract(
        content=pdf_bytes(1),
        is_csv=False,
        prompt="synthetic",
        user_id="synthetic",
        consent_token="synthetic-token",  # noqa: S106 - synthetic test authority
        model_name="gemini-default",
        guard=AsyncMock(),
        cancelled=AsyncMock(return_value=False),
        full_extract=full,
        needs_document_context=_incremental_needs_document_context,
    )
    events = [event async for event in stream]
    assert [event["kind"] for event in events] == ["partial", "reset", "complete"]
    assert events[-1]["fallback_reason"] == "statement_reconciliation_incomplete"
    full.assert_awaited_once()


def test_csv_quoted_multiline_records_and_footer_metadata_keep_source_indices():
    from hushh_mcp.kai_import.csv_layout import csv_batches, decode_csv_batch, read_csv_records

    records = read_csv_records(b'Symbol,Qty,Value,Cost\n"SYNTH\nLOT",0,0,\nTotal,,0,\n')
    mapping = layout()
    mapping["other_ranges"].append({"first": 2, "last": 2, "purpose": "summary"})
    mapping["metadata"] = [{"field": "total_value", "row": 2, "column": 2}]
    rows, facts, _ = decode_csv_batch(
        records,
        csv_batches(records)[0],
        mapping,
        field_kinds={
            "symbol": "string",
            "quantity": "number",
            "market_value": "number",
            "cost_basis": "number",
        },
        metadata_kinds={"total_value": "number"},
        visible_header=None,
    )
    assert rows[0]["symbol"] == "SYNTH\nLOT"
    assert rows[0]["_import_source"]["row"] == 2
    assert rows[0]["cost_basis"] is None
    assert facts["total_value"] == 0
