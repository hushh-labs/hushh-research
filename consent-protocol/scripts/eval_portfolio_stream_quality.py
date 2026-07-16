#!/usr/bin/env python3
"""Evaluate Gemini portfolio stream extraction quality on one or more PDFs.

This script mirrors the /api/kai/portfolio/import/stream prompt and
normalization pipeline so parser quality can be benchmarked deterministically.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from collections import Counter
from pathlib import Path
from statistics import mean
from typing import Any

from google.genai import types

CONSENT_PROTOCOL_ROOT = Path(__file__).resolve().parents[1]
if str(CONSENT_PROTOCOL_ROOT) not in sys.path:
    sys.path.insert(0, str(CONSENT_PROTOCOL_ROOT))

from api.routes.kai._streaming import parse_json_with_single_repair  # noqa: E402
from api.routes.kai.portfolio import (  # noqa: E402
    _aggregate_holdings_by_symbol,
    _coerce_optional_number,
    _extract_holdings_list,
    _is_cash_equivalent_row,
    _is_unknown_name,
    _normalize_raw_holding_row,
    _validate_holding_row,
)
from hushh_mcp.constants import (  # noqa: E402
    GEMINI_MODEL,
    KAI_PORTFOLIO_IMPORT_MAX_OUTPUT_TOKENS,
)
from hushh_mcp.kai_import import (  # noqa: E402
    FINANCIAL_STATEMENT_EXTRACT_V2_REQUIRED_KEYS,
    build_statement_extract_prompt_v2,
)
from hushh_mcp.runtime_providers import build_managed_runtime_client  # noqa: E402


def _discover_brokerage_pdfs(corpus_dir: Path) -> list[Path]:
    if not corpus_dir.exists():
        return []
    pdfs = sorted(
        [
            *corpus_dir.glob("*.pdf"),
            *corpus_dir.glob("*.PDF"),
            *corpus_dir.rglob("*.pdf"),
            *corpus_dir.rglob("*.PDF"),
        ]
    )
    # De-duplicate while preserving order.
    unique: list[Path] = []
    seen: set[Path] = set()
    for path in pdfs:
        resolved = path.resolve()
        if resolved in seen:
            continue
        seen.add(resolved)
        unique.append(resolved)
    return unique


def _default_pdfs() -> list[Path]:
    repo_root = Path(__file__).resolve().parents[2]
    discovered = _discover_brokerage_pdfs(repo_root / "data" / "brokerage_statements")
    if discovered:
        return discovered
    # Fallback to known samples if corpus folder is empty.
    return [
        repo_root / "data" / "Brokerage_March2021.pdf",
        repo_root / "data" / "sample-new-fidelity-acnt-stmt.pdf",
    ]


def _zero_qty_zero_price_nonzero_value_count(rows: list[dict[str, Any]]) -> int:
    count = 0
    for row in rows:
        if _is_cash_equivalent_row(row):
            continue
        qty = _coerce_optional_number(row.get("quantity")) or 0.0
        price = _coerce_optional_number(row.get("price")) or 0.0
        market_value = _coerce_optional_number(row.get("market_value")) or 0.0
        if qty == 0.0 and price == 0.0 and market_value > 0.0:
            count += 1
    return count


def _is_statement_candidate(pdf_path: Path) -> bool:
    """
    Identify portfolio-statement candidates from filename.

    The brokerage corpus may include onboarding/guide PDFs that are not statements.
    We exclude those from hard quality gating so benchmark gates stay signal-accurate.
    """
    name = pdf_path.name.lower()
    non_statement_markers = (
        "how-to-read",
        "guide",
        "understanding",
        "read-",
    )
    return not any(marker in name for marker in non_statement_markers)


async def _run_model_for_pdf(
    client: Any,
    pdf_path: Path,
    *,
    timeout_seconds: float,
) -> dict[str, Any]:
    contents = [
        types.Part.from_text(text=build_statement_extract_prompt_v2()),
        types.Part.from_bytes(data=pdf_path.read_bytes(), mime_type="application/pdf"),
    ]

    config_kwargs: dict[str, Any] = {
        "temperature": 0.0,
        "max_output_tokens": KAI_PORTFOLIO_IMPORT_MAX_OUTPUT_TOKENS,
        "response_mime_type": "application/json",
        "automatic_function_calling": types.AutomaticFunctionCallingConfig(disable=True),
    }
    config = types.GenerateContentConfig(**config_kwargs)

    response = None
    last_error: Exception | None = None
    for attempt in range(1, 4):
        try:
            response = await asyncio.wait_for(
                client.aio.models.generate_content(
                    model=GEMINI_MODEL,
                    contents=contents,
                    config=config,
                ),
                timeout=timeout_seconds,
            )
            break
        except Exception as exc:  # pragma: no cover - runtime diagnostics
            last_error = exc
            message = str(exc).upper()
            is_retryable_quota = "RESOURCE_EXHAUSTED" in message or "429" in message
            if is_retryable_quota and attempt < 3:
                await asyncio.sleep(float(attempt) * 2.0)
                continue
            raise

    if response is None:
        raise RuntimeError(str(last_error).strip() or "model_response_missing")

    text = (response.text or "").strip()
    parsed, diagnostics = parse_json_with_single_repair(
        text,
        required_keys=FINANCIAL_STATEMENT_EXTRACT_V2_REQUIRED_KEYS,
    )
    holdings, source = _extract_holdings_list(parsed)

    normalized_rows: list[dict[str, Any]] = []
    for idx, row in enumerate(holdings):
        if isinstance(row, dict):
            normalized_rows.append(_normalize_raw_holding_row(row, idx))

    dropped_reasons: Counter[str] = Counter()
    validated_rows: list[dict[str, Any]] = []
    for row in normalized_rows:
        is_valid, reason = _validate_holding_row(row)
        if not is_valid:
            dropped_reasons[reason or "unknown"] += 1
            continue
        validated_rows.append(row)

    aggregated_rows = _aggregate_holdings_by_symbol(validated_rows)
    statement_candidate = _is_statement_candidate(pdf_path)
    average_confidence = (
        mean([float(row.get("confidence") or 0.0) for row in aggregated_rows])
        if aggregated_rows
        else 0.0
    )

    scorecard: dict[str, Any] = {
        "document": str(pdf_path),
        "statement_candidate": statement_candidate,
        "extract_source": source,
        "parse_repair_applied": bool(diagnostics.get("repair_applied", False)),
        "raw_holdings_count": len(normalized_rows),
        "validated_holdings_count": len(validated_rows),
        "aggregated_holdings_count": len(aggregated_rows),
        "placeholder_symbol_count": sum(
            1
            for row in aggregated_rows
            if str(row.get("symbol") or "").startswith("HOLDING_")
            or not str(row.get("symbol") or "").strip()
        ),
        "unknown_name_count": sum(
            1 for row in aggregated_rows if _is_unknown_name(row.get("name"))
        ),
        "zero_qty_zero_price_nonzero_value_count": _zero_qty_zero_price_nonzero_value_count(
            aggregated_rows
        ),
        "account_header_row_count": int(dropped_reasons.get("account_header_row", 0)),
        "duplicate_symbol_lot_count": max(0, len(validated_rows) - len(aggregated_rows)),
        "average_confidence": round(average_confidence, 4),
        "dropped_reasons": dict(dropped_reasons),
        "sample_aggregated_holdings": aggregated_rows[:10],
    }

    quality_gates_pass = (
        scorecard["placeholder_symbol_count"] == 0
        and scorecard["account_header_row_count"] == 0
        and scorecard["zero_qty_zero_price_nonzero_value_count"] == 0
        and scorecard["aggregated_holdings_count"] > 0
        and all(
            bool(str(row.get("symbol") or "").strip() or str(row.get("name") or "").strip())
            for row in aggregated_rows
        )
    )
    scorecard["passes_quality_gates"] = quality_gates_pass if statement_candidate else True
    scorecard["quality_gate_scope"] = (
        "statement_candidate" if statement_candidate else "non_statement"
    )

    return scorecard


async def _evaluate(pdfs: list[Path], *, timeout_seconds: float) -> dict[str, Any]:
    client: Any | None = None
    results: list[dict[str, Any]] = []

    for path in pdfs:
        if not path.exists():
            statement_candidate = _is_statement_candidate(path)
            results.append(
                {
                    "document": str(path),
                    "statement_candidate": statement_candidate,
                    "quality_gate_scope": (
                        "statement_candidate" if statement_candidate else "non_statement"
                    ),
                    "error": "file_not_found",
                    "passes_quality_gates": False,
                }
            )
            continue
        try:
            if client is None:
                client = build_managed_runtime_client("gemini")
            results.append(
                await _run_model_for_pdf(
                    client,
                    path,
                    timeout_seconds=timeout_seconds,
                )
            )
        except Exception as exc:  # pragma: no cover - runtime diagnostics
            detail = str(exc).strip() or exc.__class__.__name__
            statement_candidate = _is_statement_candidate(path)
            results.append(
                {
                    "document": str(path),
                    "statement_candidate": statement_candidate,
                    "quality_gate_scope": (
                        "statement_candidate" if statement_candidate else "non_statement"
                    ),
                    "error": detail,
                    "passes_quality_gates": False,
                }
            )

    successful = [row for row in results if not row.get("error")]
    statement_docs_all = [row for row in results if row.get("statement_candidate")]
    statement_docs_successful = [row for row in statement_docs_all if not row.get("error")]
    non_statement_docs = [row for row in results if not row.get("statement_candidate")]
    aggregate = {
        "documents_total": len(results),
        "documents_successful": len(successful),
        "statement_candidate_documents": len(statement_docs_all),
        "statement_candidate_successful": len(statement_docs_successful),
        "statement_candidate_errors": len(
            [row for row in statement_docs_all if bool(row.get("error"))]
        ),
        "non_statement_documents": len(non_statement_docs),
        "raw_holdings_total": sum(int(row.get("raw_holdings_count", 0)) for row in successful),
        "validated_holdings_total": sum(
            int(row.get("validated_holdings_count", 0)) for row in successful
        ),
        "aggregated_holdings_total": sum(
            int(row.get("aggregated_holdings_count", 0)) for row in successful
        ),
        "placeholder_symbol_total": sum(
            int(row.get("placeholder_symbol_count", 0)) for row in successful
        ),
        "account_header_row_total": sum(
            int(row.get("account_header_row_count", 0)) for row in successful
        ),
        "zero_qty_zero_price_nonzero_value_total": sum(
            int(row.get("zero_qty_zero_price_nonzero_value_count", 0)) for row in successful
        ),
        "average_confidence_mean": round(
            mean(
                [
                    float(row.get("average_confidence") or 0.0)
                    for row in successful
                    if int(row.get("aggregated_holdings_count") or 0) > 0
                ]
            ),
            4,
        )
        if any(int(row.get("aggregated_holdings_count") or 0) > 0 for row in successful)
        else 0.0,
        "statement_quality_pass_count": sum(
            1 for row in statement_docs_successful if bool(row.get("passes_quality_gates"))
        ),
        "statement_quality_fail_count": sum(
            1 for row in statement_docs_successful if not bool(row.get("passes_quality_gates"))
        ),
    }

    return {
        "model": GEMINI_MODEL,
        "documents": results,
        "aggregate": aggregate,
        "all_quality_gates_passed": all(
            (not bool(row.get("error"))) and bool(row.get("passes_quality_gates"))
            for row in statement_docs_all
        )
        if statement_docs_all
        else False,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate portfolio stream extraction quality")
    parser.add_argument(
        "--pdf",
        dest="pdfs",
        action="append",
        help="Path to PDF file (repeatable). If omitted, auto-discovers corpus PDFs.",
    )
    parser.add_argument(
        "--corpus-dir",
        dest="corpus_dir",
        help=(
            "Optional corpus directory to auto-discover PDFs when --pdf is omitted. "
            "Defaults to data/brokerage_statements."
        ),
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Optional max number of auto-discovered PDFs to evaluate.",
    )
    parser.add_argument(
        "--json-out",
        dest="json_out",
        help="Optional path to save JSON report.",
    )
    parser.add_argument(
        "--no-fail",
        action="store_true",
        help="Do not return non-zero exit code when quality gates fail.",
    )
    parser.add_argument(
        "--per-doc-timeout-sec",
        type=float,
        default=90.0,
        help="Timeout per PDF model call (seconds).",
    )
    parser.add_argument(
        "--include-non-statements",
        action="store_true",
        help="Include guide/how-to PDFs during auto-discovery.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.pdfs:
        pdf_paths = [Path(p).expanduser().resolve() for p in args.pdfs]
    else:
        if args.corpus_dir:
            pdf_paths = _discover_brokerage_pdfs(Path(args.corpus_dir).expanduser().resolve())
        else:
            pdf_paths = _default_pdfs()
        if not args.include_non_statements:
            pdf_paths = [path for path in pdf_paths if _is_statement_candidate(path)]
        if args.limit and args.limit > 0:
            pdf_paths = pdf_paths[: args.limit]

    report = asyncio.run(_evaluate(pdf_paths, timeout_seconds=max(5.0, args.per_doc_timeout_sec)))

    output = json.dumps(report, indent=2, ensure_ascii=False)
    print(output)

    if args.json_out:
        out_path = Path(args.json_out).expanduser().resolve()
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(output + "\n", encoding="utf-8")

    if report["all_quality_gates_passed"] or args.no_fail:
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
