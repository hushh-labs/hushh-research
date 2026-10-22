"""Restricted operator entrypoint; no per-company approval or mailbox output."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path

import asyncpg

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hushh_mcp.services.email_auth.contracts import POLICY_VERSION, normalize_domain
from hushh_mcp.services.email_auth.domain_policy import RiskSnapshot
from hushh_mcp.services.email_auth.store import PostgresEmailAuthStore


async def run(args) -> dict:
    # Explicit operator target: do not inherit a developer's normal application DB.
    url = os.getenv("EMAIL_AUTH_POLICY_DATABASE_URL")
    if not url:
        raise ValueError("Set EMAIL_AUTH_POLICY_DATABASE_URL in the operator environment.")
    async with asyncpg.create_pool(url, min_size=1, max_size=2) as pool:
        database = await pool.fetchval("SELECT current_database()")
        if args.command == "status":
            rows = await pool.fetch(
                "SELECT status,count(*) AS count FROM email_auth_domain_decisions GROUP BY status"
            )
            return {"database": database, "domains": [dict(row) for row in rows]}
        if not args.actor or not args.reason or args.expected_database != database:
            raise ValueError("Mutations require actor, reason and matching expected database.")
        if (
            len(args.actor) > 128
            or len(args.reason) > 256
            or any(ord(char) < 32 for char in args.actor + args.reason)
        ):
            raise ValueError("Operator identity/reason exceeds policy bounds.")
        if args.command == "activate":
            risk = RiskSnapshot.load(args.manifest)
            if risk.expires_at <= time.time():
                raise ValueError("Cannot activate expired evidence.")
            async with pool.acquire() as conn, conn.transaction():
                await conn.execute(
                    "INSERT INTO email_auth_policy_state VALUES(TRUE,$1,$2) "
                    "ON CONFLICT(singleton) DO UPDATE SET policy_version=$1,risk_version=$2",
                    POLICY_VERSION,
                    risk.version,
                )
            return {
                "action": "activated",
                "policy": POLICY_VERSION,
                "risk": risk.version,
                "actor": args.actor,
                "reason": args.reason,
                "restart_required": True,
            }
        domain = normalize_domain(args.domain or "")
        store = PostgresEmailAuthStore(pool)
        if args.command == "revoke":
            await store.revoke_domain(domain, actor=args.actor, reason=args.reason)
        else:
            # Removing a revocation requests fresh normal evaluation; it never approves.
            async with pool.acquire() as conn, conn.transaction():
                await conn.execute(
                    "UPDATE email_auth_domain_decisions SET status='pending',reason=$2,"
                    "generation=generation+1,review_id=NULL,lease_until=NULL,"
                    "expires_at=clock_timestamp() WHERE domain=$1",
                    domain,
                    json.dumps(
                        {
                            "decision": "operator_reevaluate",
                            "actor": args.actor,
                            "reason": args.reason,
                        }
                    ),
                )
                await conn.execute(
                    "UPDATE email_auth_challenges SET cancelled_at=clock_timestamp(),payload=NULL,"
                    "delivery_state='cancelled' WHERE domain=$1 AND consumed_at IS NULL",
                    domain,
                )
        return {
            "action": args.command,
            "domain": domain,
            "actor": args.actor,
            "reason": args.reason,
            "status": "revoked" if args.command == "revoke" else "pending",
        }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["status", "activate", "revoke", "reevaluate"])
    parser.add_argument("--actor")
    parser.add_argument("--reason")
    parser.add_argument("--expected-database")
    parser.add_argument("--domain")
    parser.add_argument("--manifest", default="config/email-auth/risk-manifest.json")
    args = parser.parse_args()
    try:
        print(json.dumps(asyncio.run(run(args))))
        return 0
    except Exception as error:
        # Connection errors can embed credentials/host details: no raw exception output.
        print(json.dumps({"error": "policy_operation_failed", "type": type(error).__name__}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
