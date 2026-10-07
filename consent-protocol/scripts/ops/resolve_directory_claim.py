"""Verify or reject a pending White Pages listing claim (operator tool).

A verified phone proves who holds the phone, not who the listed person is. Before
verifying, check the claimant against the listing's public record (the NPI
registry, the state DOI lookup, the SEC filing) and record what you checked.

    uv run python scripts/ops/resolve_directory_claim.py --list
    uv run python scripts/ops/resolve_directory_claim.py <claim_id> --verify --note "NPI 1234567890 matched"
    uv run python scripts/ops/resolve_directory_claim.py <claim_id> --reject --note "name mismatch"
"""

from __future__ import annotations

import argparse
import asyncio

from db.db_client import get_db
from hushh_mcp.services.directory_claim_service import TABLE, DirectoryClaimService


def _list_pending() -> None:
    rows = (
        get_db().table(TABLE).select("*").eq("status", "pending").order("created_at").execute().data
    )
    if not rows:
        print("no pending claims")
    for r in rows:
        print(f"{r['id']}  {r['listing_id']:<32}  {r['listing_name']:<40}  {r['created_at']}")


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("claim_id", nargs="?")
    group = ap.add_mutually_exclusive_group()
    group.add_argument("--list", action="store_true", help="list pending claims")
    group.add_argument("--verify", action="store_true")
    group.add_argument("--reject", action="store_true")
    ap.add_argument("--note", default=None, help="what you checked (kept on the claim)")
    args = ap.parse_args()

    if args.list or not args.claim_id:
        _list_pending()
        return
    if not (args.verify or args.reject):
        ap.error("pass --verify or --reject")
    claim = asyncio.run(
        DirectoryClaimService().resolve_claim(
            claim_id=args.claim_id, verified=args.verify, note=args.note
        )
    )
    print(claim or "no pending claim with that id")


if __name__ == "__main__":
    main()
