# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Unit tests for the cross-environment OAuth & outbound mail validate/reconcile tool."""

from __future__ import annotations

import base64
import importlib.util
import json
from pathlib import Path
from typing import Any

_SCRIPT_PATH = (
    Path(__file__).resolve().parents[2] / "scripts" / "ops" / "reconcile_oauth_and_mail_posture.py"
)
_AZ_CLI_PATH = Path(__file__).resolve().parents[2] / "scripts" / "ops" / "hushh_az_cli.py"


def _load_mod(name: str = "reconcile_oauth_and_mail_posture", path: Path = _SCRIPT_PATH):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _healthy_secrets_for(project: str) -> dict[str, str | None]:
    origin_map = {
        "hushh-pda-dev": "https://dev.one.hussh.ai",
        "hushh-pda-uat": "https://uat.one.hussh.ai",
        "hushh-pda": "https://one.hussh.ai",
    }
    origin = origin_map[project]
    base: dict[str, str | None] = {
        "SUPPORT_EMAIL_DELEGATED_USER": "one@hushh.ai",
        "SUPPORT_EMAIL_FROM": "one@hushh.ai",
        "SUPPORT_EMAIL_TO": "one@hushh.ai",
        "SUPPORT_EMAIL_MODE": "live",
        "SUPPORT_EMAIL_TEST_TO": None if project == "hushh-pda" else "one@hushh.ai",
        "APP_FRONTEND_ORIGIN": origin,
        "GMAIL_OAUTH_CLIENT_ID": "1006304528804-client.apps.googleusercontent.com",
        "GMAIL_OAUTH_CLIENT_SECRET": "SECRET_GMAIL_DO_NOT_LEAK",  # noqa: S105
        "GMAIL_OAUTH_REDIRECT_URI": f"{origin}/one/profile/gmail/oauth/return",
        "GOOGLE_OAUTH_CLIENT_ID": "1006304528804-client.apps.googleusercontent.com",
        "GOOGLE_OAUTH_CLIENT_SECRET": "SECRET_GOOGLE_DO_NOT_LEAK",  # noqa: S105
        "GOOGLE_OAUTH_REDIRECT_URI": f"{origin}/one/profile/google/oauth/return",
        "GOOGLE_DRIVE_OAUTH_CLIENT_ID": (
            None if project == "hushh-pda-dev" else "731669910993-drive.apps.googleusercontent.com"
        ),
        "GOOGLE_DRIVE_OAUTH_CLIENT_SECRET": (
            None if project == "hushh-pda-dev" else "SECRET_DRIVE_DO_NOT_LEAK"  # noqa: S105
        ),
        "MICROSOFT_FIREBASE_CLIENT_ID": "da24bfba-1f80-47af-8444-7cee96efef18",
        "MICROSOFT_FIREBASE_CLIENT_SECRET": "SECRET_MS_DO_NOT_LEAK",  # noqa: S105
    }
    return base


def _healthy_http_stub(
    *,
    mail_transport: str = "google-workspace-gmail-delegated",
    ms_http_status: int = 400,
    ms_error_code: str = "invalid_grant",
    bad_redirect_substring: str | None = None,
):
    def _http(
        url: str,
        *,
        method: str = "GET",
        headers: dict[str, str] | None = None,
        body: bytes | None = None,
        follow_redirects: bool = True,
    ) -> tuple[int, dict[str, str], str]:
        if url.startswith("https://hushh-mail-api"):
            return 200, {}, json.dumps({"status": "healthy", "transport": mail_transport})
        if url == "https://oauth2.googleapis.com/token":
            assert method == "POST"
            return (
                400,
                {},
                json.dumps({"error": "invalid_grant", "error_description": "Malformed auth code."}),
            )
        if url.startswith("https://accounts.google.com/o/oauth2/v2/auth"):
            assert follow_redirects is False
            if bad_redirect_substring and bad_redirect_substring in url:
                encoded_err = (
                    base64.urlsafe_b64encode(b"redirect_uri_mismatch").decode("ascii").rstrip("=")
                )
                return (
                    302,
                    {
                        "location": f"https://accounts.google.com/signin/oauth/error?authError={encoded_err}"
                    },
                    "",
                )
            return 302, {"location": "https://accounts.google.com/v3/signin/identifier?dsh=123"}, ""
        if url == "https://login.microsoftonline.com/common/oauth2/v2.0/token":
            assert method == "POST"
            return ms_http_status, {}, json.dumps({"error": ms_error_code})
        raise AssertionError(f"unexpected HTTP call: {method} {url}")

    return _http


def test_verify_deploy_passes_and_never_leaks_secrets():
    mod = _load_mod()
    for env, proj in (
        ("dev", "hushh-pda-dev"),
        ("uat", "hushh-pda-uat"),
        ("production", "hushh-pda"),
    ):
        secrets = _healthy_secrets_for(proj)
        report = mod.verify_project_deploy_posture(
            proj,
            env,
            secret_reader=lambda _p, k, s=secrets: str(s[k]),
            optional_secret_reader=lambda _p, k, s=secrets: s.get(k),
            http_request=_healthy_http_stub(),
        )
        assert report["ok"] is True
        assert report["errors"] == []
        serialized = json.dumps(report)
        for forbidden in (
            "SECRET_GMAIL_DO_NOT_LEAK",
            "SECRET_GOOGLE_DO_NOT_LEAK",
            "SECRET_DRIVE_DO_NOT_LEAK",
            "SECRET_MS_DO_NOT_LEAK",
        ):
            assert forbidden not in serialized


def test_verify_deploy_flags_legacy_sender_redirect_mismatch_and_invalid_ms_secret():
    mod = _load_mod()
    secrets = _healthy_secrets_for("hushh-pda-uat")
    secrets["SUPPORT_EMAIL_TEST_TO"] = "ankit@hushh.ai"

    report = mod.verify_project_deploy_posture(
        "hushh-pda-uat",
        "uat",
        secret_reader=lambda _p, k: str(secrets[k]),
        optional_secret_reader=lambda _p, k: secrets.get(k),
        http_request=_healthy_http_stub(
            mail_transport="smtp-fallback",
            ms_http_status=401,
            ms_error_code="invalid_client",
            bad_redirect_substring="connectors",
        ),
    )
    assert report["ok"] is False
    joined = "\n".join(report["errors"])
    assert "SUPPORT_EMAIL_TEST_TO" in joined
    assert "hushh-mail-api" in joined
    assert "redirect_uri_mismatch" in joined
    assert "Microsoft OAuth token probe failed" in joined
    assert "SECRET_MS_DO_NOT_LEAK" not in json.dumps(report)


def test_reconcile_entra_apply_remediates_redirects_grants_domain_and_guest():
    mod = _load_mod()
    state: dict[str, Any] = {
        "auth_policy": {
            "id": "authorizationPolicy",
            "guestUserRoleId": mod.RESTRICTED_GUEST_ROLE_ID,
        },
        "apps": {
            mod.EXPECTED_MS_SIGNIN_APP_OBJECT_ID: {
                "id": mod.EXPECTED_MS_SIGNIN_APP_OBJECT_ID,
                "appId": mod.EXPECTED_MS_SIGNIN_CLIENT_ID,
                "displayName": "Hussh One Sign-In",
                "signInAudience": "AzureADandPersonalMicrosoftAccount",
                "publisherDomain": "kushalhushh.onmicrosoft.com",
                "web": {"redirectUris": list(mod.REQUIRED_SIGNIN_REDIRECT_URIS[:-3])},
            },
            mod.EXPECTED_MS_CLOUD_APP_OBJECT_ID: {
                "id": mod.EXPECTED_MS_CLOUD_APP_OBJECT_ID,
                "appId": mod.EXPECTED_MS_CLOUD_CLIENT_ID,
                "displayName": "Hussh Cloud Connect",
                "signInAudience": "AzureADandPersonalMicrosoftAccount",
                "publisherDomain": "kushalhushh.onmicrosoft.com",
                "web": {"redirectUris": list(mod.REQUIRED_CLOUD_CONNECT_REDIRECT_URIS[:-4])},
            },
        },
        "sps": {
            mod.EXPECTED_MS_SIGNIN_SP_ID: {
                "id": mod.EXPECTED_MS_SIGNIN_SP_ID,
                "displayName": "Hussh One Sign-In",
                "appRoleAssignmentRequired": False,
            },
            mod.EXPECTED_MS_CLOUD_SP_ID: {
                "id": mod.EXPECTED_MS_CLOUD_SP_ID,
                "displayName": "Hussh Cloud Connect",
                "appRoleAssignmentRequired": False,
            },
        },
        "az_cli_sp": None,
        "grants": [],
        "domains": [{"id": "kushalhushh.onmicrosoft.com", "isVerified": True}],
        "guests": [
            {
                "id": "a7a48425-3141-45f6-9137-0982931d523a",
                "displayName": "parth",
                "mail": "parth@hushh.ai",
                "otherMails": ["parth@hushh.ai"],
                "externalUserState": "Accepted",
                "identities": [{"issuer": "mail", "signInType": "federated"}],
            },
            {
                "id": "c3de88ae-3b7e-4570-93dc-682eeb9926f7",
                "displayName": "anoushka",
                "mail": "anoushka@hushh.ai",
                "otherMails": ["anoushka@hushh.ai"],
                "externalUserState": "PendingAcceptance",
                "identities": [],
            },
            {
                "id": "3f2ce903-c966-4299-a00e-59d6517b837a",
                "displayName": "ankit",
                "mail": "ankit@hushh.ai",
                "otherMails": ["ankit@hushh.ai"],
                "externalUserState": "PendingAcceptance",
                "identities": [],
            },
        ],
        "invited_emails": [],
    }

    def fake_graph(method: str, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        if method == "GET" and path == "policies/authorizationPolicy":
            return dict(state["auth_policy"])
        if method == "PATCH" and path == "policies/authorizationPolicy":
            assert payload is not None
            state["auth_policy"].update(payload)
            return {}
        if method == "GET" and path.startswith("applications/"):
            obj_id = path.split("?", 1)[0].split("/", 1)[1]
            return dict(state["apps"][obj_id])
        if method == "PATCH" and path.startswith("applications/"):
            obj_id = path.split("/", 1)[1]
            assert payload is not None
            if "web" in payload:
                state["apps"][obj_id]["web"] = payload["web"]
            return {}
        if method == "GET" and path.startswith("servicePrincipals?"):
            return {"value": [state["az_cli_sp"]] if state["az_cli_sp"] else []}
        if method == "POST" and path == "servicePrincipals":
            assert payload == {"appId": mod.AZURE_CLI_APP_ID}
            state["az_cli_sp"] = {
                "id": "az-cli-sp-id",
                "appId": mod.AZURE_CLI_APP_ID,
                "displayName": "Microsoft Azure CLI",
                "appRoleAssignmentRequired": False,
            }
            return dict(state["az_cli_sp"])
        if method == "GET" and path.startswith("servicePrincipals/"):
            sp_id = path.split("?", 1)[0].split("/", 1)[1]
            return dict(state["sps"][sp_id])
        if method == "GET" and path == "oauth2PermissionGrants":
            return {"value": list(state["grants"])}
        if method == "POST" and path == "oauth2PermissionGrants":
            assert payload is not None
            new_id = f"grant-{len(state['grants']) + 1}"
            created = {"id": new_id, **payload}
            state["grants"].append(created)
            return created
        if method == "GET" and path == "domains":
            return {"value": list(state["domains"])}
        if method == "POST" and path == "domains":
            assert payload == {"id": "hussh.ai"}
            dom = {"id": "hussh.ai", "isVerified": False}
            state["domains"].append(dom)
            return dom
        if method == "POST" and path == "domains/hussh.ai/verify":
            raise RuntimeError("TXT record not found yet")
        if method == "GET" and path == "domains/hussh.ai/verificationDnsRecords":
            return {
                "value": [
                    {
                        "recordType": "Txt",
                        "label": "hussh.ai",
                        "text": "MS=ms12345678",
                        "ttl": 3600,
                    }
                ]
            }
        if method == "GET" and path.startswith("users?"):
            return {"value": list(state["guests"])}
        if method == "POST" and path == "invitations":
            assert payload is not None
            email = payload["invitedUserEmailAddress"]
            state["invited_emails"].append(email)
            if payload.get("resetRedemption"):
                assert payload["invitedUser"]["id"] == "a7a48425-3141-45f6-9137-0982931d523a"
            return {
                "status": "PendingAcceptance",
                "inviteRedeemUrl": f"https://login.microsoftonline.com/redeem?email={email}",
            }
        raise AssertionError(f"unexpected Graph call: {method} {path}")

    # Verify mode detects drift before --apply
    before = mod.reconcile_entra_org(
        apply=False,
        az_tenant_provider=lambda: mod.HUSHONE_TENANT_ID,
        graph_request=fake_graph,
    )
    assert before["ok"] is False
    assert before["authorizationPolicy"]["collaborativeGuestAccessEnabled"] is False
    assert len(before["guestAudit"]["emailOtpBoundUsers"]) == 1
    assert [u["email"] for u in before["guestAudit"]["pendingAcceptance"]] == ["anoushka@hushh.ai"]

    # Apply mode heals redirects, guest tier, Azure CLI SP + grants, stages hussh.ai, and invites active guests
    after = mod.reconcile_entra_org(
        apply=True,
        reset_guests=["parth@hushh.ai"],
        resend_pending_guests=True,
        az_tenant_provider=lambda: mod.HUSHONE_TENANT_ID,
        graph_request=fake_graph,
    )
    assert after["ok"] is True
    assert after["authorizationPolicy"]["collaborativeGuestAccessEnabled"] is True
    assert after["applications"]["Hussh One Sign-In"]["redirectUriCount"] == 15
    assert after["applications"]["Hussh Cloud Connect"]["redirectUriCount"] == 11
    assert len(state["grants"]) == 5
    assert after["customDomain"]["pendingDnsVerification"][0]["text"] == "MS=ms12345678"
    assert after["guestAudit"]["resets"][0]["inviteRedeemUrl"].endswith("parth@hushh.ai")
    assert after["guestAudit"]["pendingResends"][0]["email"] == "anoushka@hushh.ai"
    assert "ankit@hushh.ai" not in state["invited_emails"]

    # Refuses retired accounts explicitly
    refused = mod.reconcile_entra_org(
        apply=True,
        reset_guests=["ankit@hushh.ai"],
        az_tenant_provider=lambda: mod.HUSHONE_TENANT_ID,
        graph_request=fake_graph,
    )
    assert refused["ok"] is False
    assert "ankit@hushh.ai" in refused["errors"][0]


def test_hushh_az_cli_doctor_and_login_guidance():
    import subprocess

    az_mod = _load_mod("hushh_az_cli", _AZ_CLI_PATH)

    def ok_runner(args: list[str]) -> subprocess.CompletedProcess[str]:
        if args[:3] == ["az", "account", "show"]:
            return subprocess.CompletedProcess(
                args,
                0,
                stdout=json.dumps(
                    {
                        "tenantId": az_mod.HUSHONE_TENANT_ID,
                        "subscriptionId": az_mod.HUSHONE_SUBSCRIPTION_ID,
                        "subscriptionName": "Azure subscription",
                        "state": "Enabled",
                        "user": "parth@hushh.ai",
                    }
                ),
                stderr="",
            )
        if args[:3] == ["az", "group", "list"]:
            return subprocess.CompletedProcess(args, 0, stdout="4\n", stderr="")
        if args[:2] == ["az", "rest"]:
            return subprocess.CompletedProcess(
                args,
                0,
                stdout=json.dumps(
                    {
                        "id": "u1",
                        "displayName": "Parth",
                        "userPrincipalName": "parth_hushh.ai#EXT#",
                        "userType": "Guest",
                    }
                ),
                stderr="",
            )
        if args[:3] == ["az", "account", "set"]:
            return subprocess.CompletedProcess(args, 0, stdout="", stderr="")
        raise AssertionError(f"unexpected cmd: {args}")

    res = az_mod.check_az_posture(which_fn=lambda _: "/opt/homebrew/bin/az", run_fn=ok_runner)
    assert res["ok"] is True
    assert res["arm"]["resourceGroupCount"] == 4
    assert res["graphMe"]["userType"] == "Guest"

    bad_login = az_mod.login_az_team(
        device_code=True,
        which_fn=lambda _: "/opt/homebrew/bin/az",
        interactive_run_fn=lambda args: subprocess.CompletedProcess(args, 1, stdout="", stderr=""),
        run_fn=ok_runner,
    )
    assert bad_login["ok"] is False
    assert "AADSTS50020" in bad_login["errors"][0]
    assert "--device-code" in bad_login["errors"][0]
