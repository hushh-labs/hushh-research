"""Small model-owned layouts/pages feeding the existing final import pipeline."""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any

from .csv_layout import CsvLayoutUnsupported, csv_batches, decode_csv_batch, read_csv_records
from .incremental_contracts import (
    CSV_LAYOUT_SCHEMA,
    DocumentContextRequired,
    StatementAccumulator,
    nested_csv_facts,
    page_extraction_schema,
)
from .pdf_pages import PdfPages, PdfPageSplitUnsupported

Guard = Callable[[], Awaitable[None]]
Cancelled = Callable[[], Awaitable[bool]]
FullExtract = Callable[[], Awaitable[tuple[dict[str, Any], str, int]]]


async def _thread_call(function, *args, on_cancel=None):
    # A cancelled to_thread future does not stop its worker. Join before closing
    # its PDF reader or releasing the source bytes.
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

    started = time.perf_counter()
    await guard()
    accumulator = StatementAccumulator()
    yielded_units = 0
    first_result_ms: int | None = None
    source: PdfPages | None = None
    fallback_reason: str | None = None
    try:
        if is_csv:
            records = await _thread_call(read_csv_records, content)
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
            source = await _thread_call(PdfPages, content, on_cancel=lambda opened: opened.close())
            context = ""
            previous_rows: list[dict] = []
            schema = page_extraction_schema(_EXTRACTION_SCHEMA)
            for page in range(1, source.count + 1):
                await guard()
                page_content = await _thread_call(source.page_bytes, page - 1)
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
    finally:
        if source is not None:
            await _thread_call(source.close)

    if fallback_reason is not None:
        await guard()
        yield {"kind": "reset", "reason": fallback_reason}
        parsed, content_source, _ = await _model_call(
            full_extract,
            guard=guard,
            cancelled=cancelled,
        )
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
