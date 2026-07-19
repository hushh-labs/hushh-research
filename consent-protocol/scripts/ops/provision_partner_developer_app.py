"""Maintainer script: provision a partner-class developer app + MCP credentials.

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
      [--schema-profile flat --enable-client-credentials \
       --connector-key-id partner-key-2026-07 \
       --connector-public-key "$PARTNER_X25519_PUBLIC_KEY"] \
      [--rotate] \
      [--revoke]

Idempotent: re-running without --rotate reuses the existing app and issues a
token only when none is active.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

CONSENT_PROTOCOL_ROOT = Path(__file__).resolve().parents[2]
if str(CONSENT_PROTOCOL_ROOT) not in sys.path:
    sys.path.insert(0, str(CONSENT_PROTOCOL_ROOT))

INTEGRATION_TARGET_GENERIC = "generic"
INTEGRATION_TARGET_MULESOFT_AGENTFORCE = "mulesoft-agentforce"


def _apply_integration_defaults(parser: argparse.ArgumentParser, args: argparse.Namespace) -> None:
    """Apply a named partner integration without changing the global default.

    Existing MCP applications keep the standard profile. The named MuleSoft →
    Agentforce target always receives the narrow Agentforce UAT catalog and an
    app-bound OAuth client credential. It never authorizes personalized tool
    execution.
    """

    if args.integration_target != INTEGRATION_TARGET_MULESOFT_AGENTFORCE:
        return
    if args.schema_profile not in {"standard", "agentforce"}:
        parser.error(
            "--integration-target mulesoft-agentforce requires the agentforce schema profile"
        )
    args.schema_profile = "agentforce"
    args.enable_client_credentials = True


def main() -> int:
    from hushh_mcp.services.developer_oauth_service import DeveloperOAuthService
    from hushh_mcp.services.developer_registry_service import DeveloperRegistryService

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
        "--schema-profile",
        choices=("standard", "flat", "agentforce"),
        default="standard",
        help=(
            "Authenticated MCP catalog profile. agentforce is schema-registration UAT only; "
            "user-specific calls fail closed until Salesforce supports them."
        ),
    )
    parser.add_argument(
        "--integration-target",
        choices=(INTEGRATION_TARGET_GENERIC, INTEGRATION_TARGET_MULESOFT_AGENTFORCE),
        default=INTEGRATION_TARGET_GENERIC,
        help=(
            "Named partner integration. mulesoft-agentforce selects the strict Agentforce "
            "UAT catalog and app-bound OAuth client credentials; it does not enable "
            "personalized Agentforce execution."
        ),
    )
    parser.add_argument(
        "--enable-client-credentials",
        action="store_true",
        help="Explicitly permit OAuth client_credentials for a constrained-profile partner app.",
    )
    parser.add_argument(
        "--connector-public-key",
        default=None,
        help="Partner-owned base64 X25519 public key. Never provide a private key.",
    )
    parser.add_argument(
        "--connector-key-id",
        default=None,
        help="Partner key identifier used to select its private key during decryption.",
    )
    parser.add_argument(
        "--connector-wrapping-alg",
        default="X25519-AES256-GCM",
        help="Registered wrapping algorithm (currently fixed to X25519-AES256-GCM).",
    )
    parser.add_argument(
        "--retire-existing-connector-key",
        action="store_true",
        help="Explicitly retire the active key before registering a new key id.",
    )
    parser.add_argument(
        "--rotate-oauth-client",
        action="store_true",
        help="Rotate the OAuth client secret and print the new value once.",
    )
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

    _apply_integration_defaults(parser, args)

    if args.enable_client_credentials and args.schema_profile not in {"flat", "agentforce"}:
        parser.error("--enable-client-credentials requires a constrained schema profile")
    supplied_key_values = (args.connector_public_key, args.connector_key_id)
    if any(value for value in supplied_key_values) and not all(supplied_key_values):
        parser.error("--connector-public-key and --connector-key-id must be supplied together")

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
    if args.connector_public_key:
        service.register_connector_key(
            app_id=str(app["app_id"]),
            connector_key_id=args.connector_key_id,
            connector_public_key=args.connector_public_key,
            connector_wrapping_alg=args.connector_wrapping_alg,
            retire_existing=args.retire_existing_connector_key,
        )
    if args.enable_client_credentials and not service.get_active_connector_key(
        app_id=str(app["app_id"])
    ):
        parser.error(
            "--enable-client-credentials requires an active registered connector public key"
        )
    if args.schema_profile != "standard" or args.enable_client_credentials:
        app = service.configure_partner_mcp_profile(
            app_id=str(app["app_id"]),
            schema_profile=args.schema_profile,
            enable_client_credentials=args.enable_client_credentials,
        )

    oauth_client = None
    raw_client_secret = None
    if args.enable_client_credentials:
        oauth = DeveloperOAuthService()
        oauth_client = oauth.get_client_for_app(str(app["app_id"]))
        if oauth_client is None or args.rotate_oauth_client:
            oauth_client, raw_client_secret = oauth.create_or_rotate_client(
                app_id=str(app["app_id"])
            )

    token = result["active_token"] or {}
    print(f"app_id:        {app['app_id']}")
    print(f"agent_id:      {app['agent_id']}")
    print(f"kind:          {app.get('kind')}")
    print(f"crm_id:        {app.get('crm_id') or '(none)'}")
    print(f"tool_groups:   {app.get('allowed_tool_groups')}")
    print(f"integration_target: {args.integration_target}")
    print(f"schema_profile:{app.get('schema_profile') or 'standard'}")
    print(f"client_credentials_enabled: {bool(app.get('oauth_client_credentials_enabled'))}")
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
    if oauth_client:
        print("")
        print(f"oauth_client_id: {oauth_client.client_id}")
        print(f"oauth_client_secret_prefix: {oauth_client.client_secret_prefix}")
        if raw_client_secret:
            print("OAUTH CLIENT SECRET (shown once, store it in the partner's secret manager NOW):")
            print(raw_client_secret)
        else:
            print(
                "An OAuth client already exists; its raw secret is not recoverable. Use --rotate-oauth-client to rotate."
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
