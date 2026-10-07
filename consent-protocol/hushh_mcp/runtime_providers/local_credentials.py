"""Explicit local CLI identity; never rewrite the developer's shared ADC files."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlencode

from google.auth.exceptions import RefreshError, TransportError
from google.oauth2.credentials import Credentials


def local_cli_credentials() -> Credentials | None:
    account = os.getenv("HUSHH_LOCAL_GCLOUD_ACCOUNT", "").strip()
    if not account:
        return None
    if (
        os.getenv("ENVIRONMENT", "").strip().lower() != "development"
        or os.getenv("APP_RUNTIME_PROFILE", "").strip().lower() != "local"
        or os.getenv("HUSHH_DEPLOY_ENV", "").strip()
        or os.getenv("K_SERVICE", "").strip()
        or not re.fullmatch(r"[A-Za-z0-9._+%-]+@[A-Za-z0-9.-]+", account)
    ):
        raise RuntimeError("Explicit CLI credentials are restricted to the local runtime")

    def refresh(request: Any, scopes: Any = None) -> tuple[str, datetime]:
        del scopes
        executable = shutil.which("gcloud")
        if not executable:
            raise RefreshError("Local Google Cloud CLI is unavailable")
        try:
            result = subprocess.run(  # noqa: S603 - resolved executable, validated account, no shell
                [executable, "auth", "print-access-token", f"--account={account}", "--quiet"],
                capture_output=True, text=True, timeout=15, check=True,
            )
            token = result.stdout.strip()
            if not token or any(char.isspace() for char in token):
                raise ValueError("Invalid token response")
            # gcloud may return a cached token. Use its real remaining lifetime,
            # and verify the selected identity without putting credentials in URLs.
            response = request(
                url="https://oauth2.googleapis.com/tokeninfo", method="POST",
                body=urlencode({"access_token": token}).encode(),
                headers={"Content-Type": "application/x-www-form-urlencoded"}, timeout=10,
            )
            metadata = json.loads(response.data)
            remaining = int(metadata.get("expires_in", 0))
            if response.status != 200 or metadata.get("email") != account or remaining <= 300:
                raise ValueError("Invalid token identity or lifetime")
            expiry = datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(seconds=remaining - 30)
        except (OSError, subprocess.SubprocessError, ValueError, TypeError, AttributeError, TransportError):
            # Provider output can contain credentials. Never attach it to errors/logs.
            raise RefreshError("Local workspace authentication needs reauthentication") from None
        return token, expiry

    return Credentials(token=None, refresh_handler=refresh)
