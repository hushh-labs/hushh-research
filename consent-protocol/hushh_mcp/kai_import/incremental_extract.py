"""Small model-owned layouts/pages feeding the existing final import pipeline."""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from decimal import Decimal
from typing import Any, TypeVar

from .csv_layout import CsvLayoutUnsupported, csv_batches, decode_csv_batch, read_csv_records
from .declared_layout import declared_csv, declared_pdf, is_declared_pdf
from .incremental_contracts import (
    CSV_LAYOUT_SCHEMA,
    DocumentContextRequired,
    StatementAccumulator,
    nested_csv_facts,
    page_extraction_schema,
)
from .pdf_pages import PdfPages, PdfPageSplitUnsupported
from .strict_json import ImportStrictParseError
from .structured_csv import structured_csv
from .structured_pdf import MAX_STRUCTURED_PDF_PAGES, MAX_STRUCTURED_PDF_SECONDS, structured_pdf

Guard = Callable[[], Awaitable[None]]
Cancelled = Callable[[], Awaitable[bool]]
FullExtract = Callable[[], Awaitable[tuple[dict[str, Any], str, int]]]
_Result = TypeVar("_Result")


async def _thread_call(
    function: Callable[..., _Result],
    *args: Any,
    on_cancel: Callable[[_Result], None] | None = None,
) -> _Result:
    # A cancelled to_thread future does not stop its worker. Join before closing
    # releasing source bytes or abandoning its worker.
    task = asyncio.create_task(asyncio.to_thread(function, *args))
    cancellation = None
    while True:
        try:
            result = await asyncio.shield(task)
            break
        except asyncio.CancelledError as exc:
            if task.cancelled():
                raise
            cancellation = exc
        except Exception:
            if cancellation is not None:
                raise cancellation from None
            raise
    if cancellation is not None:
        if on_cancel is not None:
            on_cancel(result)
        raise cancellation
    return result


async def _model_call(call, *, guard: Guard, cancelled: Cancelled, **kwargs):
    await guard()
    task = asyncio.create_task(call(**kwargs))
    try:
        while not task.done():
            await asyncio.wait({task}, timeout=0.25)
            if await cancelled():
                raise asyncio.CancelledError
        result = await task
        await guard()
        return result
    finally:
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)


def _unit(index: int, total: int, kind: str, rows: list[dict], facts: dict) -> dict:
    preview = []
    for row in rows:
        source = row["_import_source"]
        source_id = f"{kind}:{source.get('page', 0)}:{source['row']}"
        preview.append(
            {
                "source_id": source_id,
                "source_page": source.get("page"),
                **{
                    key: row[key]
                    for key in (
                        "symbol",
                        "ticker",
                        "symbol_cusip",
                        "cusip",
                        "security_id",
                        "name",
                        "description",
                        "quantity",
                        "price",
                        "market_value",
                        "cost_basis",
                        "unrealized_gain_loss",
                        "currency",
                    )
                    if key in row
                },
            }
        )
    return {
        "kind": "partial",
        "index": index,
        "total": total,
        "update": {
            "version": 1,
            "unit_id": f"{kind}:{index}",
            "revision": 1,
            "unit_index": index,
            "units_total": total,
            "source_kind": kind,
            "rows": preview,
            "facts": facts,
        },
    }


def _direct_preview(parsed: dict[str, Any], kind: str) -> dict[str, Any]:
    return {
        **_unit(
            1,
            1,
            kind,
            parsed["detailed_holdings"],
            {key: val for key, val in parsed.items() if key != "detailed_holdings"},
        ),
        "declared_layout": True,
    }


async def _alternate_csv(content: bytes) -> dict[str, Any] | None:
    if len(content) > 1024 * 1024:
        return None
    candidates = []
    for delimiter in (";", "\t"):
        if delimiter.encode() not in content[:4096]:
            continue
        try:
            records = await _thread_call(read_csv_records, content, delimiter)
        except CsvLayoutUnsupported:
            continue
        if candidate := await _thread_call(structured_csv, records):
            candidates.append(candidate)
    return candidates[0] if len(candidates) == 1 else None


async def _read_structured_pdf(
    source: PdfPages, guard: Guard
) -> tuple[dict[str, Any], bool] | None:
    if source.count > MAX_STRUCTURED_PDF_PAGES:
        return None
    try:
        async with asyncio.timeout(MAX_STRUCTURED_PDF_SECONDS):
            pages = []
            for index in range(source.count):
                await guard()
                pages.append(await source.page_text(index, layout=True))
                if not pages[-1].strip():
                    return None
            return await _thread_call(structured_pdf, pages)
    except TimeoutError as exc:
        # A cancelled frame may remain on the pipe. Close the worker before any
        # further requests and send the original document to the existing gene.
        raise DocumentContextRequired("pdf_layout_probe_timeout") from exc
    except PdfPageSplitUnsupported:
        return None


def _check_pdf_completion(verified: list[dict[str, Any]], parsed: dict[str, Any]) -> None:
    expected = {row["symbol"]: row for row in verified}
    actual: dict[str, dict[str, Any]] = {}
    source_rows = parsed.get("detailed_holdings")
    try:
        if not isinstance(source_rows, list):
            raise ValueError("missing_holdings")
        for row in source_rows:
            if not isinstance(row, dict):
                raise ValueError("invalid_holding")
            symbol = str(row.get("symbol") or row.get("ticker") or "").strip().upper()
            if symbol in {"CASH", "MMF", "SWEEP"} and symbol not in expected:
                continue
            if symbol not in expected or symbol in actual:
                raise ValueError("unverified_position")
            actual[symbol] = row
        if actual.keys() != expected.keys():
            raise ValueError("missing_verified_position")
        details = parsed.get("statement_details")
        document_currency = details.get("currency") if isinstance(details, dict) else None
        for symbol, row in expected.items():
            reported_currency = actual[symbol].get("currency") or document_currency
            if row.get("currency") and (reported_currency or "USD") != row["currency"]:
                raise ValueError("verified_position_currency_mismatch")
            for field in (
                "quantity",
                "price",
                "market_value",
                "cost_basis",
                "unrealized_gain_loss",
            ):
                if field in row and (
                    not isinstance(actual[symbol].get(field), (int, float))
                    or Decimal(str(row[field])) != Decimal(str(actual[symbol][field]))
                ):
                    raise ValueError("verified_position_mismatch")
    except (ValueError, ArithmeticError):
        raise ImportStrictParseError(
            "IMPORT_JSON_INVALID", "Full statement results disagree with verified holdings."
        ) from None


async def _declared_events(
    parsed: dict[str, Any], kind: str, started: float, guard: Guard, *, structured: bool = False
) -> AsyncIterator[dict[str, Any]]:
    await guard()
    elapsed = int((time.perf_counter() - started) * 1000)
    yield _direct_preview(parsed, kind)
    await guard()
    route = "structured_table" if structured else "declared_layout"
    yield {
        "kind": "complete",
        "parsed": parsed,
        "source": f"{kind}_{route}",
        "units": 1,
        "fallback_reason": None,
        "first_result_ms": elapsed,
        "elapsed_ms": int((time.perf_counter() - started) * 1000),
    }


async def incremental_statement_extract(
    *,
    content: bytes,
    is_csv: bool,
    prompt: str,
    user_id: str,
    consent_token: str,
    model_name: str,
    guard: Guard,
    cancelled: Cancelled,
    full_extract: FullExtract,
    needs_document_context: Callable[[dict[str, Any]], bool] | None = None,
) -> AsyncIterator[dict[str, Any]]:
    from google.genai import types

    from hushh_mcp.agents.portfolio_import.runtime import (
        _EXTRACTION_SCHEMA,
        _HOLDING_ROW_SCHEMA,
        _PORTFOLIO_SUMMARY_SCHEMA,
        _STATEMENT_DETAILS_SCHEMA,
        run_portfolio_gene,
    )
    from hushh_mcp.hushh_adk.events import AdkEventTimeoutError
    from hushh_mcp.hushh_adk.turn import SpecialistAdkTurnError

    started = time.perf_counter()
    await guard()
    accumulator = StatementAccumulator()
    yielded_units = 0
    first_result_ms: int | None = None
    source: PdfPages | None = None
    fallback_reason: str | None = None
    verified_pdf: list[dict[str, Any]] | None = None
    try:
        if is_csv:
            try:
                records = await _thread_call(read_csv_records, content)
            except CsvLayoutUnsupported:
                alternate = await _alternate_csv(content)
                if alternate is None or (
                    needs_document_context and needs_document_context(alternate)
                ):
                    raise
                async for event in _declared_events(
                    alternate, "csv", started, guard, structured=True
                ):
                    yield event
                return
            declared = declared_csv(records)
            direct = declared or await _thread_call(structured_csv, records)
            if direct is None:
                direct = await _alternate_csv(content)
            if direct is not None and not (
                needs_document_context and needs_document_context(direct)
            ):
                async for event in _declared_events(
                    direct, "csv", started, guard, structured=declared is None
                ):
                    yield event
                return
            batches = csv_batches(records)
            if not batches:
                raise CsvLayoutUnsupported("csv_empty")
            fields = {
                key: str(value["type"]).lower()
                for key, value in _HOLDING_ROW_SCHEMA["properties"].items()
            }
            metadata_fields = {
                **{
                    f"statement_details.{key}": "string"
                    for key in _STATEMENT_DETAILS_SCHEMA["properties"]
                },
                **{
                    f"portfolio_summary.{key}": "number"
                    for key in _PORTFOLIO_SUMMARY_SCHEMA["properties"]
                },
                "cash_balance": "number",
                "total_value": "number",
            }
            header: int | None = None
            for index, batch in enumerate(batches, 1):
                await guard()
                # Every record in this batch is visible to the mapping model;
                # samples cannot establish the semantic role of unseen rows.
                layout_prompt = json.dumps(
                    {
                        "fields": fields,
                        "metadata_fields": metadata_fields,
                        "header_context": {"row": header, "cells": records[header]}
                        if header is not None
                        else None,
                        "records": [
                            {"row": batch.start + i, "cells": row}
                            for i, row in enumerate(batch.rows)
                        ],
                    },
                    ensure_ascii=False,
                )
                layout, _ = await _model_call(
                    run_portfolio_gene,
                    guard=guard,
                    cancelled=cancelled,
                    gene_id="agent_portfolio_import_csv_layout",
                    prompt=layout_prompt,
                    user_id=user_id,
                    consent_token=consent_token,
                    output_schema=CSV_LAYOUT_SCHEMA,
                    model_name=model_name,
                    timeout_seconds=20,
                )
                rows, flat, header = decode_csv_batch(
                    records,
                    batch,
                    layout,
                    field_kinds=fields,
                    metadata_kinds=metadata_fields,
                    visible_header=header,
                )
                facts = nested_csv_facts(flat)
                accumulator.add(facts, rows)
                await guard()
                yielded_units += 1
                if first_result_ms is None:
                    first_result_ms = int((time.perf_counter() - started) * 1000)
                yield _unit(index, len(batches), "csv", rows, facts)
        else:
            source = await PdfPages.open(content)
            if source.count <= 8:
                first_page = await source.page_text(0)
                if is_declared_pdf(first_page):
                    pages = [first_page]
                    for index in range(1, source.count):
                        await guard()
                        pages.append(await source.page_text(index))
                    direct = declared_pdf(pages)
                    if direct is not None and not (
                        needs_document_context and needs_document_context(direct)
                    ):
                        async for event in _declared_events(direct, "pdf", started, guard):
                            yield event
                        return
            candidate = await _read_structured_pdf(source, guard)
            if candidate is not None:
                parsed, needs_supplementary_context = candidate
                if not (needs_document_context and needs_document_context(parsed)):
                    if not needs_supplementary_context:
                        async for event in _declared_events(
                            parsed, "pdf", started, guard, structured=True
                        ):
                            yield event
                        return
                    await guard()
                    first_result_ms = int((time.perf_counter() - started) * 1000)
                    yield _direct_preview(parsed, "pdf")
                    yielded_units = 1
                    verified_pdf = parsed["detailed_holdings"]
                    raise DocumentContextRequired("pdf_supplementary_context")
            if source.count > 4:
                raise DocumentContextRequired("pdf_large_whole_document")
            context = ""
            previous_rows: list[dict] = []
            schema = page_extraction_schema(_EXTRACTION_SCHEMA)
            for page in range(1, source.count + 1):
                await guard()
                page_content = await source.page_bytes(page - 1)
                page_prompt = (
                    prompt
                    + "\n"
                    + json.dumps(
                        {
                            "page_number": page,
                            "page_count": source.count,
                            "previous_page_context": context,
                            "previous_page_last_rows": previous_rows,
                        },
                        ensure_ascii=False,
                    )
                )
                result, _ = await _model_call(
                    run_portfolio_gene,
                    guard=guard,
                    cancelled=cancelled,
                    gene_id="agent_portfolio_import_pdf_page",
                    prompt=page_prompt,
                    document_parts=[
                        types.Part.from_bytes(data=page_content, mime_type="application/pdf")
                    ],
                    user_id=user_id,
                    consent_token=consent_token,
                    output_schema=schema,
                    model_name=model_name,
                    timeout_seconds=45,
                )
                del page_content
                json.dumps(result, allow_nan=False)
                context = result.get("continuation_context")
                if (
                    result.get("requires_full_document") is not False
                    or not isinstance(context, str)
                    or len(context) > 3000
                ):
                    raise DocumentContextRequired("page_context_ambiguous")
                if result.get("continuation_pending") is not False:
                    raise DocumentContextRequired("unfinished_continuation")
                raw_rows = result.get("detailed_holdings")
                if not isinstance(raw_rows, list) or any(
                    not isinstance(row, dict) for row in raw_rows
                ):
                    raise DocumentContextRequired("page_rows_invalid")
                rows = []
                for ordinal, raw in enumerate(raw_rows, 1):
                    row = dict(raw)
                    continued = row.pop("starts_on_previous_page", False)
                    if continued:
                        raise DocumentContextRequired("page_continuation_invalid")
                    row["_import_source"] = {
                        "kind": "pdf",
                        "page": page,
                        "row": ordinal,
                        "pages": [page - 1, page] if continued else [page],
                    }
                    rows.append(row)
                facts = {
                    key: result.get(key)
                    for key in (
                        "statement_details",
                        "portfolio_summary",
                        "cash_balance",
                        "total_value",
                        "historical_values",
                        "currency",
                    )
                    if key in result
                }
                accumulator.add(facts, rows)
                previous_rows = [
                    {key: value for key, value in row.items() if key != "_import_source"}
                    for row in rows[-2:]
                ]
                await guard()
                yielded_units += 1
                if first_result_ms is None:
                    first_result_ms = int((time.perf_counter() - started) * 1000)
                yield _unit(page, source.count, "pdf", rows, facts)
        if needs_document_context is not None and needs_document_context(accumulator.parsed):
            raise DocumentContextRequired("statement_reconciliation_incomplete")
    except (CsvLayoutUnsupported, DocumentContextRequired, PdfPageSplitUnsupported) as exc:
        # Explicit unsupported/ambiguous layout, not a provider retry or a
        # replacement of successful model facts. The authored full-document
        # extractor retains its existing authority and final output contract.
        fallback_reason = str(exc)
    except SpecialistAdkTurnError as exc:
        if not isinstance(exc.__cause__, AdkEventTimeoutError):
            raise
        # The local deadline for a page or CSV batch expired. A whole-document
        # call has its own bounded budget and runs after the same owner check.
        fallback_reason = "incremental_model_deadline"
    finally:
        if source is not None:
            await source.close()

    if fallback_reason is not None:
        await guard()
        if verified_pdf is None:
            yield {"kind": "reset", "reason": fallback_reason}
        parsed, content_source, _ = await _model_call(
            full_extract,
            guard=guard,
            cancelled=cancelled,
        )
        if verified_pdf is not None:
            _check_pdf_completion(verified_pdf, parsed)
        for ordinal, row in enumerate(parsed.get("detailed_holdings", []), 1):
            if isinstance(row, dict):
                row["_import_source"] = {"kind": "full_document", "row": ordinal}
    else:
        parsed, content_source = accumulator.parsed, "csv_mapped_rows" if is_csv else "pdf_pages"
        if accumulator.currency:
            parsed["statement_details"]["currency"] = accumulator.currency
    await guard()
    yield {
        "kind": "complete",
        "parsed": parsed,
        "source": content_source,
        "units": yielded_units,
        "fallback_reason": fallback_reason,
        "first_result_ms": first_result_ms,
        "elapsed_ms": int((time.perf_counter() - started) * 1000),
    }
