#!/usr/bin/env python3
"""
Seed Investor Profiles from Sample JSON

Usage:
    python db/seeds/seed_investors.py
    python db/seeds/seed_investors.py --file path/to/custom.json
"""

import argparse
import json
import os
import re
import sys

# Add parent to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dotenv import load_dotenv  # noqa: E402

load_dotenv()

from db.db_client import get_db  # noqa: E402

DEFAULT_JSON = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "..",
    "docs",
    "vision",
    "kai",
    "data",
    "investor_profiles_sample.json",
)


def seed_investors(json_path: str):
    """Seed investor profiles from JSON file."""
    print(f"📂 Loading data from: {json_path}")

    with open(json_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    investors = data.get("investors", [])
    print(f"📊 Found {len(investors)} investor profiles")

    db = get_db()

    for inv in investors:
        name = inv.get("name")
        name_normalized = re.sub(r"\s+", "", name.lower()) if name else None
        cik = inv.get("cik")

        # Prepare JSONB fields as JSON strings
        top_holdings = json.dumps(inv.get("top_holdings")) if inv.get("top_holdings") else None
        sector_exposure = (
            json.dumps(inv.get("sector_exposure")) if inv.get("sector_exposure") else None
        )
        public_quotes = json.dumps(inv.get("public_quotes")) if inv.get("public_quotes") else None

        # Build the data dict
        investor_data = {
            "name": name,
            "name_normalized": name_normalized,
            "cik": cik,
            "firm": inv.get("firm"),
            "title": inv.get("title"),
            "investor_type": inv.get("investor_type", "fund_manager")
            if cik
            else ("tech_insider" if inv.get("is_insider") else "fund_manager"),
            "aum_billions": inv.get("aum_billions"),
            "top_holdings": top_holdings,
            "sector_exposure": sector_exposure,
            "investment_style": inv.get("investment_style"),
            "risk_tolerance": inv.get("risk_tolerance"),
            "time_horizon": inv.get("time_horizon"),
            "portfolio_turnover": inv.get("portfolio_turnover"),
            "recent_buys": inv.get("recent_buys"),
            "recent_sells": inv.get("recent_sells"),
            "public_quotes": public_quotes,
            "biography": inv.get("biography"),
            "education": inv.get("education"),
            "board_memberships": inv.get("board_memberships"),
            "peer_investors": inv.get("peer_investors"),
            "is_insider": inv.get("is_insider", False),
            "insider_company_ticker": inv.get("insider_company_ticker"),
        }

        # Remove None values for cleaner insert
        investor_data = {k: v for k, v in investor_data.items() if v is not None}

        # Upsert using the db client
        if cik:
            result = (
                db.table("investor_profiles").upsert(investor_data, on_conflict="cik").execute()
            )
        else:
            result = db.table("investor_profiles").insert(investor_data).execute()

        if result.error:
            print(f"   ❌ {name}: {result.error}")
        else:
            print(f"   ✅ {name}")

    # Get final count
    count_result = db.execute_raw("SELECT COUNT(*) as count FROM investor_profiles")
    if count_result.data:
        print(f"\n📊 Total investor profiles: {count_result.data[0]['count']}")


def main():
    parser = argparse.ArgumentParser(description="Seed investor profiles from JSON")
    parser.add_argument("--file", default=DEFAULT_JSON, help="Path to JSON file")
    args = parser.parse_args()

    seed_investors(args.file)
    print("\n✅ Seeding complete!")


if __name__ == "__main__":
    main()
