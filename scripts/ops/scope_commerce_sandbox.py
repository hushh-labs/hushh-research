#!/usr/bin/env python3
"""Operator sandbox setup and GET-only rehearsal preflight; secrets stay in env."""

from __future__ import annotations

import argparse
import asyncio
import fcntl
import json
import os
import stat
import sys
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any
from uuid import NAMESPACE_URL, uuid5

if TYPE_CHECKING:
    from scripts.ops.scope_commerce_sandbox_provider import SandboxProvider

    from hushh_mcp.services.scope_commerce.provider_config import ScopeCommerceProviderConfig

ROOT = Path(__file__).resolve().parents[2]
PREVIEW_PROJECT = "hushh-pda-dev"


@dataclass(frozen=True)
class PreflightEvidence:
    funding: dict[str, Any]
    refunds: dict[str, Any]
    withdrawals: dict[str, Any]
    capital_used: int
    capital_verified: bool
    backing: bool
    balanced: bool
    fee_allocation_conserved: bool


@contextmanager
def setup_state(path: str, account_id: str):
    from scripts.ops.scope_commerce_sandbox_policy import private_json

    from hushh_mcp.services.scope_commerce.stripe_adapter import CommerceProviderError

    file = Path(path).expanduser().absolute()
    if ROOT in file.parents and ROOT / "tmp" not in file.parents:
        raise CommerceProviderError("sandbox_state_requires_ignored_location")
    file.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(file, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "r+") as stream:
        details = os.fstat(stream.fileno())
        if (
            not stat.S_ISREG(details.st_mode)
            or details.st_uid != os.getuid()
            or details.st_mode & 0o077
        ):
            raise CommerceProviderError("sandbox_state_permissions_invalid")
        fcntl.flock(stream, fcntl.LOCK_EX)
        raw = stream.read()
        state = (
            private_json(str(file))
            if raw
            else {"schema_version": 1, "platform_account_id": account_id}
        )
        if state.get("schema_version") != 1 or state.get("platform_account_id") != account_id:
            raise CommerceProviderError("sandbox_state_account_mismatch")

        def persist(value: dict[str, Any]) -> None:
            stream.seek(0)
            stream.write(json.dumps(value, sort_keys=True))
            stream.truncate()
            stream.flush()
            os.fsync(stream.fileno())

        yield state, persist


async def _ledger_proof(provider: SandboxProvider, connection: Any, balance: dict[str, Any]):
    from hushh_mcp.services.scope_commerce.service import ScopeCommerceService

    store = ScopeCommerceService(provider_config=provider.config)
    position = await store.treasury_position(conn=connection)
    actual_available = sum(
        item["amount"] * 10000
        for item in balance.get("available", [])
        if item.get("currency") == "usd"
    )
    backing = (
        position["backingShortfallMicroUsd"] == 0
        and actual_available
        >= position["restrictedMicroUsd"] + position["operatingFeeReserveMicroUsd"]
    )
    balanced = await connection.fetchval("""SELECT NOT EXISTS(
        SELECT j.entry_id FROM scope_commerce_journal j LEFT JOIN scope_commerce_postings p USING(entry_id)
        GROUP BY j.entry_id HAVING COALESCE(sum(p.micro_usd),0)<>0)""")
    conservation = await store.funding_fee_conservation(conn=connection)
    return backing, balanced, conservation


async def preflight(
    provider: SandboxProvider,
    connection: Any,
    *,
    reviewers: dict[str, str],
    source: str,
    state: dict[str, Any],
) -> dict[str, Any]:
    from scripts.ops.scope_commerce_sandbox_policy import capital_budget

    from hushh_mcp.services.scope_commerce.stripe_adapter import CommerceProviderError

    identity = await provider.identity()
    pin = await connection.fetchrow(
        "SELECT platform_account_id,livemode FROM scope_commerce_environment WHERE singleton"
    )
    if (
        pin is None
        or pin["platform_account_id"] != provider.config.platform_account_id
        or pin["livemode"] is not False
    ):
        raise CommerceProviderError("sandbox_account_pin_unverified")
    funding = await provider.funding_evidence(connection, reviewers)
    topups = await provider.capital_receipts()
    capital_used = capital_budget(
        topups,
        state.get("capital_attempts", {}),
        provider.config.sandbox_policy.operating_capital_cap_cents,
    )
    capital_verified = await provider.capital_backing(connection, topups)
    backing, balanced, conservation = await _ledger_proof(provider, connection, identity["balance"])
    refunds = await provider.refunds(connection, reviewers)
    withdrawals = await provider.withdrawals(connection, reviewers)
    return _preflight_result(
        provider,
        source=source,
        evidence=PreflightEvidence(
            funding=funding,
            refunds=refunds,
            withdrawals=withdrawals,
            capital_used=capital_used,
            capital_verified=capital_verified,
            backing=backing,
            balanced=balanced,
            fee_allocation_conserved=conservation["balanced"],
        ),
    )


def _preflight_result(
    provider: SandboxProvider, *, source: str, evidence: PreflightEvidence
) -> dict[str, Any]:
    matches = all(
        attempt["providerVerified"] and attempt["creditedOnce"]
        for facts in evidence.funding.values()
        for attempt in facts["fundingAttempts"]
        if attempt["status"] in {"paid", "refund_pending", "refunded"}
    )
    policy = provider.config.sandbox_policy
    fee_receipts = all(
        item["feeReceiptsMatched"]
        for items in evidence.withdrawals.values()
        for item in items
        if item["status"] == "succeeded"
    )
    return {
        "readiness": bool(
            evidence.capital_verified
            and evidence.backing
            and evidence.balanced
            and matches
            and evidence.fee_allocation_conserved
            and fee_receipts
        ),
        "sandbox": True,
        "appOrigin": provider.config.frontend_origin,
        "platformAccountId": provider.config.platform_account_id,
        "account_pin_verified": True,
        "isolated_environment": True,
        "isolation_evidence_verified": True,
        "isolation_source": source,
        "isolation_evidence_kind": "operator_attestation",
        "budgetPolicyActive": True,
        "reviewerFundingCapCents": policy.reviewer_funding_cap_cents,
        "platformCapitalCapCents": policy.operating_capital_cap_cents,
        "reviewerFundingUsedCents": {
            role: facts["usedCents"] for role, facts in evidence.funding.items()
        },
        "platformCapitalUsedCents": evidence.capital_used,
        "ledgerProviderMatches": bool(matches and evidence.capital_verified),
        "funding": evidence.funding,
        "refunds": evidence.refunds,
        "withdrawals": evidence.withdrawals,
        "liabilitiesBalanced": bool(evidence.balanced),
        "settledBacking": evidence.backing,
        "sourceFeeReceiptsMatched": bool(matches),
        "fundingFeeAllocationConserved": bool(evidence.fee_allocation_conserved),
        "feesConserved": bool(matches and evidence.fee_allocation_conserved and fee_receipts),
        "feeConservationScope": "funding_allocations_and_verified_successful_transfer_payout_receipts",
        "liveCostModelVerified": False,
    }


def _runtime(args: argparse.Namespace):
    from scripts.ops.scope_commerce_sandbox_policy import (
        isolation_evidence,
        private_json,
        reviewer_bindings,
    )
    from scripts.ops.scope_commerce_sandbox_provider import SandboxProvider

    from hushh_mcp.services.scope_commerce.provider_config import (
        ScopeCommerceProviderConfig,
    )
    from hushh_mcp.services.scope_commerce.stripe_adapter import (
        CommerceProviderError,
        StripeScopeCommerceAdapter,
    )

    config = ScopeCommerceProviderConfig.from_env()
    if args.account_id != config.platform_account_id or config.sandbox_policy is None:
        raise CommerceProviderError("sandbox_policy_account_mismatch")
    reviewers = reviewer_bindings(private_json(args.reviewer_binding_file), config.sandbox_policy)
    evidence = private_json(args.isolation_evidence_file)
    source = isolation_evidence(evidence, args.account_id)
    secret = os.getenv("SCOPE_COMMERCE_STRIPE_SECRET_KEY") or ""
    if not secret.startswith("sk_test_") or len(secret) < 24:
        raise CommerceProviderError("sandbox_test_credentials_required")
    return (
        SandboxProvider(StripeScopeCommerceAdapter(secret, "unused-for-provider-get"), config),
        reviewers,
        source,
        evidence,
    )


def _secret_destination(
    args: argparse.Namespace,
    evidence: dict[str, Any],
    *,
    config: ScopeCommerceProviderConfig,
    pin: dict[str, Any],
) -> str:
    from scripts.ops.scope_commerce_sandbox_policy import (
        isolation_evidence,
        shared_dev_webhook_destination,
    )

    from hushh_mcp.services.scope_commerce.stripe_adapter import CommerceProviderError

    config.validate(new_activity=False)
    source = isolation_evidence(evidence, args.account_id)
    preview_names = {
        "platform": "SCOPE_COMMERCE_SANDBOX_SCOPE_COMMERCE_STRIPE_WEBHOOK_SECRET",
        "connect": "SCOPE_COMMERCE_SANDBOX_SCOPE_COMMERCE_STRIPE_CONNECT_WEBHOOK_SECRET",
    }
    account_name = f"scope-commerce-sandbox-{args.account_id}-{args.webhook_scope}-webhook"
    preview = args.secret_name == preview_names.get(args.webhook_scope)
    shared = shared_dev_webhook_destination(args, evidence, config)
    if (
        config.sandbox_policy is None
        or config.livemode
        or config.platform_account_id != args.account_id
        or pin.get("platform_account_id") != args.account_id
        or pin.get("livemode") is not False
        or args.webhook_scope not in preview_names
        or (args.secret_name != account_name and not preview and not shared)
        or not args.secret_project
        or args.secret_project != evidence.get("secret_project")
        or (preview and args.secret_project != PREVIEW_PROJECT)
        or (preview and source != "dashboard_general_sandbox")
    ):
        raise CommerceProviderError("sandbox_secret_destination_unapproved")
    return f"projects/{args.secret_project}/secrets/{args.secret_name}"


def _secret_sink(
    args: argparse.Namespace,
    evidence: dict[str, Any],
    *,
    config: ScopeCommerceProviderConfig,
    pin: dict[str, Any],
):
    destination = _secret_destination(args, evidence, config=config, pin=pin)

    def store(secret: str) -> None:
        from google.cloud import secretmanager

        client = secretmanager.SecretManagerServiceClient()
        # The parent operator precreates this dedicated destination. This helper
        # cannot create projects/secrets or replace a Drive/live secret name.
        client.get_secret(request={"name": destination})
        client.add_secret_version(
            request={"parent": destination, "payload": {"data": secret.encode()}}
        )

    return store


async def _execute(args, provider, connection, evidence):
    from scripts.ops.scope_commerce_sandbox_provider import WebhookProvisioner

    from hushh_mcp.services.scope_commerce.service import ScopeCommerceService
    from hushh_mcp.services.scope_commerce.stripe_adapter import CommerceProviderError

    if not args.execute:
        raise CommerceProviderError("sandbox_operator_execution_required")
    await provider.identity()
    store = ScopeCommerceService(provider_config=provider.config)
    if args.command == "bind-account":
        async with connection.transaction():
            await store.bind_environment(
                platform_account_id=args.account_id, livemode=False, conn=connection
            )
        return {
            "status": "bound",
            "platformAccountId": args.account_id,
            "sandbox": True,
        }
    pin = await connection.fetchrow(
        "SELECT platform_account_id,livemode FROM scope_commerce_environment WHERE singleton"
    )
    if pin is None or pin["platform_account_id"] != args.account_id or pin["livemode"] is not False:
        raise CommerceProviderError("sandbox_account_pin_unverified")
    with setup_state(args.operation_state_file, args.account_id) as (state, persist):
        operation_id = args.operation_id or str(
            uuid5(
                NAMESPACE_URL,
                f"scope-commerce:{args.account_id}:{args.command}:{args.webhook_scope}",
            )
        )
        if args.command == "provision-webhook":
            return await WebhookProvisioner(provider).provision(
                scope=args.webhook_scope,
                url=args.webhook_url,
                api_version=args.api_version,
                operation_id=operation_id,
                state=state,
                persist=persist,
                write_secret=_secret_sink(args, evidence, config=provider.config, pin=dict(pin)),
            )
        if args.command != "provision-capital":
            raise CommerceProviderError("sandbox_command_invalid")
        return await provider.provision_capital(
            state,
            operation_id=operation_id,
            amount_cents=args.amount_cents,
            persist=persist,
        )


async def run(args: argparse.Namespace) -> dict[str, Any]:
    from scripts.ops.scope_commerce_sandbox_policy import private_json

    from db.connection import dedicated_connection
    from hushh_mcp.services.scope_commerce.stripe_adapter import CommerceProviderError

    provider, reviewers, source, evidence = _runtime(args)
    async with dedicated_connection() as connection:
        if args.command != "preflight":
            return await _execute(args, provider, connection, evidence)
        state = private_json(args.operation_state_file)
        if state.get("platform_account_id") != args.account_id:
            raise CommerceProviderError("sandbox_state_account_mismatch")
        async with connection.transaction(isolation="repeatable_read", readonly=True):
            return await preflight(
                provider, connection, reviewers=reviewers, source=source, state=state
            )


def main() -> int:
    sys.path.insert(0, str(ROOT))
    sys.path.insert(0, str(ROOT / "consent-protocol"))
    from hushh_mcp.services.scope_commerce.stripe_adapter import CommerceProviderError

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command",
        choices=("preflight", "bind-account", "provision-capital", "provision-webhook"),
    )
    parser.add_argument("--account-id", required=True)
    parser.add_argument("--reviewer-binding-file", required=True)
    parser.add_argument("--isolation-evidence-file", required=True)
    parser.add_argument(
        "--operation-state-file",
        default=os.getenv("SCOPE_COMMERCE_SANDBOX_OPERATION_STATE_FILE", ""),
    )
    parser.add_argument("--operation-id", default="")
    parser.add_argument("--amount-cents", type=int, default=2500)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--webhook-scope", choices=("platform", "connect"), default="platform")
    parser.add_argument("--webhook-url", default="")
    parser.add_argument("--api-version", default="")
    parser.add_argument("--secret-project", default="")
    parser.add_argument("--secret-name", default="")
    args = parser.parse_args()
    if not args.operation_state_file and args.command != "bind-account":
        parser.error("an ignored private --operation-state-file is required")
    if args.command == "provision-webhook" and not (args.secret_project and args.secret_name):
        parser.error("approved --secret-project and --secret-name are required")
    try:
        result = asyncio.run(run(args))
    except Exception as error:
        code = (
            error.code
            if isinstance(error, CommerceProviderError)
            else "sandbox_preflight_unverified"
        )
        print(json.dumps({"readiness": False, "code": code}))
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0 if result.get("readiness", True) else 1


if __name__ == "__main__":
    raise SystemExit(main())
