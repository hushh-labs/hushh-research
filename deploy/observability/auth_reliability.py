"""Auth availability options and policy guards for the existing reconciler.

This module performs no I/O or cloud initialization. The capacity reconciler
retains resource reconciliation and all existing operational provisioners.
"""

from __future__ import annotations

import argparse
from typing import Any


METRICS = (
    "obs_auth_service_failure_count",
    "obs_auth_allowlist_failure_count",
    "obs_auth_allowlist_health_count",
)
POLICIES = ("auth-service-failures-policy", "auth-allowlist-health-policy")


def selected_policies(args: argparse.Namespace) -> tuple[str, ...]:
    # Both deployment environments share this Firebase provider authority.
    if args.project == "hushh-pda":
        return POLICIES + ("auth-provider-failures-policy",)
    return POLICIES


def add_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--release-probe-only", action="store_true",
                        help="Manage only UAT Azure readiness timeout metrics and alerts")
    parser.add_argument("--auth-only", action="store_true",
                        help="Manage auth alerts and protected-list health metrics only")
    parser.add_argument("--enable-auth-alerts", action="store_true",
                        help="Enable auth failure delivery; otherwise auth policies stay disabled")
    parser.add_argument("--enable-auth-heartbeat", action="store_true",
                        help="Also alert on missing hourly protected-list health after 3h")


def validate_arguments(parser: argparse.ArgumentParser, args: argparse.Namespace) -> None:
    if args.release_probe_only and (args.project != "hushh-pda-uat" or args.auth_only
                                   or args.provider_only or args.voice_only or args.commerce_only
                                   or args.include_commerce or args.sql_instance or args.console_only):
        parser.error("--release-probe-only requires UAT, existing delivery channels and no other provisioner")
    if args.auth_only and (args.provider_only or args.voice_only or args.commerce_only
                           or args.include_commerce or args.sql_instance or args.release_probe_only):
        parser.error("--auth-only cannot be combined with other provisioners")
    if (args.enable_auth_alerts or args.enable_auth_heartbeat) and not args.auth_only:
        parser.error("auth enablement requires --auth-only")
    if args.enable_auth_heartbeat and not args.enable_auth_alerts:
        parser.error("--enable-auth-heartbeat requires --enable-auth-alerts")
    if args.auth_only and args.project not in {"hushh-pda", "hushh-pda-uat"}:
        parser.error("auth alerts require a governed deployment project")


def delivery_disabled(args: argparse.Namespace) -> bool:
    return args.console_only or (args.auth_only and not args.enable_auth_alerts)


def validate_channel(
    args: argparse.Namespace, matches: list[dict[str, Any]], email: str
) -> None:
    if len(matches) > 1:
        raise RuntimeError(f"Multiple email channels for {email}; resolve before applying")
    if not args.auth_only and not args.release_probe_alerts:
        return
    purpose = "Auth" if args.auth_only else "Release probe"
    if not matches:
        raise RuntimeError(f"{purpose} delivery requires an existing email notification channel")
    if matches[0].get("enabled") is False or matches[0].get("verificationStatus") == "UNVERIFIED":
        raise RuntimeError(f"{purpose} delivery requires an enabled, verified notification channel")


def configure_policy(
    args: argparse.Namespace, slug: str, desired: dict[str, Any]
) -> None:
    if not args.auth_only:
        return
    desired["enabled"] = args.enable_auth_alerts
    desired["severity"] = "ERROR" if args.enable_auth_alerts else "WARNING"
    desired["userLabels"]["incident_purpose"] = (
        "actionable" if args.enable_auth_alerts else "diagnostic"
    )
    if slug == "auth-allowlist-health-policy" and not args.enable_auth_heartbeat:
        desired["conditions"] = desired["conditions"][:1]
