#!/usr/bin/env python3
"""
Seed Renaissance data into Cloud SQL from canonical CSV sources.

Sources (single source of truth):
  - consent-protocol/data/renaissance/Renaissance Investable vs Avoid(INVESTABLE).csv
  - consent-protocol/data/renaissance/Renaissance Investable vs Avoid(AVOID)_2.csv
  - consent-protocol/data/renaissance/Renaissance Investable vs Avoid(Extended_Avoid_Tickers)_3.csv
  - consent-protocol/data/renaissance/Renaissance Investable vs Avoid(Screening_Criteria)_4.csv

This script:
  - Wipes only Renaissance tables (avoid → criteria → universe)
  - Loads investable universe (tiers + FCF + thesis)
  - Loads avoid signals (ticker-level) from both avoid CSVs
  - Loads screening criteria rubric for criteria-first LLM prompting

Usage:
  cd consent-protocol
  python3 scripts/renaissance/import_renaissance_from_csv.py
"""

from __future__ import annotations

import csv
import sys
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

# Ensure consent-protocol/ is on sys.path (script lives in scripts/renaissance/)
PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT))

from db.db_client import get_db  # noqa: E402

DATA_DIR = PROJECT_ROOT / "data" / "renaissance"

INVESTABLE_CSV = DATA_DIR / "Renaissance Investable vs Avoid(INVESTABLE).csv"
AVOID_CSV = DATA_DIR / "Renaissance Investable vs Avoid(AVOID)_2.csv"
EXTENDED_AVOID_CSV = DATA_DIR / "Renaissance Investable vs Avoid(Extended_Avoid_Tickers)_3.csv"
CRITERIA_CSV = DATA_DIR / "Renaissance Investable vs Avoid(Screening_Criteria)_4.csv"


def _norm_ticker(raw: str) -> str:
    return (raw or "").strip().upper()


def _safe_float(raw: str) -> Optional[float]:
    s = (raw or "").strip()
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _iter_rows(path: Path) -> list[list[str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.reader(f)
        return [[c.strip() for c in row] for row in reader]


def _find_header_index(rows: list[list[str]], first_cell_exact: str) -> int:
    for i, row in enumerate(rows):
        if row and row[0].strip() == first_cell_exact:
            return i
    raise ValueError(f"Header '{first_cell_exact}' not found in {path_str(rows)}")


def path_str(rows: list[list[str]]) -> str:
    # Helper for error messages when we only have rows
    return "<csv_rows>"


def parse_investable_rows(path: Path) -> list[dict]:
    rows = _iter_rows(path)
    header_idx = _find_header_index(rows, "Tier")
    data_rows = rows[header_idx + 1 :]

    tier_rank_counter: dict[str, int] = defaultdict(int)
    out: list[dict] = []

    for row in data_rows:
        if not row or len(row) < 6:
            continue
        tier = row[0].strip().upper()
        ticker = _norm_ticker(row[1])
        if not tier or not ticker:
            continue

        tier_rank_counter[tier] += 1

        out.append(
            {
                "ticker": ticker,
                "company_name": row[2].strip(),
                "sector": row[3].strip(),
                "tier": tier,
                "fcf_billions": _safe_float(row[4]),
                "investment_thesis": row[5].strip(),
                "tier_rank": tier_rank_counter[tier],
            }
        )

    return out


def parse_avoid_rows(path: Path) -> list[dict]:
    rows = _iter_rows(path)
    header_idx = _find_header_index(rows, "Category")
    data_rows = rows[header_idx + 1 :]

    out: list[dict] = []
    for row in data_rows:
        if not row or len(row) < 5:
            continue
        category = row[0].strip()
        ticker = _norm_ticker(row[1])
        if not category or not ticker:
            continue
        out.append(
            {
                "ticker": ticker,
                "category": category,
                "company_name": row[2].strip() or None,
                "sector": row[3].strip() or None,
                "why_avoid": row[4].strip() or None,
                "source": "avoid_list",
            }
        )
    return out


def parse_extended_avoid_rows(path: Path) -> list[dict]:
    rows = _iter_rows(path)
    header_idx = _find_header_index(rows, "Category")
    data_rows = rows[header_idx + 1 :]

    out: list[dict] = []
    for row in data_rows:
        if not row or len(row) < 2:
            continue
        category = row[0].strip()
        tickers_blob = (row[1] or "").strip()
        if not category or not tickers_blob:
            continue

        tickers = [_norm_ticker(t) for t in tickers_blob.split(",")]
        tickers = [t for t in tickers if t]

        for ticker in tickers:
            out.append(
                {
                    "ticker": ticker,
                    "category": category,
                    "company_name": None,
                    "sector": None,
                    "why_avoid": f"Extended avoid list category: {category}",
                    "source": "extended_avoid_tickers",
                }
            )
    return out


@dataclass(frozen=True)
class CriteriaRow:
    section: str
    rule_index: Optional[int]
    title: str
    detail: str
    value_text: Optional[str] = None


def parse_screening_criteria_rows(path: Path) -> list[CriteriaRow]:
    rows = _iter_rows(path)

    section: Optional[str] = None
    out: list[CriteriaRow] = []

    for row in rows:
        if not row:
            continue
        c0 = (row[0] or "").strip()
        c1 = (row[1] if len(row) > 1 else "").strip()

        if not c0 and not c1:
            continue

        if c0 == "INVESTABLE REQUIREMENTS (ALL must be met):":
            section = "investable_requirements"
            continue
        if c0 == "AUTOMATIC AVOID TRIGGERS (ANY ONE disqualifies):":
            section = "automatic_avoid_triggers"
            continue
        if c0 == "THE MATH:":
            section = "the_math"
            continue

        if section is None:
            # Skip preamble rows like "INVESTMENT SCREENING CRITERIA"
            continue

        if section in ("investable_requirements", "automatic_avoid_triggers"):
            # Example: "1. Positive Absolute FCF", "Company must generate positive free cash flow"
            if not c0:
                continue
            rule_index: Optional[int] = None
            title = c0
            if "." in c0:
                prefix, rest = c0.split(".", 1)
                if prefix.strip().isdigit():
                    rule_index = int(prefix.strip())
                    title = rest.strip()
            detail = c1 or ""
            if not detail:
                # Keep non-empty, schema requires detail TEXT NOT NULL
                detail = title
            out.append(
                CriteriaRow(section=section, rule_index=rule_index, title=title, detail=detail)
            )
            continue

        if section == "the_math":
            # Example: "Global Public Universe", "~58,000 companies"
            if not c0:
                continue
            title = c0
            value_text = c1 or None
            detail = value_text or title
            out.append(
                CriteriaRow(
                    section=section,
                    rule_index=None,
                    title=title,
                    detail=detail,
                    value_text=value_text,
                )
            )
            continue

    return out


def wipe_tables(db) -> None:
    # Order matters for FK relationships (none expected here), but keep explicit.
    for table in ("renaissance_avoid", "renaissance_screening_criteria", "renaissance_universe"):
        try:
            db.table(table).delete().execute()
            print(f"🧹 Cleared {table}")
        except Exception as e:
            # Allow running before migration 010 exists.
            print(f"⚠️  Could not clear {table}: {e}")


def main() -> None:
    missing = [
        p for p in (INVESTABLE_CSV, AVOID_CSV, EXTENDED_AVOID_CSV, CRITERIA_CSV) if not p.exists()
    ]
    if missing:
        raise FileNotFoundError(f"Missing Renaissance CSV(s): {', '.join(str(p) for p in missing)}")

    db = get_db()

    print("=== Renaissance CSV Import ===")
    wipe_tables(db)

    # 1) Extended avoid tickers first (avoid_list will overwrite with richer detail later)
    extended_avoid = parse_extended_avoid_rows(EXTENDED_AVOID_CSV)
    if extended_avoid:
        db.table("renaissance_avoid").upsert(extended_avoid, on_conflict="ticker").execute()
    print(f"✅ Loaded extended avoid tickers: {len(extended_avoid)}")

    # 2) Avoid list second (richer per-ticker reasons)
    avoid = parse_avoid_rows(AVOID_CSV)
    if avoid:
        db.table("renaissance_avoid").upsert(avoid, on_conflict="ticker").execute()
    print(f"✅ Loaded avoid list rows: {len(avoid)}")

    # 3) Screening criteria
    criteria_rows = parse_screening_criteria_rows(CRITERIA_CSV)
    if criteria_rows:
        payload = [
            {
                "section": r.section,
                "rule_index": r.rule_index,
                "title": r.title,
                "detail": r.detail,
                "value_text": r.value_text,
            }
            for r in criteria_rows
        ]
        db.table("renaissance_screening_criteria").insert(payload).execute()
    print(f"✅ Loaded screening criteria rows: {len(criteria_rows)}")

    # 4) Investable universe
    investable = parse_investable_rows(INVESTABLE_CSV)
    if investable:
        db.table("renaissance_universe").upsert(investable, on_conflict="ticker").execute()
    print(f"✅ Loaded investable universe rows: {len(investable)}")

    # Summary counts
    try:
        uni = db.execute_raw("SELECT COUNT(*)::int AS count FROM renaissance_universe").data[0][
            "count"
        ]
        avd = db.execute_raw("SELECT COUNT(*)::int AS count FROM renaissance_avoid").data[0][
            "count"
        ]
        crt = db.execute_raw(
            "SELECT COUNT(*)::int AS count FROM renaissance_screening_criteria"
        ).data[0]["count"]
        print("\n=== Summary ===")
        print(f"renaissance_universe: {uni}")
        print(f"renaissance_avoid: {avd}")
        print(f"renaissance_screening_criteria: {crt}")
    except Exception as e:
        print(f"⚠️  Could not compute summary counts: {e}")

    print("\n✅ Renaissance CSV import complete.")


if __name__ == "__main__":
    main()
