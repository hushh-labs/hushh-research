#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Validate and reconcile Hussh Identity, OAuth, and outbound mail posture.

Supports two primary workflows:
1. `--verify-deploy --project <gcp-project> --environment <dev|uat|production>`:
   Read-only preflight safe for GitHub Actions deploy service accounts. Validates
   outbound `one@hushh.ai` mailbox secrets, live `hushh-mail-api` delegated transport,
   Google OAuth client secrets + redirect URIs, and Microsoft Entra Sign-In credentials.
2. `--reconcile-all [--apply] [--reset-guest <email>]`:
   Full cross-environment audit and remediation across Dev, UAT, Production, Firebase
   `microsoft.com` IdP parity, and the `HushOne Inc.` Microsoft Entra organization
   (redirect URIs, tenant-wide `AllPrincipals` admin consent grants, `hussh.ai` custom
   domain staging/verification, and B2B guest redemption resets).

Never prints or returns OAuth client secrets, API keys, or bearer tokens.
"""

from __future__ import annotations

import argparse
import base64
import importlib.util
import json
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable

EXPECTED_MAILBOX = "one@hushh.ai"
EXPECTED_MAIL_MODE = "live"
MAIL_API_HEALTH_URL = "https://hushh-mail-api-646258530541.us-central1.run.app/"
EXPECTED_MAIL_TRANSPORT = "google-workspace-gmail-delegated"

HUSHONE_TENANT_ID = "e1e09f9b-313b-4c57-a925-f2a573a919e9"
EXPECTED_MS_SIGNIN_CLIENT_ID = "da24bfba-1f80-47af-8444-7cee96efef18"
EXPECTED_MS_SIGNIN_APP_OBJECT_ID = "5c31113a-71f7-41f4-991b-f87ee8c195b7"
EXPECTED_MS_SIGNIN_SP_ID = "c3f3f9c2-6024-4cca-be57-85478fffd7f6"

EXPECTED_MS_CLOUD_CLIENT_ID = "4a6188ee-2a5b-4ed8-b650-35e4d560f72d"
EXPECTED_MS_CLOUD_APP_OBJECT_ID = "a8de9a27-b03b-413d-bf59-c9530dfe4dc2"
EXPECTED_MS_CLOUD_SP_ID = "339dd6e9-8e4f-4752-9b02-d938222bfd84"

MS_GRAPH_SP_ID = "16f38a30-c524-43da-9c1c-e72b950e8fc5"
AZURE_ARM_SP_ID = "b6faff4e-92d2-4f10-bc20-3bc22be5204b"
AZURE_CLI_APP_ID = "04b07795-8ddb-461a-bbee-02f9e1bf7b46"
STANDARD_GUEST_ROLE_ID = "a0b1b346-4d3e-4e8b-98f8-753987be4970"
RESTRICTED_GUEST_ROLE_ID = "10dae51f-b6af-4016-8d66-8c2a99b929b3"
TARGET_PUBLISHER_DOMAIN = "hussh.ai"
RETIRED_GUEST_EMAILS = frozenset({"ankit@hushh.ai"})
LEGACY_DISALLOWED_TOKEN = "ankit"

ENV_PROJECTS: dict[str, str] = {
    "dev": "hushh-pda-dev",
    "uat": "hushh-pda-uat",
    "production": "hushh-pda",
}

REQUIRED_SIGNIN_REDIRECT_URIS: tuple[str, ...] = (
    "https://dev.one.hushh.ai/__/auth/handler",
    "https://uat.one.hushh.ai/__/auth/handler",
    "https://one.hushh.ai/__/auth/handler",
    "https://dev.one.hussh.ai/__/auth/handler",
    "https://uat.one.hussh.ai/__/auth/handler",
    "https://one.hussh.ai/__/auth/handler",
    "https://dev.one.hussh.si/__/auth/handler",
    "https://uat.one.hussh.si/__/auth/handler",
    "https://one.hussh.si/__/auth/handler",
    "https://hushh-pda-dev.firebaseapp.com/__/auth/handler",
    "https://hushh-pda-uat.firebaseapp.com/__/auth/handler",
    "https://hushh-pda.firebaseapp.com/__/auth/handler",
    "https://dev.id.hussh.ai/__/auth/handler",
    "https://uat.id.hussh.ai/__/auth/handler",
    "https://id.hussh.ai/__/auth/handler",
)

REQUIRED_CLOUD_CONNECT_REDIRECT_URIS: tuple[str, ...] = (
    "http://localhost:3000/one/setup/cloud/azure/return",
    "http://localhost:3002/one/setup/cloud/azure/return",
    "https://one.hushh.ai/one/setup/cloud/azure/return",
    "https://uat.one.hushh.ai/one/setup/cloud/azure/return",
    "https://dev.one.hushh.ai/one/setup/cloud/azure/return",
    "https://one.hussh.ai/one/setup/cloud/azure/return",
    "https://uat.one.hussh.ai/one/setup/cloud/azure/return",
    "https://dev.one.hussh.ai/one/setup/cloud/azure/return",
    "https://one.hussh.si/one/setup/cloud/azure/return",
    "https://uat.one.hussh.si/one/setup/cloud/azure/return",
    "https://dev.one.hussh.si/one/setup/cloud/azure/return",
)

REQUIRED_PERMISSION_GRANTS: tuple[tuple[str, str, str, tuple[str, ...]], ...] = (
    (
        "Hussh One Sign-In",
        EXPECTED_MS_SIGNIN_SP_ID,
        MS_GRAPH_SP_ID,
        ("openid", "email", "profile", "User.Read"),
    ),
    (
        "Hussh Cloud Connect",
        EXPECTED_MS_CLOUD_SP_ID,
        MS_GRAPH_SP_ID,
        ("openid", "email", "profile", "User.Read"),
    ),
    (
        "Hussh Cloud Connect",
        EXPECTED_MS_CLOUD_SP_ID,
        AZURE_ARM_SP_ID,
        ("user_impersonation",),
    ),
)

DEFAULT_HTTP_TIMEOUT_SECONDS = 15


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001, ANN202
        return None


def _redact_secrets(text: str, secrets_to_mask: list[str]) -> str:
    redacted = str(text or "")
    for secret in secrets_to_mask:
        if secret and len(secret) >= 4:
            redacted = redacted.replace(secret, "[REDACTED]")
    return redacted


def _read_secret(project: str, secret: str) -> str:
    return subprocess.check_output(
        [
            "gcloud",
            "secrets",
            "versions",
            "access",
            "latest",
            f"--secret={secret}",
            f"--project={project}",
        ],
        text=True,
        stderr=subprocess.PIPE,
    ).strip()


def _read_optional_secret(project: str, secret: str) -> str | None:
    describe = subprocess.run(
        ["gcloud", "secrets", "describe", secret, f"--project={project}", "--format=value(name)"],
        capture_output=True,
        text=True,
        check=False,
    )
    if describe.returncode != 0 or not describe.stdout.strip():
        return None
    val = _read_secret(project, secret)
    return val or None


def _http_request(
    url: str,
    *,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    body: bytes | None = None,
    follow_redirects: bool = True,
) -> tuple[int, dict[str, str], str]:
    req = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    opener = (
        urllib.request.build_opener()
        if follow_redirects
        else urllib.request.build_opener(_NoRedirectHandler())
    )
    try:
        with opener.open(req, timeout=DEFAULT_HTTP_TIMEOUT_SECONDS) as resp:
            resp_headers = {k.lower(): v for k, v in resp.headers.items()}
            return int(resp.status), resp_headers, resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        resp_headers = {k.lower(): v for k, v in exc.headers.items()}
        payload = exc.read().decode("utf-8", errors="replace") if exc.fp else ""
        return int(exc.code), resp_headers, payload


def _active_az_tenant() -> str:
    return subprocess.check_output(
        ["az", "account", "show", "--query", "tenantId", "-o", "tsv"],
        text=True,
        stderr=subprocess.PIPE,
    ).strip()


def _az_graph_request(
    method: str,
    path_or_url: str,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    uri = (
        path_or_url
        if path_or_url.startswith("https://")
        else f"https://graph.microsoft.com/v1.0/{path_or_url.lstrip('/')}"
    )
    cmd = ["az", "rest", "--method", method.upper(), "--uri", uri]
    if payload is not None:
        cmd.extend(["--headers", "Content-Type=application/json", "--body", json.dumps(payload)])
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        detail = proc.stderr.strip() or proc.stdout.strip() or f"exit {proc.returncode}"
        raise RuntimeError(f"Microsoft Graph {method.upper()} {uri} failed: {detail}")
    out = proc.stdout.strip()
    return dict(json.loads(out)) if out else {}


def _decode_google_auth_error(location: str) -> str | None:
    parsed = urllib.parse.urlparse(location)
    params = urllib.parse.parse_qs(parsed.query)
    raw_err = (params.get("authError") or [""])[0]
    if not raw_err:
        return None
    try:
        padded = raw_err + "=" * (-len(raw_err) % 4)
        decoded = base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8", errors="ignore")
        for known in (
            "redirect_uri_mismatch",
            "deleted_client",
            "invalid_client",
            "unauthorized_client",
            "access_denied",
        ):
            if known in decoded:
                return known
    except Exception:
        return "oauth_error"
    return "oauth_error"


def _probe_oauth_token_secret(
    token_url: str,
    *,
    client_id: str,
    client_secret: str,
    redirect_uri: str,
    http_request: Callable[..., tuple[int, dict[str, str], str]],
) -> tuple[bool, dict[str, Any]]:
    form = urllib.parse.urlencode(
        {
            "client_id": client_id,
            "client_secret": client_secret,
            "code": "posture-check-dummy-code",
            "grant_type": "authorization_code",
            "redirect_uri": redirect_uri,
        }
    ).encode("utf-8")
    status, _headers, raw_body = http_request(
        token_url,
        method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        body=form,
        follow_redirects=True,
    )
    error_code = ""
    try:
        parsed = json.loads(raw_body) if raw_body else {}
        if isinstance(parsed, dict):
            error_code = str(parsed.get("error") or "")
    except json.JSONDecodeError:
        error_code = "non_json_response"

    # Expected healthy response for valid client_id + client_secret with dummy code:
    # Google & Microsoft both return HTTP 400 + {"error": "invalid_grant"}.
    ok = status == 400 and error_code == "invalid_grant"
    return ok, {
        "clientId": client_id,
        "httpStatus": status,
        "error": error_code or "none",
        "ok": ok,
    }


def _probe_google_auth_redirect(
    *,
    label: str,
    client_id: str,
    redirect_uri: str,
    http_request: Callable[..., tuple[int, dict[str, str], str]],
) -> tuple[bool, dict[str, Any]]:
    query = urllib.parse.urlencode(
        {
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": "openid email",
        }
    )
    status, headers, _body = http_request(
        f"https://accounts.google.com/o/oauth2/v2/auth?{query}",
        method="GET",
        follow_redirects=False,
    )
    location = str(headers.get("location") or "")
    auth_error = _decode_google_auth_error(location) if "/signin/oauth/error" in location else None
    is_signin_redirect = status == 302 and "/signin/oauth/error" not in location and any(
        marker in location
        for marker in ("/v3/signin/", "ServiceLogin", "AccountChooser", "signin/oauth/id")
    )
    ok = is_signin_redirect and auth_error is None
    result: dict[str, Any] = {
        "label": label,
        "clientId": client_id,
        "redirectUri": redirect_uri,
        "httpStatus": status,
        "ok": ok,
    }
    if auth_error:
        result["authError"] = auth_error
    return ok, result


def verify_project_deploy_posture(
    project: str,
    environment: str | None = None,
    *,
    secret_reader: Callable[[str, str], str] = _read_secret,
    optional_secret_reader: Callable[[str, str], str | None] = _read_optional_secret,
    http_request: Callable[..., tuple[int, dict[str, str], str]] = _http_request,
) -> dict[str, Any]:
    """Validate Secret Manager, `hushh-mail-api`, Google OAuth, and Microsoft OAuth posture."""
    errors: list[str] = []
    secrets_to_mask: list[str] = []

    if environment and environment in ENV_PROJECTS and ENV_PROJECTS[environment] != project:
        errors.append(
            f"environment '{environment}' expects project '{ENV_PROJECTS[environment]}', got '{project}'"
        )

    # 1. Outbound mail secrets & retired test-recipient guard
    mail_secrets: dict[str, str] = {}
    for key in (
        "SUPPORT_EMAIL_DELEGATED_USER",
        "SUPPORT_EMAIL_FROM",
        "SUPPORT_EMAIL_TO",
        "SUPPORT_EMAIL_MODE",
    ):
        mail_secrets[key] = secret_reader(project, key)

    for key in ("SUPPORT_EMAIL_DELEGATED_USER", "SUPPORT_EMAIL_FROM", "SUPPORT_EMAIL_TO"):
        if mail_secrets[key] != EXPECTED_MAILBOX:
            errors.append(f"{project}: {key} must equal {EXPECTED_MAILBOX}, got {mail_secrets[key]}")
    if mail_secrets["SUPPORT_EMAIL_MODE"] != EXPECTED_MAIL_MODE:
        errors.append(
            f"{project}: SUPPORT_EMAIL_MODE must equal {EXPECTED_MAIL_MODE}, "
            f"got {mail_secrets['SUPPORT_EMAIL_MODE']}"
        )

    support_test_to = optional_secret_reader(project, "SUPPORT_EMAIL_TEST_TO")
    if support_test_to is not None and LEGACY_DISALLOWED_TOKEN in support_test_to.lower():
        errors.append(f"{project}: SUPPORT_EMAIL_TEST_TO must not reference legacy mailbox")

    # 2. Live keyless Google Workspace DWD transport check
    mail_status, _headers, mail_raw = http_request(
        MAIL_API_HEALTH_URL,
        method="GET",
        follow_redirects=True,
    )
    mail_health: dict[str, Any] = {}
    try:
        parsed_health = json.loads(mail_raw) if mail_raw else {}
        if isinstance(parsed_health, dict):
            mail_health = parsed_health
    except json.JSONDecodeError:
        mail_health = {}
    mail_transport = str(mail_health.get("transport") or "")
    mail_healthy = (
        mail_status == 200
        and mail_health.get("status") == "healthy"
        and mail_transport == EXPECTED_MAIL_TRANSPORT
    )
    if not mail_healthy:
        errors.append(
            f"{project}: hushh-mail-api health check failed (status={mail_status}, "
            f"transport={mail_transport or 'unknown'})"
        )

    # 3. Google OAuth credentials + redirect URIs
    app_origin = secret_reader(project, "APP_FRONTEND_ORIGIN").rstrip("/")
    oauth_pairs: list[tuple[str, str, str, str | None]] = [
        (
            "gmail",
            secret_reader(project, "GMAIL_OAUTH_CLIENT_ID"),
            secret_reader(project, "GMAIL_OAUTH_CLIENT_SECRET"),
            secret_reader(project, "GMAIL_OAUTH_REDIRECT_URI"),
        ),
        (
            "google",
            secret_reader(project, "GOOGLE_OAUTH_CLIENT_ID"),
            secret_reader(project, "GOOGLE_OAUTH_CLIENT_SECRET"),
            secret_reader(project, "GOOGLE_OAUTH_REDIRECT_URI"),
        ),
    ]
    drive_cid = optional_secret_reader(project, "GOOGLE_DRIVE_OAUTH_CLIENT_ID")
    drive_secret = optional_secret_reader(project, "GOOGLE_DRIVE_OAUTH_CLIENT_SECRET")
    if (drive_cid and not drive_secret) or (drive_secret and not drive_cid):
        errors.append(f"{project}: partial GOOGLE_DRIVE_OAUTH_CLIENT_ID/SECRET configuration")
    elif drive_cid and drive_secret:
        oauth_pairs.append(("drive", drive_cid, drive_secret, None))

    for _, _, secret_val, _ in oauth_pairs:
        secrets_to_mask.append(secret_val)

    google_token_checks: dict[str, Any] = {}
    google_redirect_checks: list[dict[str, Any]] = []
    seen_redirects: set[tuple[str, str]] = set()
    connector_return = f"{app_origin}/one/profile/connectors/oauth/return"

    for name, cid, csec, configured_redirect in oauth_pairs:
        probe_redirect = configured_redirect or connector_return
        ok, token_res = _probe_oauth_token_secret(
            "https://oauth2.googleapis.com/token",
            client_id=cid,
            client_secret=csec,
            redirect_uri=probe_redirect,
            http_request=http_request,
        )
        google_token_checks[name] = token_res
        if not ok:
            errors.append(
                f"{project}: Google OAuth token probe failed for {name} "
                f"(status={token_res['httpStatus']}, error={token_res['error']})"
            )

        redirect_targets: list[tuple[str, str]] = []
        if configured_redirect:
            redirect_targets.append((name, configured_redirect))
        redirect_targets.append((f"{name}_connector", connector_return))
        for label, ruri in redirect_targets:
            if (cid, ruri) in seen_redirects:
                continue
            seen_redirects.add((cid, ruri))
            ok_r, r_res = _probe_google_auth_redirect(
                label=label,
                client_id=cid,
                redirect_uri=ruri,
                http_request=http_request,
            )
            google_redirect_checks.append(r_res)
            if not ok_r:
                errors.append(
                    f"{project}: Google OAuth redirect probe failed for {label} ({ruri}: "
                    f"{r_res.get('authError') or r_res['httpStatus']})"
                )

    # 4. Microsoft Sign-In client & secret parity + live Entra token probe
    ms_client_id = secret_reader(project, "MICROSOFT_FIREBASE_CLIENT_ID")
    ms_client_secret = secret_reader(project, "MICROSOFT_FIREBASE_CLIENT_SECRET")
    secrets_to_mask.append(ms_client_secret)

    if ms_client_id.lower() != EXPECTED_MS_SIGNIN_CLIENT_ID:
        errors.append(
            f"{project}: MICROSOFT_FIREBASE_CLIENT_ID must equal {EXPECTED_MS_SIGNIN_CLIENT_ID}, "
            f"got {ms_client_id}"
        )
    if not ms_client_secret:
        errors.append(f"{project}: MICROSOFT_FIREBASE_CLIENT_SECRET cannot be empty")
        ms_token_res = {"clientId": ms_client_id, "httpStatus": 0, "error": "empty_secret", "ok": False}
    else:
        ms_ok, ms_token_res = _probe_oauth_token_secret(
            "https://login.microsoftonline.com/common/oauth2/v2.0/token",
            client_id=ms_client_id,
            client_secret=ms_client_secret,
            redirect_uri=f"https://{project}.firebaseapp.com/__/auth/handler",
            http_request=http_request,
        )
        if not ms_ok:
            errors.append(
                f"{project}: Microsoft OAuth token probe failed "
                f"(status={ms_token_res['httpStatus']}, error={ms_token_res['error']})"
            )

    clean_errors = [_redact_secrets(err, secrets_to_mask) for err in errors]
    return {
        "project": project,
        "environment": environment or project,
        "ok": len(clean_errors) == 0,
        "outboundMail": {
            "delegatedUser": mail_secrets["SUPPORT_EMAIL_DELEGATED_USER"],
            "from": mail_secrets["SUPPORT_EMAIL_FROM"],
            "to": mail_secrets["SUPPORT_EMAIL_TO"],
            "mode": mail_secrets["SUPPORT_EMAIL_MODE"],
            "testToConfigured": support_test_to is not None,
            "mailApiHealthy": mail_healthy,
            "mailApiTransport": mail_transport,
        },
        "googleOAuth": {
            "appOrigin": app_origin,
            "tokenChecks": google_token_checks,
            "redirectChecks": google_redirect_checks,
        },
        "microsoftOAuth": {
            "clientId": ms_client_id.lower(),
            "tokenCheck": ms_token_res,
        },
        "errors": clean_errors,
    }


def _sync_firebase_microsoft_idp(
    project: str,
    *,
    apply: bool,
    secret_reader: Callable[[str, str], str],
    firebase_reconciler: Callable[..., dict[str, Any]] | None = None,
) -> dict[str, Any]:
    if firebase_reconciler is None:
        sync_path = Path(__file__).resolve().with_name("sync_microsoft_identity_idp.py")
        spec = importlib.util.spec_from_file_location("sync_microsoft_identity_idp", sync_path)
        assert spec and spec.loader
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        firebase_reconciler = mod.reconcile_firebase_microsoft_idp
    return firebase_reconciler(project, apply=apply, secret_reader=secret_reader)


def _match_guest_email(user: dict[str, Any]) -> str:
    mail = str(user.get("mail") or "").strip().lower()
    if mail:
        return mail
    other_mails = user.get("otherMails") or []
    for candidate in other_mails:
        cleaned = str(candidate or "").strip().lower()
        if cleaned:
            return cleaned
    return str(user.get("userPrincipalName") or "").strip().lower()


def reconcile_entra_org(
    *,
    apply: bool = False,
    reset_guests: list[str] | None = None,
    resend_pending_guests: bool = False,
    az_tenant_provider: Callable[[], str] = _active_az_tenant,
    graph_request: Callable[[str, str, dict[str, Any] | None], dict[str, Any]] = _az_graph_request,
) -> dict[str, Any]:
    """Audit and remediate HushOne Inc. Entra apps, admin consent grants, Azure CLI, domain, and guests."""
    errors: list[str] = []
    actions: list[str] = []

    active_tenant = az_tenant_provider()
    if active_tenant != HUSHONE_TENANT_ID:
        raise RuntimeError(
            f"Active Azure CLI tenant must be HushOne Inc. ({HUSHONE_TENANT_ID}), got '{active_tenant}'"
        )

    # 0. Authorization policy: keep collaborative Guest tier so engineers can resolve objects in az CLI
    auth_policy = graph_request("GET", "policies/authorizationPolicy", None)
    guest_role_id = str(auth_policy.get("guestUserRoleId") or "").strip().lower()
    if guest_role_id != STANDARD_GUEST_ROLE_ID:
        if apply:
            graph_request(
                "PATCH",
                "policies/authorizationPolicy",
                {"guestUserRoleId": STANDARD_GUEST_ROLE_ID},
            )
            actions.append(
                f"updated authorizationPolicy.guestUserRoleId to collaborative tier ({STANDARD_GUEST_ROLE_ID})"
            )
            guest_role_id = STANDARD_GUEST_ROLE_ID
        else:
            errors.append(
                f"authorizationPolicy.guestUserRoleId is '{guest_role_id}', expected standard "
                f"collaborative guest tier '{STANDARD_GUEST_ROLE_ID}' for Azure CLI directory lookup"
            )

    # 1. Applications: signInAudience & Web redirect URIs
    app_specs = (
        ("Hussh One Sign-In", EXPECTED_MS_SIGNIN_APP_OBJECT_ID, REQUIRED_SIGNIN_REDIRECT_URIS),
        ("Hussh Cloud Connect", EXPECTED_MS_CLOUD_APP_OBJECT_ID, REQUIRED_CLOUD_CONNECT_REDIRECT_URIS),
    )
    app_results: dict[str, Any] = {}
    apps_payload_cache: dict[str, dict[str, Any]] = {}
    for label, obj_id, required_uris in app_specs:
        app = graph_request(
            "GET",
            f"applications/{obj_id}?$select=id,appId,displayName,signInAudience,publisherDomain,web",
            None,
        )
        apps_payload_cache[obj_id] = app
        existing_uris = list((app.get("web") or {}).get("redirectUris") or [])
        missing_uris = [uri for uri in required_uris if uri not in existing_uris]
        audience_ok = app.get("signInAudience") == "AzureADandPersonalMicrosoftAccount"

        if apply and (missing_uris or not audience_ok):
            patch_body: dict[str, Any] = {}
            if not audience_ok:
                patch_body["signInAudience"] = "AzureADandPersonalMicrosoftAccount"
            if missing_uris:
                patch_body["web"] = {"redirectUris": [*existing_uris, *missing_uris]}
            graph_request("PATCH", f"applications/{obj_id}", patch_body)
            actions.append(
                f"patched application '{label}' (added_uris={len(missing_uris)}, "
                f"updated_audience={not audience_ok})"
            )
            app = graph_request(
                "GET",
                f"applications/{obj_id}?$select=id,appId,displayName,signInAudience,publisherDomain,web",
                None,
            )
            apps_payload_cache[obj_id] = app
            existing_uris = list((app.get("web") or {}).get("redirectUris") or [])
            missing_uris = [uri for uri in required_uris if uri not in existing_uris]
            audience_ok = app.get("signInAudience") == "AzureADandPersonalMicrosoftAccount"

        if not audience_ok:
            errors.append(f"{label}: signInAudience is {app.get('signInAudience')!r}")
        if missing_uris:
            errors.append(f"{label}: missing Web redirect URIs: {', '.join(missing_uris)}")

        app_results[label] = {
            "objectId": obj_id,
            "appId": app.get("appId"),
            "signInAudience": app.get("signInAudience"),
            "publisherDomain": app.get("publisherDomain"),
            "redirectUriCount": len(existing_uris),
            "missingRedirectUris": missing_uris,
        }

    # 2. Service Principals: appRoleAssignmentRequired must be False (including Microsoft Azure CLI)
    sp_results: list[dict[str, Any]] = []
    for label, sp_id in (
        ("Hussh One Sign-In", EXPECTED_MS_SIGNIN_SP_ID),
        ("Hussh Cloud Connect", EXPECTED_MS_CLOUD_SP_ID),
    ):
        sp = graph_request(
            "GET",
            f"servicePrincipals/{sp_id}?$select=id,appId,displayName,appRoleAssignmentRequired",
            None,
        )
        req_assign = bool(sp.get("appRoleAssignmentRequired"))
        if apply and req_assign:
            graph_request("PATCH", f"servicePrincipals/{sp_id}", {"appRoleAssignmentRequired": False})
            actions.append(f"set appRoleAssignmentRequired=false on SP '{label}'")
            req_assign = False
        if req_assign:
            errors.append(f"{label}: servicePrincipal appRoleAssignmentRequired is true")
        sp_results.append({"displayName": label, "id": sp_id, "appRoleAssignmentRequired": req_assign})

    az_cli_sp_resp = graph_request(
        "GET",
        f"servicePrincipals?$filter=appId eq '{AZURE_CLI_APP_ID}'&$select=id,appId,displayName,appRoleAssignmentRequired",
        None,
    )
    az_cli_sps = list(az_cli_sp_resp.get("value") or [])
    az_cli_sp = az_cli_sps[0] if az_cli_sps else None
    if az_cli_sp is None and apply:
        az_cli_sp = graph_request("POST", "servicePrincipals", {"appId": AZURE_CLI_APP_ID})
        actions.append(
            f"instantiated enterprise servicePrincipal 'Microsoft Azure CLI' ({az_cli_sp.get('id')})"
        )
    az_cli_sp_id = str((az_cli_sp or {}).get("id") or "")
    if not az_cli_sp_id:
        errors.append(
            "Microsoft Azure CLI: enterprise service principal (04b07795-8ddb-461a-bbee-02f9e1bf7b46) "
            "is not instantiated in HushOne Inc."
        )
    else:
        az_req_assign = bool(az_cli_sp.get("appRoleAssignmentRequired"))
        if apply and az_req_assign:
            graph_request("PATCH", f"servicePrincipals/{az_cli_sp_id}", {"appRoleAssignmentRequired": False})
            actions.append("set appRoleAssignmentRequired=false on SP 'Microsoft Azure CLI'")
            az_req_assign = False
        if az_req_assign:
            errors.append("Microsoft Azure CLI: servicePrincipal appRoleAssignmentRequired is true")
        sp_results.append(
            {
                "displayName": "Microsoft Azure CLI",
                "id": az_cli_sp_id,
                "appRoleAssignmentRequired": az_req_assign,
            }
        )

    # 3. Tenant-wide AllPrincipals oauth2PermissionGrants
    existing_grants = list((graph_request("GET", "oauth2PermissionGrants", None)).get("value") or [])
    by_pair: dict[tuple[str, str], dict[str, Any]] = {}
    for grant in existing_grants:
        if grant.get("consentType") == "AllPrincipals":
            by_pair[(str(grant.get("clientId") or ""), str(grant.get("resourceId") or ""))] = grant

    required_grants = list(REQUIRED_PERMISSION_GRANTS)
    if az_cli_sp_id:
        required_grants.extend(
            [
                (
                    "Microsoft Azure CLI",
                    az_cli_sp_id,
                    MS_GRAPH_SP_ID,
                    ("openid", "email", "profile", "offline_access", "User.Read", "Directory.AccessAsUser.All"),
                ),
                (
                    "Microsoft Azure CLI",
                    az_cli_sp_id,
                    AZURE_ARM_SP_ID,
                    ("user_impersonation",),
                ),
            ]
        )

    grant_results: list[dict[str, Any]] = []
    for app_label, client_sp_id, resource_sp_id, required_scopes in required_grants:
        existing = by_pair.get((client_sp_id, resource_sp_id))
        current_scopes = set(str((existing or {}).get("scope") or "").split())
        missing_scopes = [s for s in required_scopes if s not in current_scopes]

        if apply and missing_scopes:
            merged_scopes = " ".join(
                [*[s for s in str((existing or {}).get("scope") or "").split() if s], *missing_scopes]
            )
            if existing and existing.get("id"):
                graph_request(
                    "PATCH",
                    f"oauth2PermissionGrants/{existing['id']}",
                    {"scope": merged_scopes},
                )
                actions.append(f"updated AllPrincipals grant for '{app_label}' ({merged_scopes})")
            else:
                created = graph_request(
                    "POST",
                    "oauth2PermissionGrants",
                    {
                        "clientId": client_sp_id,
                        "consentType": "AllPrincipals",
                        "resourceId": resource_sp_id,
                        "scope": " ".join(required_scopes),
                    },
                )
                actions.append(
                    f"created AllPrincipals grant {created.get('id', '')} for '{app_label}' "
                    f"({' '.join(required_scopes)})"
                )
            missing_scopes = []
            current_scopes.update(required_scopes)

        if missing_scopes:
            errors.append(
                f"{app_label}: missing AllPrincipals consent scopes {missing_scopes} "
                f"for resource {resource_sp_id}"
            )
        grant_results.append(
            {
                "app": app_label,
                "clientId": client_sp_id,
                "resourceId": resource_sp_id,
                "requiredScopes": list(required_scopes),
                "missingScopes": missing_scopes,
            }
        )

    # 4. Custom publisher domain staging / DNS verification (`hussh.ai`)
    domains = list((graph_request("GET", "domains", None)).get("value") or [])
    hussh_domain = next((d for d in domains if d.get("id") == TARGET_PUBLISHER_DOMAIN), None)
    if hussh_domain is None and apply:
        hussh_domain = graph_request("POST", "domains", {"id": TARGET_PUBLISHER_DOMAIN})
        actions.append(f"registered custom domain '{TARGET_PUBLISHER_DOMAIN}' in HushOne Inc.")

    domain_verified = bool((hussh_domain or {}).get("isVerified"))
    dns_records: list[dict[str, Any]] = []
    verify_error: str | None = None

    if hussh_domain is not None and not domain_verified:
        if apply:
            try:
                verified_res = graph_request("POST", f"domains/{TARGET_PUBLISHER_DOMAIN}/verify", {})
                domain_verified = bool(verified_res.get("isVerified", True))
                actions.append(f"verified custom domain '{TARGET_PUBLISHER_DOMAIN}'")
            except RuntimeError as exc:
                verify_error = str(exc)
        if not domain_verified:
            try:
                rec_resp = graph_request(
                    "GET",
                    f"domains/{TARGET_PUBLISHER_DOMAIN}/verificationDnsRecords",
                    None,
                )
                for rec in rec_resp.get("value") or []:
                    dns_records.append(
                        {
                            "recordType": rec.get("recordType"),
                            "label": rec.get("label"),
                            "text": rec.get("text"),
                            "ttl": rec.get("ttl"),
                        }
                    )
            except RuntimeError as exc:
                verify_error = verify_error or str(exc)
    elif hussh_domain is None:
        errors.append(f"custom domain '{TARGET_PUBLISHER_DOMAIN}' is not registered in HushOne Inc.")

    if domain_verified and apply:
        for label, obj_id, _ in app_specs:
            if apps_payload_cache[obj_id].get("publisherDomain") != TARGET_PUBLISHER_DOMAIN:
                try:
                    graph_request(
                        "PATCH",
                        f"applications/{obj_id}",
                        {"publisherDomain": TARGET_PUBLISHER_DOMAIN},
                    )
                    actions.append(
                        f"updated publisherDomain='{TARGET_PUBLISHER_DOMAIN}' on '{label}'"
                    )
                except RuntimeError as exc:
                    errors.append(f"{label}: failed to update publisherDomain: {exc}")

    # 5. B2B Guest identity audit + explicit redemption resets
    guests = list(
        (
            graph_request(
                "GET",
                "users?$filter=userType eq 'Guest'&$select=id,displayName,mail,otherMails,"
                "userPrincipalName,externalUserState,identities",
                None,
            )
        ).get("value")
        or []
    )
    pending_acceptance: list[dict[str, str]] = []
    email_otp_bound: list[dict[str, str]] = []
    guests_by_email: dict[str, dict[str, Any]] = {}

    for guest in guests:
        email = _match_guest_email(guest)
        if email:
            guests_by_email[email] = guest
        if email in RETIRED_GUEST_EMAILS:
            continue
        state = str(guest.get("externalUserState") or "")
        issuers = {str(ident.get("issuer") or "") for ident in (guest.get("identities") or [])}
        entry = {
            "id": str(guest.get("id") or ""),
            "displayName": str(guest.get("displayName") or ""),
            "email": email,
            "externalUserState": state,
        }
        if state == "PendingAcceptance":
            pending_acceptance.append(entry)
        if "mail" in issuers:
            email_otp_bound.append(entry)

    reset_results: list[dict[str, Any]] = []
    for raw_email in reset_guests or []:
        target_email = raw_email.strip().lower()
        if target_email in RETIRED_GUEST_EMAILS:
            errors.append(f"refused guest reset for retired account '{target_email}'")
            continue
        guest = guests_by_email.get(target_email)
        if guest is None:
            errors.append(f"guest '{target_email}' not found in HushOne Inc.")
            continue
        if not apply:
            actions.append(f"would reset B2B redemption for guest '{target_email}'")
            reset_results.append({"email": target_email, "userId": guest["id"], "status": "dry_run"})
            continue
        inv = graph_request(
            "POST",
            "invitations",
            {
                "invitedUserEmailAddress": target_email,
                "invitedUser": {"id": guest["id"]},
                "inviteRedirectUrl": f"https://portal.azure.com/{HUSHONE_TENANT_ID}",
                "resetRedemption": True,
                "sendInvitationMessage": True,
            },
        )
        actions.append(f"reset B2B redemption for guest '{target_email}' ({guest['id']})")
        reset_results.append(
            {
                "email": target_email,
                "userId": guest["id"],
                "status": inv.get("status"),
                "inviteRedeemUrl": inv.get("inviteRedeemUrl"),
            }
        )

    pending_resends: list[dict[str, Any]] = []
    if resend_pending_guests:
        for entry in pending_acceptance:
            target_email = str(entry.get("email") or "").strip().lower()
            if not target_email or target_email in RETIRED_GUEST_EMAILS:
                continue
            if not apply:
                actions.append(f"would resend B2B invitation for pending guest '{target_email}'")
                pending_resends.append(
                    {"email": target_email, "userId": entry["id"], "status": "dry_run"}
                )
                continue
            inv = graph_request(
                "POST",
                "invitations",
                {
                    "invitedUserEmailAddress": target_email,
                    "inviteRedirectUrl": f"https://portal.azure.com/{HUSHONE_TENANT_ID}",
                    "sendInvitationMessage": True,
                },
            )
            actions.append(f"re-sent B2B invitation to pending guest '{target_email}' ({entry['id']})")
            pending_resends.append(
                {
                    "email": target_email,
                    "userId": entry["id"],
                    "status": inv.get("status"),
                    "inviteRedeemUrl": inv.get("inviteRedeemUrl"),
                }
            )

    return {
        "tenantId": active_tenant,
        "mode": "apply" if apply else "verify",
        "ok": len(errors) == 0,
        "actions": actions,
        "authorizationPolicy": {
            "guestUserRoleId": guest_role_id,
            "collaborativeGuestAccessEnabled": guest_role_id == STANDARD_GUEST_ROLE_ID,
        },
        "applications": app_results,
        "servicePrincipals": sp_results,
        "permissionGrants": grant_results,
        "customDomain": {
            "domain": TARGET_PUBLISHER_DOMAIN,
            "registered": hussh_domain is not None,
            "verified": domain_verified,
            "pendingDnsVerification": dns_records,
            "verifyNote": verify_error,
        },
        "guestAudit": {
            "totalNonRetiredGuests": sum(
                1 for g in guests if _match_guest_email(g) not in RETIRED_GUEST_EMAILS
            ),
            "pendingAcceptance": pending_acceptance,
            "emailOtpBoundUsers": email_otp_bound,
            "resets": reset_results,
            "pendingResends": pending_resends,
        },
        "errors": errors,
    }


def reconcile_all(
    *,
    apply: bool = False,
    reset_guests: list[str] | None = None,
    resend_pending_guests: bool = False,
    skip_entra: bool = False,
    secret_reader: Callable[[str, str], str] = _read_secret,
    optional_secret_reader: Callable[[str, str], str | None] = _read_optional_secret,
    http_request: Callable[..., tuple[int, dict[str, str], str]] = _http_request,
    firebase_reconciler: Callable[..., dict[str, Any]] | None = None,
    az_tenant_provider: Callable[[], str] = _active_az_tenant,
    graph_request: Callable[[str, str, dict[str, Any] | None], dict[str, Any]] = _az_graph_request,
) -> dict[str, Any]:
    """Run full cross-environment deploy posture checks, Firebase IdP sync, and Entra org checks."""
    environments: dict[str, Any] = {}
    firebase_idp: dict[str, Any] = {}
    all_ok = True

    for env_name, project in ENV_PROJECTS.items():
        env_report = verify_project_deploy_posture(
            project,
            env_name,
            secret_reader=secret_reader,
            optional_secret_reader=optional_secret_reader,
            http_request=http_request,
        )
        environments[env_name] = env_report
        if not env_report.get("ok"):
            all_ok = False

        fb_report = _sync_firebase_microsoft_idp(
            project,
            apply=apply,
            secret_reader=secret_reader,
            firebase_reconciler=firebase_reconciler,
        )
        firebase_idp[project] = fb_report
        if fb_report.get("inSync") is not True:
            all_ok = False

    entra_report: dict[str, Any] | None = None
    if not skip_entra:
        entra_report = reconcile_entra_org(
            apply=apply,
            reset_guests=reset_guests,
            resend_pending_guests=resend_pending_guests,
            az_tenant_provider=az_tenant_provider,
            graph_request=graph_request,
        )
        if not entra_report.get("ok"):
            all_ok = False

    return {
        "mode": "apply" if apply else "verify",
        "ok": all_ok,
        "environments": environments,
        "firebaseMicrosoftIdp": firebase_idp,
        "entraHushOneOrg": entra_report,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--verify-deploy", action="store_true")
    mode.add_argument("--reconcile-all", action="store_true")

    parser.add_argument("--project", help="GCP project id for --verify-deploy")
    parser.add_argument("--environment", choices=sorted(ENV_PROJECTS), help="Deploy environment")
    parser.add_argument("--apply", action="store_true", help="Apply missing Firebase/Entra changes")
    parser.add_argument(
        "--reset-guest",
        action="append",
        default=[],
        help="Reset B2B guest redemption in HushOne Inc. (e.g. parth@hushh.ai)",
    )
    parser.add_argument(
        "--resend-pending-guests",
        action="store_true",
        help="Re-send invitations for non-retired guests stuck in PendingAcceptance",
    )
    parser.add_argument(
        "--skip-entra",
        action="store_true",
        help="Skip HushOne Inc. Microsoft Graph checks during --reconcile-all",
    )
    args = parser.parse_args(argv)

    if args.verify_deploy:
        if not args.project:
            parser.error("--verify-deploy requires --project")
        report = verify_project_deploy_posture(args.project, args.environment)
        print(json.dumps(report, indent=2, sort_keys=True))
        return 0 if report.get("ok") else 1

    report = reconcile_all(
        apply=bool(args.apply),
        reset_guests=list(args.reset_guest or []),
        resend_pending_guests=bool(args.resend_pending_guests),
        skip_entra=bool(args.skip_entra),
    )
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
