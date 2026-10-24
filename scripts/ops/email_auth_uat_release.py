#!/usr/bin/env python3
"""UAT OTP prerequisites and existing policy activation; never emit credentials."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import quote, urlsplit

import httpx

ROOT = Path(__file__).resolve().parents[2]
PROTOCOL = ROOT / "consent-protocol"
MANIFEST = PROTOCOL / "config/email-auth/risk-manifest.json"
PROJECT = "hushh-pda-uat"
INSTANCE = "hushh-pda-uat:us-central1:hushh-uat-pg"
MAIL_API = "https://hushh-mail-api-646258530541.us-central1.run.app"
KEYS = ("EMAIL_AUTH_VERIFIER_KEY", "EMAIL_AUTH_PAYLOAD_KEY", "EMAIL_AUTH_LOOKUP_KEY")
sys.path.insert(0, str(PROTOCOL))


class ReleaseError(RuntimeError):
    """Only a fixed public stage name may be returned to the workflow."""


def require_uat() -> None:
    if os.getenv("GCP_PROJECT_ID") != PROJECT:
        raise ReleaseError("environment")


def enabled() -> bool:
    value = os.getenv("UAT_EMAIL_AUTH_ENABLED", "false")
    if value not in {"true", "false"}:
        raise ReleaseError("enable_flag")
    return value == "true"


def read_secret(name: str) -> str:
    result = subprocess.run(  # noqa: S603 - fixed project and authored secret names
        [
            shutil.which("gcloud") or "gcloud",
            "secrets",
            "versions",
            "access",
            "latest",
            f"--project={PROJECT}",
            f"--secret={name}",
        ],
        capture_output=True,
        text=True,
        check=False,
        timeout=40,
    )
    if result.returncode or not result.stdout.strip():
        raise ReleaseError("secret_binding")
    return result.stdout.strip()


def reviewed_risk():
    from hushh_mcp.services.email_auth.domain_policy import RiskSnapshot

    risk = RiskSnapshot.load(str(MANIFEST))
    if risk.expires_at <= time.time():
        raise ReleaseError("risk_expired")
    return risk


def preflight() -> dict:
    from hushh_mcp.services.email_auth.config import EmailAuthConfig
    from hushh_mcp.services.email_auth.one_sender import OneSenderTokenProvider

    for name in KEYS:
        os.environ[name] = read_secret(name)
    os.environ.update(
        {
            "EMAIL_AUTH_ENABLED": "true",
            "EMAIL_AUTH_RISK_MANIFEST": "/app/config/email-auth/risk-manifest.json",
            "EMAIL_AUTH_MAIL_API_ENDPOINT": MAIL_API,
            "EMAIL_AUTH_MAIL_API_KEY": read_secret("MAIL_API_KEY"),
            "EMAIL_AUTH_MAIL_FROM": "one@hushh.ai",
            "FIREBASE_ADMIN_CREDENTIALS_JSON": read_secret(
                "FIREBASE_ADMIN_CREDENTIALS_JSON"
            ),
        }
    )
    # The candidate binds Firebase credentials, not an unbound runner override.
    os.environ.pop("SUPPORT_EMAIL_SERVICE_ACCOUNT_JSON", None)
    config = EmailAuthConfig.from_env()
    config.require_ready()
    risk = reviewed_risk()
    response = httpx.post(
        f"{MAIL_API}/v1/send",
        headers={
            "x-api-key": config.mail_api_key,
            "x-one-gmail-access-token": "readiness-probe-not-a-real-token",
        },
        # Deliberately incomplete: no recipient/code, rate charge or Gmail send.
        json={"transport": "one-delegated"},
        timeout=12,
    )
    if (
        response.status_code != 400
        or response.json().get("error") != "Invalid One OTP request"
    ):
        raise ReleaseError("mail_consumer")
    try:
        if not asyncio.run(OneSenderTokenProvider().get()):
            raise ReleaseError("sender")
    except Exception:
        raise ReleaseError("sender") from None
    return {
        "enabled": True,
        "risk_version": risk.version,
        "mail_consumer": "one",
        "sender_ready": True,
    }


def activate(actor: str, sha: str) -> dict:
    expected = {
        "CLOUDSQL_INSTANCE_CONNECTION_NAME": INSTANCE,
        "DB_HOST": "127.0.0.1",
        "DB_PORT": "6543",
        "DB_NAME": "postgres",
        "HUSSH_RELEASE_ENVIRONMENT": "uat",
    }
    if any(os.getenv(name) != value for name, value in expected.items()):
        raise ReleaseError("database_target")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", actor) or not re.fullmatch(
        r"[0-9a-f]{40}", sha
    ):
        raise ReleaseError("release_identity")
    user, password = os.getenv("DB_USER", ""), os.getenv("DB_PASSWORD", "")
    if not user or not password:
        raise ReleaseError("database_credentials")
    risk = reviewed_risk()
    url = (
        f"postgresql://{quote(user, safe='')}:{quote(password, safe='')}"
        "@127.0.0.1:6543/postgres"
    )
    result = subprocess.run(  # noqa: S603 - existing operator CLI and attested UAT target
        [
            sys.executable,
            str(PROTOCOL / "scripts/email_auth_policy.py"),
            "activate",
            "--manifest",
            str(MANIFEST),
            "--expected-database",
            "postgres",
            "--actor",
            actor,
            "--reason",
            f"UAT email OTP activation for {sha}",
        ],
        env={**os.environ, "EMAIL_AUTH_POLICY_DATABASE_URL": url},
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )
    if result.returncode:
        raise ReleaseError("policy_activation")
    report = json.loads(result.stdout)
    if report.get("action") != "activated" or report.get("risk") != risk.version:
        raise ReleaseError("policy_activation")
    return report


def verify_candidate(backend_url: str) -> dict:
    parsed = urlsplit(backend_url)
    if (
        parsed.scheme != "https"
        or not (parsed.hostname or "").endswith(".a.run.app")
        or parsed.username
        or parsed.password
        or parsed.port
        or parsed.query
        or parsed.fragment
        or parsed.path not in {"", "/"}
    ):
        raise ReleaseError("candidate_origin")
    # Health can precede the email service's database-pool initialization. The
    # measured UAT cold response took 19.2s; the former 15s probe refused it.
    # Retry only this read, never policy activation or an authentication effect.
    for attempt in range(2):
        try:
            response = httpx.get(
                f"{backend_url.rstrip('/')}/api/auth/email/capabilities", timeout=30
            )
        except (httpx.TimeoutException, httpx.TransportError) as error:
            if attempt == 0:
                time.sleep(2)
                continue
            stage = (
                "candidate_timeout"
                if isinstance(error, httpx.TimeoutException)
                else "candidate_transport"
            )
            raise ReleaseError(stage) from None
        if response.status_code != 200:
            raise ReleaseError("candidate_capabilities")
        try:
            capabilities = response.json()
        except ValueError:
            raise ReleaseError("candidate_response") from None
        if not isinstance(capabilities, dict):
            raise ReleaseError("candidate_response")
        if capabilities.get("enabled") is not True:
            raise ReleaseError("candidate_capabilities")
        return {"enabled": True, "candidate_ready": True}
    raise ReleaseError("candidate_timeout")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command", choices=("preflight", "activate", "verify-candidate")
    )
    parser.add_argument("--actor", default="")
    parser.add_argument("--sha", default="")
    parser.add_argument("--backend-url", default="")
    args = parser.parse_args()
    try:
        if not enabled():
            print(json.dumps({"enabled": False}))
            return 0
        require_uat()
        if args.command == "preflight":
            report = preflight()
        elif args.command == "activate":
            report = activate(args.actor, args.sha)
        else:
            report = verify_candidate(args.backend_url)
        print(json.dumps(report))
        return 0
    except Exception as error:
        stage = str(error) if isinstance(error, ReleaseError) else "prerequisite"
        print(json.dumps({"error": "email_auth_release_blocked", "stage": stage}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
