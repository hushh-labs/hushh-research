"""The pod's ONE authenticated door to the hub.

A pod must never hold Postgres credentials. Giving it any would undo the property the
zero-role pod identity buys: `hussh-one-pod` holds no project roles, so a compromised
pod cannot reach the database at all. Everything a pod needs from the data plane
therefore travels pod -> hub -> Postgres, over exactly this client, so there is a
single auditable egress path rather than a scatter of ad-hoc calls.

**Keyless by construction.** The credential is a Google ID token minted from the
instance metadata server against the pod's own runtime service account -- no bearer
secret is stored in the pod, nothing to rotate, nothing to leak from the deploy
artifact. It matches how BYOC-USER-GCP.md wants a user-hosted pod to authenticate,
so the same client works when the pod runs in the user's own project.

**What the token proves, and what it does not.** Every pod runs as the SAME service
account, which is what lets that account hold no roles. So an ID token proves "this
caller is a hussh pod"; it does NOT prove WHICH user's pod. The pod therefore asserts
its own ``HUSSH_ID`` alongside the token, and that assertion is only as trustworthy as
the pod itself -- which is precisely the ``logical`` tier's stated trust level.
Cryptographic per-pod identity is what the attested ``dedicated`` tier (Confidential
Space, M5) is for. The hub-side acceptance of this identity is flag-gated OFF for that
reason; see ``pod_hub_identity_auth_enabled()``.
"""

from __future__ import annotations

import logging
import os
import time
from typing import Any, Optional

import requests  # type: ignore[import-untyped]

logger = logging.getLogger(__name__)

_METADATA_IDENTITY_URL = (
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity"
)
_METADATA_HEADERS = {"Metadata-Flavor": "Google"}

# Headers the pod sends alongside the ID token. The hub reads the asserted identity
# from these; see the module docstring for exactly how far that assertion goes.
POD_IDENTITY_HEADER = "X-Hushh-Pod-Id"
POD_SPACE_HEADER = "X-Hushh-Pod-Space"

# Re-mint slightly before expiry rather than on it, so a call in flight never races
# the boundary. Cloud Run identity tokens are ~1h.
_TOKEN_REFRESH_SKEW_SECONDS = 300


class PodHubUnavailable(RuntimeError):
    """The hub could not be reached or refused the pod. Never fabricate a fallback."""


def hub_base_url() -> Optional[str]:
    """Base URL of the hub this pod reads through, or None when unconfigured."""
    return (os.getenv("HUSSH_HUB_BASE_URL") or "").strip().rstrip("/") or None


class PodHubClient:
    """Authenticated GETs from a pod to the hub. Sync; callers use asyncio.to_thread."""

    def __init__(
        self,
        *,
        base_url: Optional[str] = None,
        timeout_seconds: float = 10.0,
        session: Any = None,
    ) -> None:
        self._base = (base_url if base_url is not None else hub_base_url()) or ""
        self._timeout = timeout_seconds
        # Injectable for hermetic tests; never reaches the metadata server in unit tests.
        self._session = session if session is not None else requests
        self._token: Optional[str] = None
        self._token_expiry: float = 0.0

    # -- identity ---------------------------------------------------------------

    def _identity_token(self) -> str:
        """A Google ID token for this pod, audience-bound to the hub.

        Audience binding matters: a token minted for the hub cannot be replayed against
        any other service, so a hub compromise cannot yield a credential usable elsewhere.
        """
        now = time.time()
        if self._token and now < self._token_expiry:
            return self._token
        try:
            r = self._session.get(
                _METADATA_IDENTITY_URL,
                params={"audience": self._base, "format": "full"},
                headers=_METADATA_HEADERS,
                timeout=self._timeout,
            )
        except Exception as exc:  # noqa: BLE001 - surface as a typed failure
            raise PodHubUnavailable(f"metadata server unreachable: {type(exc).__name__}") from exc
        if getattr(r, "status_code", 0) != 200 or not (r.text or "").strip():
            raise PodHubUnavailable(
                f"metadata identity failed: HTTP {getattr(r, 'status_code', 0)}"
            )
        self._token = r.text.strip()
        # Cloud Run identity tokens last ~1h; refresh early rather than parsing the JWT.
        self._token_expiry = now + 3600 - _TOKEN_REFRESH_SKEW_SECONDS
        return self._token

    # -- transport --------------------------------------------------------------

    def _identity_headers(self, extra: Optional[dict[str, str]] = None) -> dict[str, str]:
        merged = {
            "Authorization": f"Bearer {self._identity_token()}",
            POD_IDENTITY_HEADER: (os.getenv("HUSSH_ID") or "").strip(),
            POD_SPACE_HEADER: (os.getenv("HUSSH_SPACE_ID") or "").strip(),
        }
        merged.update(extra or {})
        return merged

    def _url(self, path: str) -> str:
        if not self._base:
            raise PodHubUnavailable("HUSSH_HUB_BASE_URL is not set; the pod has no hub to read")
        return f"{self._base}{path if path.startswith('/') else '/' + path}"

    def get(
        self,
        path: str,
        *,
        params: Optional[dict[str, Any]] = None,
        headers: Optional[dict[str, str]] = None,
    ) -> Any:
        """GET ``path`` on the hub with the pod's identity attached.

        Returns the ``requests``-style response. Raises ``PodHubUnavailable`` when the
        hub cannot be reached at all -- callers must degrade deliberately rather than
        treat an outage as "no data", which would silently look like a missing record.
        """
        url = self._url(path)
        merged = self._identity_headers(headers)
        try:
            return self._session.get(
                url, params=params or {}, headers=merged, timeout=self._timeout
            )
        except Exception as exc:  # noqa: BLE001
            raise PodHubUnavailable(f"hub unreachable: {type(exc).__name__}") from exc

    def post(
        self,
        path: str,
        *,
        json: Optional[dict[str, Any]] = None,
        headers: Optional[dict[str, str]] = None,
    ) -> Any:
        """POST ``path`` on the hub with the pod's identity attached.

        Same failure contract as :meth:`get`: an unreachable hub raises rather than
        returning something a caller could mistake for a rejection. The distinction
        matters more here than on a read -- "the hub refused this" and "the hub could
        not be asked" call for opposite responses, and only one of them is worth a retry.
        """
        url = self._url(path)
        merged = self._identity_headers(headers)
        try:
            return self._session.post(url, json=json or {}, headers=merged, timeout=self._timeout)
        except Exception as exc:  # noqa: BLE001
            raise PodHubUnavailable(f"hub unreachable: {type(exc).__name__}") from exc

    def read_specialist(self, name: str, scope_token: str) -> dict[str, Any]:
        """Read a DB-backed specialist's state THROUGH the hub broker (the data door).

        This is the pod's egress to ``POST /api/one/pod/specialist/{name}/read``.
        The pod holds no database credential, so it hands the couriered per-turn
        scope token to the hub, which authenticates the pod, binds the scope to
        this pod's owner, runs the read on the owner's own project, and returns the
        fail-closed projection. Returns the ``state`` projection on success.

        Fails LOUD, never silent: an unreachable hub (from :meth:`post`) or any
        non-200 -- a revoked scope (403), an unknown door (404), a hub blip (5xx)
        -- raises ``PodHubUnavailable``. The caller degrades deliberately (the
        specialist reports runtime_unavailable, today's DB-wall behaviour); a
        swallowed failure that returned empty state would instead make the pod
        answer "you share with nobody" for a person who shares with many.
        """
        if not scope_token:
            raise PodHubUnavailable("no data-door scope token for this specialist")
        response = self.post(
            f"/api/one/pod/specialist/{name}/read", json={"scopeToken": scope_token}
        )
        status = getattr(response, "status_code", 502)
        if status != 200:
            raise PodHubUnavailable(f"hub refused specialist read name={name} status={status}")
        try:
            body = response.json()
        except Exception as exc:  # noqa: BLE001
            raise PodHubUnavailable("hub returned a non-JSON specialist body") from exc
        state = body.get("state") if isinstance(body, dict) else None
        if not isinstance(state, dict):
            raise PodHubUnavailable("hub returned no specialist state")
        return state
