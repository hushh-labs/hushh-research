#!/usr/bin/env python3
"""Local Kai debate regression smoke.

Runtime truth for Kai debate persistence comes from script-first regression checks
using the real Kai test user and local/runtime env files. Playwright remains
useful for visual checks only and should not be treated as the source of truth
for PKM persistence, debate completion, or history integrity.

This smoke runs against the local backend, starts a real Kai debate, waits for
the terminal decision envelope, persists that decision into
financial.analysis_history, and re-reads the encrypted PKM domain to verify the
save under the current evolved contract.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
import time
import uuid
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_BACKEND_URL = "http://localhost:8000"
DEFAULT_PROTOCOL_ENV = str(REPO_ROOT / "consent-protocol" / ".env")
DEFAULT_WEB_ENV = str(REPO_ROOT / "hushh-webapp" / ".env.local")
DEFAULT_TICKER = "AAPL"
DEFAULT_TIMEOUT = 300
MAX_HISTORY_PER_TICKER = 3


def load_smoke_module():
    module_path = Path(__file__).resolve().with_name("uat_kai_regression_smoke.py")
    spec = importlib.util.spec_from_file_location("kai_uat_smoke", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load smoke helpers from {module_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def sse_events(response, *, timeout_seconds: int) -> list[dict[str, Any]]:
    started_at = time.time()
    events: list[dict[str, Any]] = []
    event_name = "message"
    data_lines: list[str] = []

    def flush() -> dict[str, Any] | None:
        nonlocal event_name, data_lines
        if not data_lines:
            event_name = "message"
            return None
        raw = "\n".join(data_lines)
        data_lines = []
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            payload = {"raw": raw}
        resolved_event = event_name
        resolved_payload: Any = payload
        resolved_terminal = False
        if isinstance(payload, dict):
            parsed_event = str(payload.get("event") or "").strip()
            if parsed_event:
                resolved_event = parsed_event
            inner_payload = payload.get("payload")
            if inner_payload is not None:
                resolved_payload = inner_payload
            resolved_terminal = bool(payload.get("terminal"))
        envelope = {
            "event": resolved_event,
            "payload": resolved_payload,
            "terminal": resolved_terminal,
        }
        event_name = "message"
        return envelope

    for raw_line in response.iter_lines(decode_unicode=True):
        if time.time() - started_at > timeout_seconds:
            raise RuntimeError(
                f"Timed out waiting for debate stream after {timeout_seconds} seconds."
            )
        if raw_line is None:
            continue
        line = raw_line.strip()
        if not line:
            envelope = flush()
            if envelope is None:
                continue
            events.append(envelope)
            if bool(envelope.get("terminal")):
                return events
            continue
        if line.startswith(":"):
            continue
        if line.startswith("event:"):
            event_name = line.split(":", 1)[1].strip() or "message"
            continue
        if line.startswith("data:"):
            data_lines.append(line.split(":", 1)[1].lstrip())
    envelope = flush()
    if envelope is not None:
        events.append(envelope)
    return events


def extract_history_map(financial_domain: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    raw_history = financial_domain.get("analysis_history")
    if not isinstance(raw_history, dict):
        return {}
    history_map: dict[str, list[dict[str, Any]]] = {}
    for key, value in raw_history.items():
        if key == "domain_intent":
            continue
        if isinstance(value, list):
            history_map[str(key).upper()] = [entry for entry in value if isinstance(entry, dict)]
    return history_map


def to_float(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        parsed = float(value)
        if parsed == parsed:
            return parsed
        return None
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            parsed = float(text)
        except Exception:
            return None
        if parsed == parsed:
            return parsed
    return None


def build_debate_context_from_financial_domain(financial_domain: dict[str, Any]) -> dict[str, Any]:
    portfolio = (
        financial_domain.get("portfolio")
        if isinstance(financial_domain.get("portfolio"), dict)
        else {}
    )
    holdings_raw = portfolio.get("holdings") if isinstance(portfolio.get("holdings"), list) else []
    holdings = []
    for row in holdings_raw[:30]:
        if not isinstance(row, dict):
            continue
        symbol = str(row.get("symbol") or "").strip().upper()
        name = str(row.get("name") or "").strip()
        if not symbol and not name:
            continue
        holdings.append(
            {
                "symbol": symbol,
                "name": name,
                "quantity": to_float(row.get("quantity")),
                "market_value": to_float(row.get("market_value")),
                "position_side": str(row.get("position_side") or "").strip().lower() or None,
                "is_short_position": bool(row.get("is_short_position")),
                "is_liability_position": bool(row.get("is_liability_position")),
                "unrealized_gain_loss_pct": to_float(row.get("unrealized_gain_loss_pct")),
                "sector": str(row.get("sector") or "").strip() or None,
                "asset_type": str(row.get("asset_type") or row.get("asset_class") or "").strip()
                or None,
                "is_investable": bool(row.get("is_investable")),
                "is_cash_equivalent": bool(row.get("is_cash_equivalent")),
                "is_sec_common_equity_ticker": bool(row.get("is_sec_common_equity_ticker")),
                "symbol_kind": str(row.get("symbol_kind") or "").strip() or None,
                "security_listing_status": str(row.get("security_listing_status") or "").strip()
                or None,
                "analyze_eligible_reason": str(row.get("analyze_eligible_reason") or "").strip()
                or None,
            }
        )

    non_cash = [row for row in holdings if not row.get("is_cash_equivalent")]
    investable = [row for row in non_cash if bool(row.get("symbol"))]
    cash_positions_count = max(0, len(holdings) - len(non_cash))
    top_positions = sorted(
        holdings,
        key=lambda row: abs(row.get("market_value") or 0),
        reverse=True,
    )[:8]

    return {
        "holdings": holdings,
        "holdings_count": len(holdings),
        "account_summary": portfolio.get("account_summary")
        if isinstance(portfolio.get("account_summary"), dict)
        else None,
        "asset_allocation": portfolio.get("asset_allocation")
        if isinstance(portfolio.get("asset_allocation"), dict)
        else None,
        "income_summary": portfolio.get("income_summary")
        if isinstance(portfolio.get("income_summary"), dict)
        else None,
        "realized_gain_loss": portfolio.get("realized_gain_loss")
        if isinstance(portfolio.get("realized_gain_loss"), dict)
        else None,
        "quality_report_v2": portfolio.get("quality_report_v2")
        if isinstance(portfolio.get("quality_report_v2"), dict)
        else None,
        "total_value": to_float(portfolio.get("total_value")),
        "cash_balance": to_float(portfolio.get("cash_balance")),
        "financial_profile": financial_domain.get("profile")
        if isinstance(financial_domain.get("profile"), dict)
        else None,
        "debate_context": {
            "portfolio_snapshot": {
                "holdings_count": len(holdings),
                "non_cash_holdings_count": len(non_cash),
                "investable_holdings_count": len(investable),
                "cash_positions_count": cash_positions_count,
                "total_value": to_float(portfolio.get("total_value")),
                "cash_balance": to_float(portfolio.get("cash_balance")),
                "source_type": "statement",
            },
            "coverage": {
                "ticker_coverage_pct": (len(investable) / len(non_cash)) if non_cash else 0,
                "sector_coverage_pct": (
                    len([row for row in non_cash if row.get("sector")]) / len(non_cash)
                    if non_cash
                    else 0
                ),
                "gain_loss_coverage_pct": (
                    len(
                        [
                            row
                            for row in non_cash
                            if isinstance(row.get("unrealized_gain_loss_pct"), (int, float))
                        ]
                    )
                    / len(non_cash)
                    if non_cash
                    else 0
                ),
            },
            "statement_signals": {
                "investment_gain_loss": to_float(
                    (portfolio.get("account_summary") or {}).get("investment_gain_loss")
                    if isinstance(portfolio.get("account_summary"), dict)
                    else None
                ),
                "total_income_period": to_float(
                    (portfolio.get("account_summary") or {}).get("total_income_period")
                    if isinstance(portfolio.get("account_summary"), dict)
                    else None
                ),
                "total_income_ytd": to_float(
                    (portfolio.get("account_summary") or {}).get("total_income_ytd")
                    if isinstance(portfolio.get("account_summary"), dict)
                    else None
                ),
                "total_fees": to_float(
                    (portfolio.get("account_summary") or {}).get("total_fees")
                    if isinstance(portfolio.get("account_summary"), dict)
                    else None
                ),
            },
            "eligible_symbols": [
                str(row.get("symbol") or "").strip().upper()
                for row in investable
                if str(row.get("symbol") or "").strip()
            ][:20],
            "top_positions": [
                {
                    "symbol": row.get("symbol") or row.get("name") or "UNKNOWN",
                    "market_value": row.get("market_value"),
                    "position_side": row.get("position_side"),
                    "sector": row.get("sector"),
                    "asset_type": row.get("asset_type"),
                }
                for row in top_positions
            ],
        },
    }


def extract_run_id(entry: dict[str, Any]) -> str | None:
    raw_card = entry.get("raw_card")
    if isinstance(raw_card, dict):
        debate_run_id = str(raw_card.get("debate_run_id") or "").strip()
        if debate_run_id:
            return debate_run_id
        diagnostics = raw_card.get("stream_diagnostics")
        if isinstance(diagnostics, dict):
            stream_id = str(diagnostics.get("stream_id") or "").strip()
            if stream_id:
                return stream_id
    return None


def upsert_history_entry(
    history_map: dict[str, list[dict[str, Any]]],
    entry: dict[str, Any],
) -> tuple[dict[str, list[dict[str, Any]]], int]:
    ticker = str(entry.get("ticker") or "").strip().upper()
    if not ticker:
        raise RuntimeError("History entry is missing ticker.")
    bucket = list(history_map.get(ticker) or [])
    incoming_run_id = extract_run_id(entry)
    if incoming_run_id:
        bucket = [existing for existing in bucket if extract_run_id(existing) != incoming_run_id]
    bucket.insert(0, entry)
    history_map[ticker] = bucket[:MAX_HISTORY_PER_TICKER]
    total = sum(len(entries) for entries in history_map.values())
    return history_map, total


def build_history_summary(
    existing_summary: dict[str, Any],
    *,
    history_map: dict[str, list[dict[str, Any]]],
    entry: dict[str, Any],
    manifest: dict[str, Any],
) -> dict[str, Any]:
    tickers = sorted(history_map.keys())
    total = sum(len(entries) for entries in history_map.values())
    now_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    summary = dict(existing_summary or {})
    summary.update(
        {
            "domain_contract_version": int(manifest.get("domain_contract_version") or 1),
            "readable_summary_version": int(manifest.get("readable_summary_version") or 0),
            "upgraded_at": manifest.get("upgraded_at") or existing_summary.get("upgraded_at"),
            "analysis_total_analyses": total,
            "analysis_tickers_analyzed": tickers,
            "analysis_last_updated": now_iso,
            "total_analyses": total,
            "tickers_analyzed": tickers,
            "last_updated": now_iso,
            "last_analysis_ticker": entry["ticker"],
            "last_analysis_date": entry["timestamp"],
        }
    )
    return summary


def build_decision_projection(history_map: dict[str, list[dict[str, Any]]]) -> list[dict[str, Any]]:
    flattened: list[dict[str, Any]] = []
    for entries in history_map.values():
        flattened.extend(entries)
    flattened.sort(key=lambda item: str(item.get("timestamp") or ""), reverse=True)
    decisions: list[dict[str, Any]] = []
    for index, entry in enumerate(flattened, start=1):
        decisions.append(
            {
                "id": index,
                "ticker": entry["ticker"],
                "decision_type": str(entry.get("decision") or "").upper(),
                "confidence": float(entry.get("confidence") or 0),
                "created_at": entry.get("timestamp"),
                "metadata": {
                    "consensus_reached": bool(entry.get("consensus_reached")),
                    "final_statement": entry.get("final_statement"),
                    "agent_votes": entry.get("agent_votes") or {},
                    "debate_run_id": extract_run_id(entry),
                    "source": "analysis_history",
                },
            }
        )
    return decisions


def persist_analysis_history(smoke, *, entry: dict[str, Any]) -> dict[str, Any]:
    manifest = smoke._fetch_domain_manifest("financial")
    blob_payload = smoke._fetch_domain_blob("financial")
    domain_data = smoke._decrypt_domain_blob(blob_payload)
    history_map = extract_history_map(domain_data)
    history_map, _ = upsert_history_entry(history_map, entry)

    existing_analysis = domain_data.get("analysis")
    if not isinstance(existing_analysis, dict):
        existing_analysis = {}

    now_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    domain_data["schema_version"] = max(int(domain_data.get("schema_version") or 0), 3)
    domain_data["domain_intent"] = {
        "primary": "financial",
        "source": "local_kai_debate_regression",
        "contract_version": int(manifest.get("domain_contract_version") or 1),
        "updated_at": now_iso,
    }
    domain_data["analysis_history"] = {
        **history_map,
        "domain_intent": {
            "primary": "financial",
            "secondary": "analysis_history",
            "source": "kai_analysis_stream",
            "updated_at": now_iso,
        },
    }
    domain_data["analysis"] = {
        **existing_analysis,
        "domain_intent": {
            "primary": "financial",
            "secondary": "analysis",
            "source": "kai_analysis_stream",
            "updated_at": now_iso,
        },
        "decisions": existing_analysis.get("decisions")
        if isinstance(existing_analysis.get("decisions"), dict)
        else {},
    }
    domain_data["updated_at"] = now_iso

    metadata = smoke.fetch_pkm_metadata()
    financial_summary = next(
        (
            domain.get("summary")
            for domain in metadata.get("domains", [])
            if str(domain.get("key") or "") == "financial"
        ),
        {},
    )
    summary = build_history_summary(
        financial_summary if isinstance(financial_summary, dict) else {},
        history_map=history_map,
        entry=entry,
        manifest=manifest,
    )
    encrypted_blob = smoke._encrypt_domain_blob(domain_data)
    response = smoke._request(
        "POST",
        "/api/pkm/store-domain",
        headers={**smoke._vault_headers(), "Content-Type": "application/json"},
        json_body={
            "user_id": smoke.user_id,
            "domain": "financial",
            "encrypted_blob": encrypted_blob,
            "summary": summary,
            "manifest": manifest,
            "write_projections": [
                {
                    "projection_type": "decision_history_v1",
                    "projection_version": 1,
                    "payload": {
                        "decisions": build_decision_projection(history_map),
                    },
                }
            ],
            "expected_data_version": blob_payload.get("data_version"),
        },
    )
    return response.json()


def build_history_entry(
    *,
    run_id: str,
    ticker: str,
    decision_payload: dict[str, Any],
    pick_source: str,
    pick_source_label: str,
    pick_source_kind: str,
) -> dict[str, Any]:
    raw_card = (
        dict(decision_payload.get("raw_card") or {})
        if isinstance(decision_payload.get("raw_card"), dict)
        else {}
    )
    raw_card["debate_run_id"] = run_id
    if not raw_card.get("pick_source"):
        raw_card["pick_source"] = pick_source
    if not raw_card.get("pick_source_label"):
        raw_card["pick_source_label"] = pick_source_label
    if not raw_card.get("pick_source_kind"):
        raw_card["pick_source_kind"] = pick_source_kind
    return {
        "ticker": ticker.upper(),
        "timestamp": str(
            decision_payload.get("analysis_updated_at")
            or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        ),
        "decision": str(decision_payload.get("decision") or "hold"),
        "confidence": float(decision_payload.get("confidence") or 0),
        "consensus_reached": bool(decision_payload.get("consensus_reached")),
        "agent_votes": decision_payload.get("agent_votes")
        if isinstance(decision_payload.get("agent_votes"), dict)
        else {},
        "final_statement": str(decision_payload.get("final_statement") or ""),
        "raw_card": raw_card,
    }


def find_saved_entry(
    financial_domain: dict[str, Any], *, run_id: str, ticker: str
) -> dict[str, Any] | None:
    history_map = extract_history_map(financial_domain)
    for entry in history_map.get(ticker.upper(), []):
        if extract_run_id(entry) == run_id:
            return entry
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the local Kai debate PKM smoke.")
    parser.add_argument("--backend-url", default=DEFAULT_BACKEND_URL)
    parser.add_argument("--protocol-env", default=DEFAULT_PROTOCOL_ENV)
    parser.add_argument("--web-env", default=DEFAULT_WEB_ENV)
    parser.add_argument("--ticker", default=DEFAULT_TICKER)
    parser.add_argument("--risk-profile", default="balanced")
    parser.add_argument("--pick-source", default="default")
    parser.add_argument("--pick-source-label", default="Default list")
    parser.add_argument("--pick-source-kind", default="default")
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
    args = parser.parse_args()

    smoke_mod = load_smoke_module()
    smoke = smoke_mod.UatKaiSmoke(
        backend_url=args.backend_url,
        protocol_env=args.protocol_env,
        web_env=args.web_env,
        timeout=min(args.timeout, 60),
    )

    smoke.log("Authenticating with the Kai test user from local env files.")
    smoke.authenticate()
    smoke.derive_vault_key()

    upgrade_status = smoke.fetch_upgrade_status()
    smoke.log(
        "PKM upgrade status="
        f"{upgrade_status.get('upgrade_status')} financial="
        f"{next((item.get('needs_upgrade') for item in upgrade_status.get('upgradable_domains', []) if item.get('domain') == 'financial'), None)}"
    )

    before_blob = smoke._fetch_domain_blob("financial")
    before_domain = smoke._decrypt_domain_blob(before_blob)
    before_history = extract_history_map(before_domain)
    before_total = sum(len(entries) for entries in before_history.values())
    smoke.log(f"Financial analysis history entries before run={before_total}.")

    debate_session_id = f"local_regression_{uuid.uuid4().hex}"
    start_payload = {
        "user_id": smoke.user_id,
        "debate_session_id": debate_session_id,
        "ticker": args.ticker.upper(),
        "risk_profile": args.risk_profile,
        "context": build_debate_context_from_financial_domain(before_domain),
        "pick_source": args.pick_source,
        "pick_source_label": args.pick_source_label,
        "pick_source_kind": args.pick_source_kind,
    }
    start_response = smoke._request(
        "POST",
        "/api/kai/analyze/run/start",
        headers={**smoke._vault_headers(), "Content-Type": "application/json"},
        json_body=start_payload,
    ).json()
    run = start_response.get("run") or {}
    run_id = str(run.get("run_id") or "").strip()
    if not run_id:
        raise RuntimeError(f"Run start did not return a run_id: {start_response}")
    smoke.log(f"Started debate run {run_id} for {args.ticker.upper()}.")

    stream_response = smoke.session.get(
        f"{smoke.backend_url}/api/kai/analyze/run/{run_id}/stream",
        params={"user_id": smoke.user_id, "cursor": 0},
        headers=smoke._vault_headers(),
        timeout=(10, args.timeout),
        stream=True,
    )
    if stream_response.status_code != 200:
        raise RuntimeError(
            f"Run stream failed {stream_response.status_code}: {stream_response.text[:1200]}"
        )
    envelopes = sse_events(stream_response, timeout_seconds=args.timeout)
    decision_envelope = next(
        (
            envelope
            for envelope in reversed(envelopes)
            if str(envelope.get("event") or "").strip() == "decision"
        ),
        None,
    )
    error_envelope = next(
        (
            envelope
            for envelope in reversed(envelopes)
            if str(envelope.get("event") or "").strip() == "error"
        ),
        None,
    )
    if not decision_envelope or not isinstance(decision_envelope.get("payload"), dict):
        if error_envelope and isinstance(error_envelope.get("payload"), dict):
            raise RuntimeError(
                "Debate stream terminated with error: "
                f"{json.dumps(error_envelope['payload'], indent=2)}"
            )
        raise RuntimeError("Debate stream did not produce a terminal decision envelope.")

    decision_payload = decision_envelope["payload"]
    smoke.log(
        "Decision received "
        f"{decision_payload.get('decision')} "
        f"confidence={decision_payload.get('confidence')}"
    )

    entry = build_history_entry(
        run_id=run_id,
        ticker=args.ticker,
        decision_payload=decision_payload,
        pick_source=args.pick_source,
        pick_source_label=args.pick_source_label,
        pick_source_kind=args.pick_source_kind,
    )
    save_result = persist_analysis_history(smoke, entry=entry)
    if not bool(save_result.get("success")):
        raise RuntimeError(f"PKM history save failed: {save_result}")
    smoke.log(
        "Persisted debate decision into financial.analysis_history "
        f"data_version={save_result.get('data_version')}"
    )

    after_domain = smoke._decrypt_domain_blob(smoke._fetch_domain_blob("financial"))
    saved_entry = find_saved_entry(after_domain, run_id=run_id, ticker=args.ticker)
    if not saved_entry:
        raise RuntimeError(
            f"Saved history entry for run_id={run_id} ticker={args.ticker.upper()} was not found."
        )
    raw_card = saved_entry.get("raw_card") if isinstance(saved_entry.get("raw_card"), dict) else {}
    if str(raw_card.get("pick_source_label") or "").strip() != args.pick_source_label:
        raise RuntimeError(
            "Saved history entry is missing the friendly pick-source label: "
            f"{raw_card.get('pick_source_label')!r}"
        )
    smoke.log(
        "Verified saved history entry "
        f"decision={saved_entry.get('decision')} "
        f"pick_source_label={raw_card.get('pick_source_label')}"
    )
    print(
        json.dumps(
            {
                "ok": True,
                "backend_url": smoke.backend_url,
                "user_id": smoke.user_id,
                "run_id": run_id,
                "ticker": args.ticker.upper(),
                "decision": saved_entry.get("decision"),
                "confidence": saved_entry.get("confidence"),
                "pick_source": raw_card.get("pick_source"),
                "pick_source_label": raw_card.get("pick_source_label"),
                "pick_source_kind": raw_card.get("pick_source_kind"),
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
