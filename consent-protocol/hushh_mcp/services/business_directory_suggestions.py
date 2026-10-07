"""Read-only adapter for the deployed directory. Identity comes from Firebase only."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import shutil
import subprocess
from typing import Any
from urllib.parse import urlsplit

import httpx
from google.auth.transport.requests import Request
from google.oauth2 import id_token
from starlette.concurrency import run_in_threadpool

DIRECTORY_ORIGIN = "https://hushh-directory-api-fro3hygenq-uc.a.run.app"
_IDENTITIES = {
    "hotel": ("hotels", {"id"}),
    "healthcare": ("providers", {"npi"}),
    "ria": ("firms", {"crd"}),
    "insurance": ("producers", {"source_state", "license_no"}),
    "business": ("businesses", {"source", "source_key"}),
}
_CONSUMER_DOMAINS = {"gmail.com", "googlemail.com", "yahoo.com", "outlook.com", "hotmail.com",
    "live.com", "icloud.com", "aol.com", "proton.me", "protonmail.com", "yahoo.co.in", "mail.com"}
# Local development may use the separately managed Gmail identity that owns
# the isolated gcloud profile. Keep this explicit rather than permitting an
# arbitrary consumer account to invoke the directory.
_LOCAL_GCLOUD_ALLOWLIST = {"husshpuppy5@gmail.com"}


class DirectoryUnavailable(RuntimeError):
    """Sanitized adapter failure, never carries contacts, tokens or response bodies."""


def _invocation_token(*, local: bool) -> str:
    account = os.getenv("HUSHH_LOCAL_GCLOUD_ACCOUNT", "").strip()
    if account:
        if not local or not (
            re.fullmatch(r"[A-Za-z0-9._+%-]+@hushh\.ai", account)
            or account.lower() in _LOCAL_GCLOUD_ALLOWLIST
        ):
            raise DirectoryUnavailable()
        # On Windows, ``shutil.which("gcloud")`` can resolve the PowerShell
        # shim (gcloud.ps1), which is blocked by restrictive execution
        # policies even though the supported gcloud.cmd wrapper works. Prefer
        # the command wrapper so local live-mode lookup is not silently
        # downgraded to an unavailable directory.
        executable = shutil.which("gcloud.cmd") or shutil.which("gcloud")
        if not executable:
            raise DirectoryUnavailable()
        result = subprocess.run(  # noqa: S603 - resolved CLI, validated account, no shell
            [executable, "auth", "print-identity-token", f"--account={account}", "--quiet"],
            capture_output=True, text=True, check=True, timeout=15,
        )
        token = result.stdout.strip()
    else:
        # Hosted workloads use their own service identity, never a browser token.
        token = id_token.fetch_id_token(Request(), DIRECTORY_ORIGIN)
    if not token or any(char.isspace() for char in token):
        raise DirectoryUnavailable()
    return token


def verified_contacts(record: Any, *, phone: str | None = None) -> tuple[str | None, str | None] | None:
    email = getattr(record, "email", None)
    if (getattr(record, "email_verified", False) is not True or not isinstance(email, str)
            or len(email) > 254 or not re.fullmatch(
                r"[^\s@]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}", email
            ) or ".." in email.split("@")[1]):
        email = None
    # Only Firebase or the account OTP claim supplies this verified phone.
    # US directories cannot match +91. Omit it rather than strip a country code.
    phone = phone or getattr(record, "phone_number", None)
    if not isinstance(phone, str) or not re.fullmatch(r"\+1[2-9]\d{9}", phone):
        phone = None
    email = email.lower() if email else None
    if email and email.split("@")[1] in _CONSUMER_DOMAINS:
        email = None
    return (email, phone) if email or phone else None


def project_directory_response(payload: Any, *, email: str | None, phone: str | None) -> dict[str, Any]:
    """Validate public provenance and recompute exact evidence, not ownership."""
    if (not isinstance(payload, dict) or payload.get("contract_version") != "b2b-onboarding.v1"
            or payload.get("scope") != "b2b" or payload.get("ownership_verified") is not False
            or payload.get("claim_created") is not False
            or payload.get("status") not in {"draft_ready", "needs_selection", "no_match", "unavailable"}
            or not isinstance(payload.get("warnings"), list)
            or type(payload.get("truncated")) is not bool
            or not isinstance(payload.get("candidates"), list)
            or len(payload["candidates"]) > 100):
        raise DirectoryUnavailable()
    candidates, seen = [], set()
    for row in payload["candidates"]:
        if not isinstance(row, dict) or row.get("ownership_verified") is not False:
            raise DirectoryUnavailable()
        vertical = row.get("vertical")
        if vertical not in _IDENTITIES:
            raise DirectoryUnavailable()
        table, keys = _IDENTITIES[vertical]
        identity = row.get("native_identity")
        draft = row.get("draft")
        name = row.get("name")
        if (row.get("canonical_table") != table or not isinstance(identity, dict)
                or set(identity) != keys or not isinstance(draft, dict)
                or not isinstance(name, str) or not name.strip() or len(name) > 160
                or any(not isinstance(value, str) or not value or len(value) > 512
                       for value in identity.values())):
            raise DirectoryUnavailable()
        source_key = json.dumps(identity, sort_keys=True, separators=(",", ":"))
        uid = f"urn:hushh:business:directory:{vertical}:" + hashlib.sha256(source_key.encode()).hexdigest()
        if uid in seen:
            raise DirectoryUnavailable()
        seen.add(uid)
        evidence = []
        website = draft.get("website", "")
        if not isinstance(website, str) or len(website) > 512:
            raise DirectoryUnavailable()
        parsed = urlsplit(website if "://" in website else "https://" + website)
        valid_url = parsed.scheme in {"https", "http"} and bool(parsed.hostname) and not parsed.username and not parsed.password
        domain = email.split("@")[1] if email else ""
        upstream_evidence = row.get("evidence")
        if not isinstance(upstream_evidence, dict):
            raise DirectoryUnavailable()
        if upstream_evidence.get("exact_website_domain_match") is True:
            if not domain or domain in _CONSUMER_DOMAINS or not valid_url or parsed.hostname.lower().removeprefix("www.").rstrip(".") != domain:
                raise DirectoryUnavailable()
            evidence.append({"kind": "verified_email_domain", "domain": domain})
        if upstream_evidence.get("exact_phone_match") is True:
            value = draft.get("phone")
            digits = re.sub(r"\D", "", value) if isinstance(value, str) else ""
            if not phone or digits not in {phone[1:], phone[2:]}:
                raise DirectoryUnavailable()
            evidence.append({"kind": "verified_phone"})
        if upstream_evidence.get("exact_owner_email_match") is True:
            if not email or vertical != "business":
                raise DirectoryUnavailable()
            evidence.append({"kind": "verified_email_identity", "email": email})
        if not evidence:
            raise DirectoryUnavailable()
        public_draft = {"name": name.strip(), "website": parsed.geturl() if valid_url else ""}
        for key in ("phone", "formatted_address", "address_line1", "street1", "city", "zip", "state", "category"):
            value = draft.get(key)
            if value is not None:
                if not isinstance(value, str) or len(value) > 512:
                    raise DirectoryUnavailable()
                public_draft[key] = value
        candidates.append({"business_uid": uid, "synthetic": False,
            "source_identity": {"source": "directory", "source_key": source_key, "vertical": vertical},
            "match_evidence": evidence, "draft": public_draft,
            "ownership_verified": False, "claim_created": False,
            "verification_required": ["business_authority"]})
    incomplete = bool(payload["warnings"] or payload["truncated"] or payload["status"] == "unavailable")
    if payload["status"] in {"no_match", "unavailable"} and candidates:
        raise DirectoryUnavailable()
    if payload["status"] in {"draft_ready", "needs_selection"} and not candidates:
        raise DirectoryUnavailable()
    return {"candidates": candidates, "coverage_incomplete": incomplete,
            "status": "suggestion_available" if candidates else "unavailable" if incomplete else "no_match"}


async def lookup_directory(email: str | None, phone: str | None, *, local: bool) -> dict[str, Any]:
    try:
        token = await asyncio.wait_for(run_in_threadpool(_invocation_token, local=local), 20)
        async with asyncio.timeout(40), httpx.AsyncClient(timeout=httpx.Timeout(35, connect=5), follow_redirects=False) as client:
            async with client.stream("POST", DIRECTORY_ORIGIN + "/api/v1/businesses/onboarding/lookup",
                    headers={"Authorization": f"Bearer {token}"},
                    json={key: value for key, value in {"work_email": email, "phone": phone}.items() if value}) as response:
                if response.status_code == 422 and (not email or not phone):
                    # Old deployed contracts demand both. Never label it no-match.
                    return {"status": "insufficient_signals", "candidates": [], "coverage_incomplete": True}
                response.raise_for_status()
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > 512_000:
                        raise DirectoryUnavailable()
        return project_directory_response(json.loads(body), email=email, phone=phone)
    except Exception:
        raise DirectoryUnavailable() from None
