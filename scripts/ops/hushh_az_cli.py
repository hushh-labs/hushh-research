#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Team Azure CLI onboarding, login, and health verification for HushOne Inc.

Ensures engineers always sign into the HushOne Inc. Microsoft Entra tenant
(`e1e09f9b-313b-4c57-a925-f2a573a919e9`) rather than their home domain tenant,
selects the canonical Azure subscription (`3f5a1e87-97d6-4f05-b4ce-0e2cc675e118`),
and verifies both ARM resource access and Microsoft Graph directory access.

Never prints access tokens or credentials.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from typing import Any, Callable

HUSHONE_TENANT_ID = "e1e09f9b-313b-4c57-a925-f2a573a919e9"
HUSHONE_SUBSCRIPTION_ID = "3f5a1e87-97d6-4f05-b4ce-0e2cc675e118"
GRAPH_ME_URI = "https://graph.microsoft.com/v1.0/me?$select=id,displayName,userPrincipalName,userType"


def _run_capture(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, capture_output=True, text=True, check=False)


def _run_interactive(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, text=True, check=False)


def check_az_posture(
    *,
    tenant_id: str = HUSHONE_TENANT_ID,
    subscription_id: str = HUSHONE_SUBSCRIPTION_ID,
    which_fn: Callable[[str], str | None] = shutil.which,
    run_fn: Callable[[list[str]], subprocess.CompletedProcess[str]] = _run_capture,
) -> dict[str, Any]:
    """Verify Azure CLI installation, active HushOne tenant/subscription, ARM, and Graph."""
    errors: list[str] = []
    az_bin = which_fn("az")
    if not az_bin:
        return {
            "ok": False,
            "installed": False,
            "tenantId": tenant_id,
            "subscriptionId": subscription_id,
            "errors": ["Azure CLI ('az') is not installed. Run: brew install azure-cli"],
        }

    acct_proc = run_fn(
        [
            "az",
            "account",
            "show",
            "--query",
            "{tenantId:tenantId,subscriptionId:id,subscriptionName:name,state:state,user:user.name}",
            "-o",
            "json",
        ]
    )
    account: dict[str, Any] = {}
    if acct_proc.returncode != 0:
        errors.append(
            f"Not signed into Azure CLI. Run: ./bin/hushh az login --tenant {tenant_id}"
        )
    else:
        try:
            account = dict(json.loads(acct_proc.stdout or "{}"))
        except json.JSONDecodeError:
            errors.append("Failed to parse 'az account show' output.")

    active_tenant = str(account.get("tenantId") or "").strip()
    active_sub = str(account.get("subscriptionId") or "").strip()
    if account and active_tenant != tenant_id:
        errors.append(
            f"Active Azure CLI tenant is '{active_tenant}', expected HushOne Inc. '{tenant_id}'. "
            f"Run: ./bin/hushh az login"
        )
    if account and active_sub != subscription_id:
        errors.append(
            f"Active subscription is '{active_sub}', expected '{subscription_id}'. "
            f"Run: az account set --subscription {subscription_id}"
        )

    rg_count: int | None = None
    if account and active_tenant == tenant_id:
        arm_proc = run_fn(
            [
                "az",
                "group",
                "list",
                "--subscription",
                subscription_id,
                "--query",
                "length(@)",
                "-o",
                "tsv",
            ]
        )
        if arm_proc.returncode != 0:
            errors.append(
                f"ARM resource access failed for subscription {subscription_id}: "
                f"{arm_proc.stderr.strip() or arm_proc.stdout.strip()}"
            )
        else:
            try:
                rg_count = int((arm_proc.stdout or "0").strip())
            except ValueError:
                rg_count = None

    me_info: dict[str, Any] = {}
    if account and active_tenant == tenant_id:
        graph_proc = run_fn(["az", "rest", "--method", "GET", "--uri", GRAPH_ME_URI, "-o", "json"])
        if graph_proc.returncode != 0:
            errors.append(
                "Microsoft Graph sign-in check failed (`AADSTS65001` / consent or token error). "
                "Re-run `./bin/hushh az login --device-code` in an incognito browser or ask an owner "
                "to run `python3 scripts/ops/reconcile_oauth_and_mail_posture.py --reconcile-all --apply`."
            )
        else:
            try:
                me_info = dict(json.loads(graph_proc.stdout or "{}"))
            except json.JSONDecodeError:
                errors.append("Failed to parse Microsoft Graph '/me' response.")

    return {
        "ok": len(errors) == 0,
        "installed": True,
        "expectedTenantId": tenant_id,
        "expectedSubscriptionId": subscription_id,
        "account": account,
        "arm": {"subscriptionId": subscription_id, "resourceGroupCount": rg_count},
        "graphMe": {
            "id": me_info.get("id"),
            "displayName": me_info.get("displayName"),
            "userPrincipalName": me_info.get("userPrincipalName"),
            "userType": me_info.get("userType"),
        }
        if me_info
        else None,
        "errors": errors,
    }


def login_az_team(
    *,
    device_code: bool = False,
    tenant_id: str = HUSHONE_TENANT_ID,
    subscription_id: str = HUSHONE_SUBSCRIPTION_ID,
    which_fn: Callable[[str], str | None] = shutil.which,
    interactive_run_fn: Callable[[list[str]], subprocess.CompletedProcess[str]] = _run_interactive,
    run_fn: Callable[[list[str]], subprocess.CompletedProcess[str]] = _run_capture,
) -> dict[str, Any]:
    """Authenticate an engineer's Azure CLI explicitly against HushOne Inc. and verify access."""
    if not which_fn("az"):
        return {
            "ok": False,
            "installed": False,
            "errors": ["Azure CLI ('az') is not installed. Run: brew install azure-cli"],
        }

    login_cmd = ["az", "login", "--tenant", tenant_id]
    if device_code:
        login_cmd.append("--use-device-code")

    proc = interactive_run_fn(login_cmd)
    if proc.returncode != 0:
        return {
            "ok": False,
            "installed": True,
            "errors": [
                f"az login failed (exit {proc.returncode}). If you hit AADSTS50020 or wrong-account "
                f"caching, open your invite in a private/incognito window or run "
                f"`./bin/hushh az login --device-code` with your Workspace email."
            ],
        }

    sub_proc = run_fn(["az", "account", "set", "--subscription", subscription_id])
    if sub_proc.returncode != 0:
        return {
            "ok": False,
            "installed": True,
            "errors": [
                f"Signed into tenant {tenant_id} but failed to select subscription "
                f"{subscription_id}: {sub_proc.stderr.strip() or sub_proc.stdout.strip()}"
            ],
        }

    return check_az_posture(
        tenant_id=tenant_id,
        subscription_id=subscription_id,
        which_fn=which_fn,
        run_fn=run_fn,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="subcommand", required=True)

    login_p = subparsers.add_parser("login", help="Sign into HushOne Inc. tenant via az login")
    login_p.add_argument("--device-code", action="store_true", help="Use terminal device-code login")
    login_p.add_argument("--tenant", default=HUSHONE_TENANT_ID)
    login_p.add_argument("--subscription", default=HUSHONE_SUBSCRIPTION_ID)
    login_p.add_argument("--json", action="store_true")

    for name in ("status", "doctor"):
        doc_p = subparsers.add_parser(name, help="Verify Azure CLI HushOne Inc. tenant & Graph health")
        doc_p.add_argument("--tenant", default=HUSHONE_TENANT_ID)
        doc_p.add_argument("--subscription", default=HUSHONE_SUBSCRIPTION_ID)
        doc_p.add_argument("--json", action="store_true")

    args = parser.parse_args(argv)
    if args.subcommand == "login":
        result = login_az_team(
            device_code=bool(args.device_code),
            tenant_id=args.tenant,
            subscription_id=args.subscription,
        )
    else:
        result = check_az_posture(tenant_id=args.tenant, subscription_id=args.subscription)

    if args.json or result.get("ok"):
        print(json.dumps(result, indent=2, sort_keys=True))
    else:
        print(json.dumps(result, indent=2, sort_keys=True), file=sys.stderr)
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
