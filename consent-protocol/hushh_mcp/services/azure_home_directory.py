"""Which Microsoft Entra directory holds a person's Azure, found without asking them.

Connect Azure should feel like Google: sign in once and pick from what you have. ARM
only accepts a token from the directory that owns the subscription, and a personal
Microsoft account signing in through ``common`` gets a token from Microsoft's
consumer directory, which ARM refuses (measured 2026-10-03, AADSTS900144). So the
first sign-in asks only who the person is (``openid email profile``), and this module
names the directory the second, Azure sign-in should go to:

* a work or school account: the directory its own token names (``tid``);
* a personal account: the "Default Directory" Azure created when that account first
  signed up, whose domain Azure derives from the sign-in email
  (``kushaltrivedi1711@gmail.com`` -> ``kushaltrivedi1711gmail.onmicrosoft.com``,
  measured 2026-10-03). Microsoft publishes every directory's OpenID configuration,
  so the domain resolves to its id with no credentials.

A miss is not an error: ``None`` sends the person to the manual fallback (paste the
subscription id). Nothing here grants anything. The person still signs in to the
directory and Microsoft decides whether they belong to it; a wrong guess fails there.
"""

from __future__ import annotations

import re
from typing import Any, Optional

from hushh_mcp.services.azure_federation import ENTRA_AUTHORITY

#: The directory Entra issues personal Microsoft account tokens from.
CONSUMER_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad"
_ISSUER = re.compile(r"^https://login\.microsoftonline\.com/([0-9a-f-]{36})/v2\.0$")
_GUID = re.compile(r"^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$")
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def default_directory_domains(email: str) -> list[str]:
    """Candidate ``*.onmicrosoft.com`` domains for a personal account's directory."""
    address = str(email or "").strip().lower()
    if not _EMAIL.match(address):
        return []
    local, domain = address.split("@", 1)
    alnum = lambda text: re.sub(r"[^a-z0-9]", "", text)  # noqa: E731
    candidates = [alnum(local) + alnum(domain.split(".", 1)[0]), alnum(local) + alnum(domain)]
    seen: list[str] = []
    for prefix in candidates:
        if prefix and prefix not in seen and len(prefix) <= 27:
            seen.append(prefix)
    return [f"{prefix}.onmicrosoft.com" for prefix in seen]


def tenant_for_domain(domain: str, *, session: Any = None) -> Optional[str]:
    """The directory id a domain names, from Microsoft's public OpenID configuration."""
    if session is None:
        import requests  # type: ignore[import-untyped]  # noqa: PLC0415

        session = requests
    try:
        response = session.get(
            f"{ENTRA_AUTHORITY}/{domain}/v2.0/.well-known/openid-configuration", timeout=10
        )
        if getattr(response, "status_code", 0) != 200:
            return None
        match = _ISSUER.match(str(response.json().get("issuer") or ""))
    except Exception:  # noqa: BLE001 - an unknown domain is a miss, never a crash
        return None
    tenant = match.group(1).lower() if match else None
    return tenant if tenant and tenant != CONSUMER_TENANT else None


def home_directory(claims: dict, *, session: Any = None) -> Optional[str]:
    """The directory to send the Azure sign-in to, or ``None`` for the manual fallback."""
    tenant = str(claims.get("tid") or "").strip().lower()
    if _GUID.match(tenant) and tenant != CONSUMER_TENANT:
        return tenant
    email = str(claims.get("email") or claims.get("preferred_username") or "")
    for domain in default_directory_domains(email):
        found = tenant_for_domain(domain, session=session)
        if found:
            return found
    return None


__all__ = ["CONSUMER_TENANT", "default_directory_domains", "home_directory", "tenant_for_domain"]
