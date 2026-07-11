"""Maintainer script: provision a partner-class developer app + token for one CRM system.

Architecture rule: every CRM system operating the Hussh MCP gets its OWN
partner app + hdk_ token, so revocation, audit, and last-used telemetry stay
per-system. Partner apps carry kind='partner_crm', have no owner_firebase_uid
(never collide with the self-serve portal contract), and optionally soft-link
to enterprise_crm_registry via crm_id.

The raw token is printed EXACTLY ONCE to stdout on issuance and is never
persisted in plaintext (only its HMAC hash is stored). Store it in the
partner's secret manager immediately.

Usage (local/UAT via the running Cloud SQL proxy env):

    cd consent-protocol
    python scripts/ops/provision_partner_developer_app.py \
      --display-name "Hushh Technologies" \
      --contact-email partners@hushh.ai \
      [--crm-id salesforce-fsc-hushh] \
      [--tool-groups core_consent] \
      [--rotate] \
      [--revoke]

Idempotent: re-running without --rotate reuses the existing app and issues a
token only when none is active.
"""

from __future__ import annotations

import argparse
import sys

from hushh_mcp.services.developer_registry_service import DeveloperRegistryService


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Provision a partner-class developer app + token for one CRM system."
    )
    parser.add_argument("--display-name", required=True, help='e.g. "Hushh Technologies"')
    parser.add_argument("--contact-email", required=True)
    parser.add_argument(
        "--crm-id",
        default=None,
        help="Optional soft link to enterprise_crm_registry.crm_id",
    )
    parser.add_argument(
        "--tool-groups",
        default="core_consent",
        help="Comma-separated tool groups (default: core_consent)",
    )
    parser.add_argument("--notes", default=None)
    parser.add_argument(
        "--provisioned-by",
        default="ops_partner_provisioning",
        help="Audit label recorded as approved_by / token created_by",
    )
    parser.add_argument(
        "--rotate",
        action="store_true",
        help="Revoke all active tokens for the app and issue a fresh one",
    )
    parser.add_argument(
        "--revoke",
        action="store_true",
        help="Revoke all active tokens for the app and exit (no new token)",
    )
    args = parser.parse_args()

    service = DeveloperRegistryService()
    groups = [part.strip() for part in str(args.tool_groups or "").split(",") if part.strip()]

    if args.revoke or args.rotate:
        existing = service.get_partner_app_by_display_name(args.display_name)
        if not existing:
            print(
                f"ERROR: no partner_crm app found with display_name={args.display_name!r}.",
                file=sys.stderr,
            )
            return 2
        service.revoke_active_tokens(app_id=str(existing["app_id"]), revoked_by=args.provisioned_by)
        print(f"Revoked all active tokens for app_id={existing['app_id']}.")
        if args.revoke:
            return 0

    result = service.provision_partner_app(
        display_name=args.display_name,
        contact_email=args.contact_email,
        crm_id=args.crm_id,
        allowed_tool_groups=groups,
        notes=args.notes,
        provisioned_by=args.provisioned_by,
    )

    app = result["app"]
    token = result["active_token"] or {}
    print(f"app_id:        {app['app_id']}")
    print(f"agent_id:      {app['agent_id']}")
    print(f"kind:          {app.get('kind')}")
    print(f"crm_id:        {app.get('crm_id') or '(none)'}")
    print(f"tool_groups:   {app.get('allowed_tool_groups')}")
    print(f"created_app:   {result['created_app']}")
    print(f"issued_token:  {result['issued_token']}")
    print(f"token_prefix:  {token.get('token_prefix')}")
    if result["raw_token"]:
        print("")
        print("RAW TOKEN (shown once, store it in the partner's secret manager NOW):")
        print(result["raw_token"])
    else:
        print("")
        print(
            "An active token already exists; raw value is not recoverable. "
            "Use --rotate to revoke and reissue."
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
