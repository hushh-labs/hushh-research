"""Provision or verify the least-privilege Hushh Tech UAT developer app.

This is intentionally separate from generic partner provisioning. It has no
tool-group, capability, OAuth, or production switches: the resulting app is
always bound to exactly ``hushh_tech_client``, zero generic capabilities, and
one active X25519 connector public key.

The connector private key is never accepted by this script. Keep it only in
the Hushh Tech UAT Secret Manager.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

CONSENT_PROTOCOL_ROOT = Path(__file__).resolve().parents[2]
if str(CONSENT_PROTOCOL_ROOT) not in sys.path:
    sys.path.insert(0, str(CONSENT_PROTOCOL_ROOT))


class _OwnerOnlyTokenFileSink:
    """Write a newly issued token once without exposing it to stdout."""

    def __init__(self, path_value: str):
        self.path = Path(path_value).expanduser().resolve()
        if not self.path.parent.is_dir():
            raise ValueError("token output parent directory does not exist")
        if os.path.lexists(self.path):
            raise ValueError("token output file already exists")
        self.written = False

    def __call__(self, raw_token: str) -> None:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        descriptor = os.open(self.path, flags, 0o600)
        try:
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8", closefd=True) as handle:
                descriptor = -1
                handle.write(raw_token)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            self.written = True
        except Exception:
            if descriptor >= 0:
                os.close(descriptor)
            self.cleanup()
            raise

    def cleanup(self) -> None:
        if os.path.lexists(self.path):
            self.path.unlink()
        self.written = False


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Reconcile the isolated Hushh Tech developer app in hushh-pda-uat."
    )
    parser.add_argument(
        "--app-id",
        default=os.getenv("HUSSH_TECH_DEVELOPER_APP_ID", ""),
        help="Exact app id already configured as HUSSH_TECH_DEVELOPER_APP_ID.",
    )
    parser.add_argument("--display-name", default="Hushh Technologies UAT")
    parser.add_argument("--contact-email", default="partners@hushh.ai")
    parser.add_argument("--registration-id", default="hushh-tech-uat-client")
    parser.add_argument("--connector-key-id", required=True)
    parser.add_argument(
        "--connector-public-key",
        required=True,
        help="Base64 X25519 public key only. Never provide the private key.",
    )
    parser.add_argument(
        "--provisioned-by",
        default="ops_hushh_tech_uat_reconciliation",
    )
    parser.add_argument(
        "--token-output-file",
        default=None,
        help=(
            "Owner-only (0600), create-only file for a newly issued hdk_ token. "
            "Required only when the app has no active token. Never use a CI artifact path."
        ),
    )
    parser.add_argument(
        "--verify-only",
        action="store_true",
        help="Check the exact policy without changing registry rows.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    from hushh_mcp.services.developer_registry_service import (
        DeveloperRegistryService,
        assert_hushh_tech_uat_registry_target,
    )

    parser = _parser()
    args = parser.parse_args(argv)
    app_id = str(args.app_id or "").strip()
    if not app_id:
        parser.error("--app-id or HUSSH_TECH_DEVELOPER_APP_ID is required")

    # This guard runs before constructing the service, so a production or
    # wrong-project invocation cannot even initialize a database connection.
    try:
        assert_hushh_tech_uat_registry_target(app_id=app_id)
    except ValueError as exc:
        parser.error(str(exc))

    service = DeveloperRegistryService()
    token_sink = None
    if args.token_output_file:
        try:
            token_sink = _OwnerOnlyTokenFileSink(args.token_output_file)
        except ValueError as exc:
            parser.error(str(exc))
    if args.verify_only:
        result = service.verify_hushh_tech_uat_app_policy(
            app_id=app_id,
            connector_key_id=args.connector_key_id,
            connector_public_key=args.connector_public_key,
            crm_id=args.registration_id,
        )
        issued_token = False
    else:
        try:
            result = service.reconcile_hushh_tech_uat_app(
                app_id=app_id,
                display_name=args.display_name,
                contact_email=args.contact_email,
                connector_key_id=args.connector_key_id,
                connector_public_key=args.connector_public_key,
                crm_id=args.registration_id,
                provisioned_by=args.provisioned_by,
                issued_token_sink=token_sink,
            )
        except Exception:
            # If PostgreSQL commit fails after the sink ran, remove the
            # now-unusable local credential rather than leaving ambiguity.
            if token_sink is not None and token_sink.written:
                token_sink.cleanup()
            raise
        issued_token = bool(result.get("issued_token"))

    app = result["app"]
    connector_key = result["connector_key"]
    print(f"app_id: {app['app_id']}")
    print("tool_groups: ['hushh_tech_client']")
    print("capabilities: []")
    print("oauth_client_credentials_enabled: false")
    print(f"connector_key_id: {connector_key['connector_key_id']}")
    print(f"connector_fingerprint: {connector_key['recipient_key_fingerprint']}")
    print("active_connector_keys: 1")
    print(f"verified_only: {bool(args.verify_only)}")
    if issued_token:
        print("issued_token: true")
        if token_sink is None or not token_sink.written:
            raise RuntimeError("issued token was not delivered to the secure output file")
        print(f"token_output_file: {token_sink.path}")
    elif not args.verify_only:
        print("issued_token: false")
        print("An active token already exists; its raw value was not read.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
