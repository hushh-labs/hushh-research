"""Cleanup-only use of existing encrypted Shared provider custody.

No BYOC credential is imported. Only the original Shared rows are opened by
their owning cryptographic adapters. Descriptors contain hashes, never tokens.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import httpx
from sqlalchemy import text

from hushh_mcp.services.curated_connector_manifest import get_manifest

_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"

_SOURCES = (
    ("google_provider_connections", "provider"),
    ("google_calendar_additional_accounts", "account_id"),
    ("kai_gmail_connections", "user_id"),
    ("user_external_connector_connections", "connector_id"),
    ("external_connector_oauth_attempts", "attempt_id"),
)
_CLIENT_ID = re.compile(r"^([0-9]{4,32})-[a-z0-9]{8,64}\.apps\.googleusercontent\.com$")


class CleanupCredentialUnavailable(RuntimeError):
    """Unreadable or unverifiable custody remains retained for owner repair."""


class CleanupProviderUnavailable(CleanupCredentialUnavailable):
    """A read/verification outage can retry without replaying a dispatched effect."""


@dataclass(repr=False)
class CleanupGrant:
    reference: str
    owner_id: str
    source: str
    row: dict = field(repr=False)
    kind: str = "unverified"
    client_id: str = field(default="", repr=False)
    client_secret: str = field(default="", repr=False)
    refresh_token: str = field(default="", repr=False)
    subject: str = field(default="", repr=False)
    project_number: str = ""
    connector_id: str = ""
    credential: dict = field(default_factory=dict, repr=False)
    access_token: str = field(default="", repr=False)
    verified: bool = False

    def descriptor(self) -> dict[str, str]:
        support = (
            "unsupported"
            if self.kind == "unsupported"
            else "required"
            if self.kind in {"google", "curated"}
            else "unverified"
        )
        result = {"revocationSupport": support}
        if self.kind == "google":
            result["groupDigest"] = hashlib.sha256(
                json.dumps(
                    ["google-oauth-project-account-v1", self.project_number, self.subject],
                    separators=(",", ":"),
                ).encode()
            ).hexdigest()
        return result


async def _google_json(method: str, url: str, *, form=None, bearer: str | None = None):
    from hushh_mcp.services import pod_google_oauth as google
    from hushh_mcp.services.mcp_public_http import create_public_mcp_http_client

    if (method, url) not in {
        ("POST", google.TOKEN_URL),
        ("POST", google.REVOKE_URL),
        ("GET", _USERINFO_URL),
    }:
        raise CleanupCredentialUnavailable("Cleanup destination is invalid")
    try:
        async with (
            asyncio.timeout(8),
            create_public_mcp_http_client(
                timeout=httpx.Timeout(5), max_response_bytes=65536
            ) as client,
        ):
            response = await client.request(
                method,
                url,
                data=form,
                headers={"Authorization": f"Bearer {bearer}"} if bearer else None,
            )
            if response.status_code == 429 or response.status_code >= 500:
                raise CleanupProviderUnavailable("Provider cleanup is temporarily unavailable")
            try:
                body = response.json()
            except ValueError:
                body = None
            return response.status_code, body if isinstance(body, dict) else None
    except CleanupProviderUnavailable:
        raise
    except Exception:
        # Transport exceptions may quote a bearer or a form. Only this typed
        # refusal leaves the cleanup adapter.
        raise CleanupProviderUnavailable("Provider cleanup is temporarily unavailable") from None


async def _google_post(url: str, form):
    return await _google_json("POST", url, form=form)


def seal_refresh(grant: CleanupGrant, refresh_token: str) -> dict:
    """Retain replacement authority without trusting returned identity/expiry."""
    if not refresh_token:
        raise CleanupCredentialUnavailable("Provider refresh authority is unavailable")
    row, owner = grant.row, grant.owner_id
    if grant.source in {"google_provider_connections", "google_calendar_additional_accounts"}:
        from hushh_mcp.services.google_connection_service import get_google_connection_service

        service = get_google_connection_service()
        aad = (
            service._calendar_account_aad(owner, row["account_id"])
            if grant.source == "google_calendar_additional_accounts"
            else f"google-connection:{owner}"
        )
        sealed = service._encrypt(refresh_token, aad=aad)
        return {f"refresh_token_{key}": sealed[key] for key in ("ciphertext", "iv", "tag")}
    if grant.source == "kai_gmail_connections":
        from hushh_mcp.services.gmail_receipts_service import get_gmail_receipts_service

        sealed = get_gmail_receipts_service()._encrypt_token(refresh_token)
        return {
            **{f"refresh_token_{key}": sealed[key] for key in ("ciphertext", "iv", "tag")},
            "token_updated_at": datetime.now(UTC).isoformat(),
        }
    from hushh_mcp.services.external_connector_credentials_service import (
        get_external_connector_credentials_service,
    )

    service = get_external_connector_credentials_service()
    credential = {**grant.credential, "refreshToken": refresh_token}
    if grant.source == "external_connector_oauth_attempts":
        from hushh_mcp.services.external_connector_google_oauth import _attempt_aad

        sealed = service.encrypt_secret(json.dumps(credential), aad=_attempt_aad(row, "pending"))
        return {
            "pending_credential_ciphertext": sealed["ciphertext"],
            "pending_credential_iv": sealed["iv"],
        }
    if grant.source != "user_external_connector_connections" or row.get("envelope_version") != 2:
        raise CleanupCredentialUnavailable("Provider refresh custody is unsupported")
    expiry = row["credential_expires_at"]
    if isinstance(expiry, str):
        expiry = datetime.fromisoformat(expiry)
    version = int(row["credential_version"]) + 1
    sealed = service.seal_credential(
        user_id=owner,
        connector_id=grant.connector_id,
        generation=int(row["connection_generation"]),
        version=version,
        secret=credential,
        expires_at=expiry,
    )
    return {
        "credential_ciphertext": sealed["ciphertext"],
        "credential_iv": sealed["iv"],
        "credential_algorithm": sealed["algorithm"],
        "credential_version": version,
    }


async def refresh_and_capture(grant: CleanupGrant, *, claim):
    from hushh_mcp.services import account_deletion_provider_journal as journal
    from hushh_mcp.services import pod_google_oauth as google
    from hushh_mcp.services.account_deletion_lifecycle_service import settle_cleanup_database_call

    operation = await settle_cleanup_database_call(
        journal.dispatch_refresh, claim, reference=grant.reference
    )

    async def refresh_owned():
        current = await google.refresh(
            client_id=grant.client_id,
            client_secret=grant.client_secret or None,
            refresh_token=grant.refresh_token,
            scopes=(),
            post=_google_post,
        )
        replacement = current.refresh_token or grant.refresh_token
        encrypted = seal_refresh(grant, replacement)
        await settle_cleanup_database_call(
            journal.capture_refresh, operation, grant=grant, encrypted_update=encrypted
        )
        grant.refresh_token = replacement
        grant.credential = {**grant.credential, "refreshToken": replacement}
        return current

    # Cancellation cannot interrupt between receiving a replacement and storing
    # it. The bounded provider/DB operations are joined, not left as descendants.
    owned = asyncio.create_task(refresh_owned())
    try:
        return await asyncio.shield(owned)
    except asyncio.CancelledError:
        try:
            await owned
        except Exception:
            pass  # The committed dispatch remains uncertain; never replay it.
        raise


async def verify_grant(grant: CleanupGrant, *, claim) -> None:
    """Establish Google client/account binding before any watch or revocation."""
    if grant.kind == "unverified":
        raise CleanupCredentialUnavailable("Connection needs cleanup authorization")
    if grant.kind != "google":
        grant.verified = True  # Strict local AAD + reviewed provider/client pins.
        return
    from hushh_mcp.services import pod_google_oauth as google

    try:
        current = await refresh_and_capture(grant, claim=claim)
        if current.id_token:
            subject = google.id_token_subject(current.id_token, client_id=grant.client_id)
        else:
            status, identity = await _google_json("GET", _USERINFO_URL, bearer=current.access_token)
            subject = identity.get("sub") if status == 200 and isinstance(identity, dict) else None
        if subject != grant.subject:
            raise CleanupCredentialUnavailable("Provider cleanup account changed")
        if grant.source == "kai_gmail_connections":
            granted = set(current.scopes) or set(
                re.split(r"[\s,]+", str(grant.row.get("scope_csv") or ""))
            )
            if not granted.intersection(
                {
                    "https://mail.google.com/",
                    "https://www.googleapis.com/auth/gmail.modify",
                    "https://www.googleapis.com/auth/gmail.readonly",
                    "https://www.googleapis.com/auth/gmail.metadata",
                }
            ):
                raise CleanupCredentialUnavailable("Mail cleanup permission is unavailable")
        grant.access_token = current.access_token
        grant.verified = True
    except CleanupCredentialUnavailable:
        raise
    except google.GoogleOAuthError as exc:
        if exc.code == google.PROVIDER_UNREACHABLE:
            raise CleanupProviderUnavailable(
                "Provider cleanup is temporarily unavailable"
            ) from None
        raise CleanupCredentialUnavailable("Connection needs cleanup authorization") from None
    except Exception:
        raise CleanupCredentialUnavailable("Connection needs cleanup authorization") from None


async def stop_watch(grant: CleanupGrant) -> str:
    if not grant.verified or grant.source != "kai_gmail_connections":
        raise CleanupCredentialUnavailable("Watch cleanup binding is unverified")
    from hushh_mcp.services.gmail_receipts_service import get_gmail_receipts_service

    return await get_gmail_receipts_service().stop_watch_for_account_cleanup(
        grant.row, user_id=grant.owner_id, verified_access_token=grant.access_token
    )


async def revoke_grant(grant: CleanupGrant) -> str:
    if not grant.verified:
        raise CleanupCredentialUnavailable("Provider cleanup binding is unverified")
    if grant.kind == "google":
        from hushh_mcp.services import pod_google_oauth as google

        outcome = await google.revoke_outcome(grant.refresh_token, post=_google_post)
        return {
            "grant_revoked": "revoked",
            "token_absent": "token_absent",
            "unconfirmed": "uncertain",
        }[outcome]
    if grant.kind != "curated":
        raise CleanupCredentialUnavailable("Provider does not support grant revocation")
    from hushh_mcp.services.external_connector_curated_oauth import post_revocation

    manifest = get_manifest(grant.connector_id)
    if manifest is None or not manifest.revocation_url:
        raise CleanupCredentialUnavailable("Provider cleanup configuration changed")
    refresh = grant.credential.get("refreshToken")
    token = refresh or grant.credential.get("accessToken")
    if not isinstance(token, str) or not token:
        raise CleanupCredentialUnavailable("Provider cleanup token is unavailable")
    try:
        await post_revocation(
            url=manifest.revocation_url,
            data={
                "token": token,
                "token_type_hint": "refresh_token" if refresh else "access_token",
                "client_id": grant.client_id,
                **({"client_secret": grant.client_secret} if grant.client_secret else {}),
            },
        )
        return "revoked"
    except Exception:
        return "uncertain"


def _configured_google_project(client_id: str) -> str:
    # These are server-owned OAuth registrations. A request's numeric prefix
    # cannot create a trusted project binding. The token is additionally
    # refreshed and its subject verified before any provider action.
    configured = {
        os.getenv(name, "").strip()
        for name in (
            "GOOGLE_OAUTH_CLIENT_ID",
            "GMAIL_OAUTH_CLIENT_ID",
            "GOOGLE_DRIVE_OAUTH_CLIENT_ID",
            "GOOGLE_IOS_CONNECTOR_CLIENT_ID",
            "GOOGLE_ANDROID_CONNECTOR_CLIENT_ID",
        )
    }
    match = _CLIENT_ID.fullmatch(client_id)
    if not match or client_id not in configured:
        raise CleanupCredentialUnavailable("Google cleanup registration is unverified")
    return match.group(1)


def read_grants(conn, owner: str, inventory: dict) -> dict[str, CleanupGrant]:
    """Read exact retained revisions under the caller's lifecycle/claim locks."""
    live = conn.execute(
        text("SELECT public.account_provider_cleanup_live_inventory(:owner)"), {"owner": owner}
    ).scalar_one()
    if set(live) != set(inventory) or any(
        live[ref]["revision"] != item["revision"] for ref, item in inventory.items()
    ):
        raise CleanupCredentialUnavailable("Provider cleanup inventory changed")
    if not inventory:
        return {}
    grants: dict[str, CleanupGrant] = {}
    for source, identity in _SOURCES:
        if (
            conn.execute(
                text("SELECT to_regclass(:name) IS NOT NULL"), {"name": "public." + source}
            ).scalar_one()
            is not True
        ):
            continue
        pending = (
            " AND source_row.pending_credential_ciphertext IS NOT NULL"
            if source == "external_connector_oauth_attempts"
            else ""
        )
        # Table/column names are from the static custody inventory above.
        query = text(f"""SELECT to_jsonb(source_row) AS row,
            encode(sha256(convert_to(jsonb_build_array(CAST(:source AS text),CAST(:owner AS text),
                source_row.{identity}::text)::text,'UTF8')),'hex') AS reference,
            encode(sha256(convert_to(to_jsonb(source_row)::text,'UTF8')),'hex') AS revision
            FROM public.{source} source_row WHERE user_id=:owner{pending}
            AND encode(sha256(convert_to(jsonb_build_array(CAST(:source AS text),CAST(:owner AS text),
                source_row.{identity}::text)::text,'UTF8')),'hex')=ANY(CAST(:references AS text[]))
            LIMIT 129 FOR SHARE""")
        for record in conn.execute(
            query, {"source": source, "owner": owner, "references": list(inventory)}
        ).mappings():
            reference = record["reference"]
            if (
                len(grants) >= 128
                or reference not in inventory
                or record["revision"] != inventory[reference]["revision"]
            ):
                raise CleanupCredentialUnavailable("Provider cleanup inventory changed")
            row = record["row"]
            if not isinstance(row, dict) or row.get("user_id") != owner:
                raise CleanupCredentialUnavailable("Provider cleanup owner changed")
            grant = CleanupGrant(reference, owner, source, row)
            try:
                _open_grant(conn, grant)
            except (KeyError, TypeError, ValueError, RuntimeError):
                # Neither errors, ciphertext nor provider labels enter the
                # journal. An unknown binding never means unsupported revoke.
                grant = CleanupGrant(reference, owner, source, row)
            grants[reference] = grant
    if set(grants) != set(inventory):
        raise CleanupCredentialUnavailable("Provider cleanup inventory is incomplete")
    return grants


def describe_inventory(conn, owner: str, inventory: dict) -> dict[str, dict[str, str]]:
    return {ref: grant.descriptor() for ref, grant in read_grants(conn, owner, inventory).items()}


def _google(
    grant: CleanupGrant, *, client_id: str, client_secret: str, refresh: str, subject: Any
) -> None:
    if not isinstance(subject, str) or not re.fullmatch(r"[0-9]{1,64}", subject) or not refresh:
        raise CleanupCredentialUnavailable("Google cleanup account is unverified")
    native = {
        os.getenv(name, "").strip()
        for name in ("GOOGLE_IOS_CONNECTOR_CLIENT_ID", "GOOGLE_ANDROID_CONNECTOR_CLIENT_ID")
    }
    if not client_secret and client_id not in native:
        raise CleanupCredentialUnavailable("Google cleanup client is unavailable")
    grant.project_number = _configured_google_project(client_id)
    grant.kind = "google"
    grant.client_id, grant.client_secret = client_id, client_secret
    grant.refresh_token, grant.subject = refresh, subject


def _open_grant(conn, grant: CleanupGrant) -> None:
    row, owner = grant.row, grant.owner_id
    if grant.source in {"google_provider_connections", "google_calendar_additional_accounts"}:
        from hushh_mcp.services.google_connection_service import get_google_connection_service

        service = get_google_connection_service()
        aad = (
            service._calendar_account_aad(owner, row["account_id"])
            if grant.source == "google_calendar_additional_accounts"
            else f"google-connection:{owner}"
        )
        refresh = service._decrypt(
            {"ciphertext": row["refresh_token_ciphertext"], "iv": row["refresh_token_iv"]}, aad=aad
        )
        _google(
            grant,
            client_id=service._client_id(),
            client_secret=service._client_secret(),
            refresh=refresh,
            subject=row.get("provider_subject"),
        )
        return
    if grant.source == "kai_gmail_connections":
        from hushh_mcp.services.gmail_receipts_service import get_gmail_receipts_service

        service = get_gmail_receipts_service()
        refresh = service._decrypt_token(
            row.get("refresh_token_ciphertext"),
            row.get("refresh_token_iv"),
            row.get("refresh_token_tag"),
        )
        _google(
            grant,
            client_id=service._oauth_client_id(),
            client_secret=service._oauth_client_secret(),
            refresh=refresh or "",
            subject=row.get("google_sub"),
        )
        return

    from hushh_mcp.services.external_connector_credentials_service import (
        get_external_connector_credentials_service,
    )

    service = get_external_connector_credentials_service()
    connector = str(row.get("connector_id") or "")
    grant.connector_id = connector
    if grant.source == "external_connector_oauth_attempts":
        from hushh_mcp.services.external_connector_google_oauth import _attempt_aad

        if connector != "google_drive" or row.get("flow") != "native":
            raise CleanupCredentialUnavailable("Pending cleanup grant is unsupported")
        credential = json.loads(
            service.decrypt_secret(
                ciphertext=row["pending_credential_ciphertext"],
                iv=row["pending_credential_iv"],
                aad=_attempt_aad(row, "pending"),
            )
        )
        if credential.get("oauthClientId") != row.get("oauth_client_id"):
            raise CleanupCredentialUnavailable("Pending cleanup client changed")
    else:
        credential = service.open_credential(user_id=owner, connector_id=connector, row=row)
    grant.credential = credential
    if connector == "google_drive":
        client_id = os.getenv("GOOGLE_DRIVE_OAUTH_CLIENT_ID", "").strip()
        if (
            grant.source != "external_connector_oauth_attempts"
            and row.get("envelope_version") != 2
            or credential.get("oauthClientId") != client_id
        ):
            raise CleanupCredentialUnavailable("Drive cleanup client is unverified")
        _google(
            grant,
            client_id=client_id,
            client_secret=os.getenv("GOOGLE_DRIVE_OAUTH_CLIENT_SECRET", "").strip(),
            refresh=credential.get("refreshToken") or "",
            subject=credential.get("subject"),
        )
        return
    manifest = get_manifest(connector)
    if manifest is not None:
        client_id = os.getenv(manifest.client_id_env, "").strip()
        if (
            row.get("envelope_version") != 2
            or not client_id
            or credential.get("oauthClientId") != client_id
        ):
            raise CleanupCredentialUnavailable("Connector cleanup client is unverified")
        grant.client_id = client_id
        grant.client_secret = os.getenv(manifest.client_secret_env or "", "").strip()
        if not manifest.is_public_client and not grant.client_secret:
            raise CleanupCredentialUnavailable("Connector cleanup authorization is unavailable")
        grant.kind = "curated" if manifest.revocation_url else "unsupported"
        return
    registration = (
        conn.execute(
            text("""SELECT auth_style,to_jsonb(registration)->>'user_id' AS owner_user_id
        FROM external_mcp_connectors registration WHERE connector_id=:connector"""),
            {"connector": connector},
        )
        .mappings()
        .first()
    )
    if (
        registration is not None
        and registration["auth_style"] == "api_key"
        and registration["owner_user_id"] in {None, owner}
    ):
        grant.kind = "unsupported"
        return
    raise CleanupCredentialUnavailable("Connector cleanup provenance is unverified")
