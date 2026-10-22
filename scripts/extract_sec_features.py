#!/usr/bin/env python3
"""Normalize SEC companyfacts payloads into compact feature artifacts."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "consent-protocol"))


def _load_payload(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _normalize_payload(path: Path) -> dict[str, Any]:
    # Share the runtime's period, amendment, duration and freshness rules.
    from hushh_mcp.services.sec_financial_facts import extract_annual_facts

    payload = _load_payload(path)
    facts = extract_annual_facts(payload)
    tickers = payload.get("tickers")
    ticker = (
        str(tickers[0]).upper()
        if isinstance(tickers, list) and tickers
        else path.stem.replace("sec_payload_", "").upper()
    )
    equity, debt = facts.get("equity"), facts.get("long_term_debt")
    revenue, income = facts.get("revenue"), facts.get("net_income")
    return {
        "ticker": ticker,
        "entity_name": payload.get("entityName"),
        "cik": str(payload["cik"]).zfill(10) if payload.get("cik") else None,
        "latest_10k_year": int(facts["period_end"][:4])
        if facts["period_end"]
        else None,
        "fundamentals": {
            **facts,
            "assets": facts.get("total_assets"),
            "liabilities": facts.get("total_liabilities"),
            "capex": facts.get("capital_expenditures"),
            "shares_outstanding": None,
        },
        "ratios": {
            "debt_to_equity": debt / equity
            if debt is not None and equity is not None and equity > 0
            else None,
            "profit_margin": income / revenue
            if income is not None and revenue is not None and revenue > 0
            else None,
        },
        "trends": {
            "revenue": facts["revenue_trend"],
            "net_income": facts["net_income_trend"],
            "operating_cash_flow": facts["ocf_trend"],
        },
        "source": "SEC EDGAR companyfacts",
        "source_file": str(path),
    }


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Normalize SEC payload files into compact features"
    )
    parser.add_argument(
        "--in-dir",
        default="data/sec_payloads",
        help="Directory containing sec_payload_*.json files",
    )
    parser.add_argument(
        "--out-dir",
        default="data/sec_features",
        help="Directory to write sec_features_*.json files",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Optional max files to process",
    )
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    repo_root = Path(__file__).resolve().parents[1]
    in_dir = (repo_root / args.in_dir).resolve()
    out_dir = (repo_root / args.out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    files = sorted(in_dir.glob("sec_payload_*.json"))
    if args.limit and args.limit > 0:
        files = files[: args.limit]

    results: list[dict[str, Any]] = []
    for payload_path in files:
        try:
            normalized = _normalize_payload(payload_path)
            ticker = (
                normalized.get("ticker")
                or payload_path.stem.replace("sec_payload_", "").upper()
            )
            out_path = out_dir / f"sec_features_{str(ticker).lower()}.json"
            out_path.write_text(json.dumps(normalized, indent=2), encoding="utf-8")
            results.append({"ticker": ticker, "ok": True, "path": str(out_path)})
        except Exception as exc:
            results.append(
                {"ticker": payload_path.stem, "ok": False, "error": str(exc)}
            )

    summary = {
        "processed": len(results),
        "success": sum(1 for row in results if row.get("ok")),
        "failed": sum(1 for row in results if not row.get("ok")),
        "results": results,
    }
    (out_dir / "manifest.json").write_text(
        json.dumps(summary, indent=2), encoding="utf-8"
    )
    print(json.dumps(summary, indent=2))
    return 0 if summary["failed"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
