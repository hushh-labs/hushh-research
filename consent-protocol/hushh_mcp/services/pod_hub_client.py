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

**Identity depends on deployment.** BYOC uses the owner's runtime service account;
the hub verifies its Google identity and binds that account to the registry entry
for the asserted ``HUSSH_ID``. The managed/simulation path accepts the configured
fleet account, which does not independently distinguish owners. Neither path alone
proves workload attestation. Hub acceptance remains flag-gated; each protected route
must also enforce its own current assignment and information/action authority.

**Every request is also signed** (``pod_request_signing``) with the Ed25519 key the
pod derives from its own X25519 key -- the one identity that works on every cloud.
On Google Cloud the ID token still rides alongside it during the transition; where
no metadata server exists (Azure) the signature is the pod's whole identity. The
body is serialised ONCE and sent as those exact bytes, so the signed body is the
sent body.
"""

from __future__ import annotations

import json as _json
import logging
import os
import time
from dataclasses import dataclass
from typing import Any, Optional
from urllib.parse import urlsplit

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

# Off Google Cloud there is no metadata server. Asking again on every call would
# spend a failed lookup per request, so an absence is remembered this long and the
# request goes out signed only.
_METADATA_ABSENT_RETRY_SECONDS = 60


@dataclass(frozen=True)
class VerifiedOwnerPod:
    """Verified Google caller identity, retained for transaction-time fencing."""

    hushh_id: str
    service_account: str


class PodHubUnavailable(RuntimeError):
    """The hub could not be reached or refused the pod. Never fabricate a fallback."""


def hub_base_url() -> Optional[str]:
    """Base URL of the hub this pod reads through, or None when unconfigured."""
    return (os.getenv("HUSSH_HUB_BASE_URL") or "").strip().rstrip("/") or None


def _signature_headers(
    aud: str, method: str, url: str, query_pairs: list[tuple[str, str]], body: bytes
) -> dict[str, str]:
    """This request's signature headers, or {} when the pod cannot sign it."""
    hushh_id = (os.getenv("HUSSH_ID") or "").strip()
    if not hushh_id:
        return {}
    try:
        from hushh_mcp.services.pod_request_signing import sign_pod_request  # noqa: PLC0415
        from hushh_mcp.services.pod_role import signing_epoch  # noqa: PLC0415
        from hushh_mcp.services.pod_self_registration import pod_signing_key  # noqa: PLC0415

        return sign_pod_request(
            pod_signing_key(),
            aud=aud,
            hushh_id=hushh_id,
            method=method,
            path=urlsplit(url).path,
            query_pairs=query_pairs,
            body=body,
            epoch=signing_epoch(),
        )
    except Exception as exc:  # noqa: BLE001 - an unsignable request keeps the token path
        logger.warning("pod_hub_client.signing_unavailable %s", type(exc).__name__)
        return {}


class PodHubClient:
    """Authenticated GETs from a pod to the hub. Sync; callers use asyncio.to_thread."""

    def __init__(
        self,
        *,
        base_url: Optional[str] = None,
        timeout_seconds: float = 10.0,
        session: Any = None,
    ) -> None:
        # Normalised exactly like hub_base_url(): the base is both the URL prefix and
        # the signed audience, and a trailing slash would change both.
        self._base = ((base_url if base_url is not None else hub_base_url()) or "").rstrip("/")
        self._timeout = timeout_seconds
        # Injectable for hermetic tests; never reaches the metadata server in unit tests.
        self._session = session if session is not None else requests
        self._token: Optional[str] = None
        self._token_expiry: float = 0.0
        self._metadata_absent_until: float = 0.0
        self._metadata_failure: str = ""

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

    def _google_identity_token(self) -> Optional[str]:
        """The Google ID token, or None when this pod has no metadata server to ask."""
        if time.time() < self._metadata_absent_until:
            return None
        try:
            return self._identity_token()
        except PodHubUnavailable as exc:
            self._metadata_absent_until = time.time() + _METADATA_ABSENT_RETRY_SECONDS
            self._metadata_failure = str(exc)
            return None

    # -- transport --------------------------------------------------------------

    def _identity_headers(
        self,
        method: str,
        url: str,
        *,
        query_pairs: Optional[list[tuple[str, str]]] = None,
        body: bytes = b"",
        extra: Optional[dict[str, str]] = None,
    ) -> dict[str, str]:
        """The ONE place a pod's identity is attached to a hub request."""
        merged = {
            POD_IDENTITY_HEADER: (os.getenv("HUSSH_ID") or "").strip(),
            POD_SPACE_HEADER: (os.getenv("HUSSH_SPACE_ID") or "").strip(),
        }
        token = self._google_identity_token()
        if token:
            merged["Authorization"] = f"Bearer {token}"
        signature = _signature_headers(self._base, method, url, list(query_pairs or []), body)
        if not token and not signature:
            raise PodHubUnavailable(self._metadata_failure or "pod has no identity to present")
        merged.update(signature)
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
        from hushh_mcp.services.pod_request_signing import (  # noqa: PLC0415
            query_pairs_from_params,
        )

        url = self._url(path)
        merged = self._identity_headers(
            "GET", url, query_pairs=query_pairs_from_params(params), extra=headers
        )
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

        The body is serialised here, once, and those exact bytes are both signed and
        sent. Letting the transport re-serialise would sign one body and send another.
        """
        url = self._url(path)
        body = _json.dumps(
            json or {}, separators=(",", ":"), ensure_ascii=False, allow_nan=False
        ).encode("utf-8")
        merged = self._identity_headers(
            "POST",
            url,
            body=body,
            extra={"Content-Type": "application/json", **(headers or {})},
        )
        try:
            return self._session.post(url, data=body, headers=merged, timeout=self._timeout)
        except Exception as exc:  # noqa: BLE001
            raise PodHubUnavailable(f"hub unreachable: {type(exc).__name__}") from exc

    def read_specialist(
        self,
        name: str,
        scope_token: str,
        *,
        calendar_read: dict[str, Any] | None = None,
        marketplace_read: dict[str, Any] | None = None,
        email_read: dict[str, Any] | None = None,
        command_read: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
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
        payload: dict[str, Any] = {"scopeToken": scope_token}
        if calendar_read is not None:
            payload["calendarRead"] = calendar_read
        if email_read is not None:
            payload["emailRead"] = email_read
        if marketplace_read is not None:
            payload["marketplaceRead"] = marketplace_read
        if command_read is not None:
            payload["commandRead"] = command_read
        response = self.post(f"/api/one/pod/specialist/{name}/read", json=payload)
        status = getattr(response, "status_code", 502)
        if status != 200:
            if name == "email" and email_read is not None and status == 409:
                from hushh_mcp.services.gmail_metadata_reader import (
                    MAIL_READ_ERROR_CODES,
                    GmailMetadataError,
                )

                try:
                    code = response.json()["detail"]["code"]
                except (ValueError, KeyError, TypeError):
                    code = None
                if isinstance(code, str) and code in MAIL_READ_ERROR_CODES:
                    raise GmailMetadataError(code)
            raise PodHubUnavailable(f"hub refused specialist read name={name} status={status}")
        try:
            body = response.json()
        except Exception as exc:  # noqa: BLE001
            raise PodHubUnavailable("hub returned a non-JSON specialist body") from exc
        state = body.get("state") if isinstance(body, dict) else None
        if not isinstance(state, dict):
            raise PodHubUnavailable("hub returned no specialist state")
        if calendar_read is not None:
            from datetime import datetime

            try:
                matches = (
                    name == "calendar" and state.get("operation") == calendar_read["operation"]
                )
                for requested, returned in (("start_at", "range_start"), ("end_at", "range_end")):
                    matches = matches and datetime.fromisoformat(
                        state[returned].replace("Z", "+00:00")
                    ) == datetime.fromisoformat(calendar_read[requested].replace("Z", "+00:00"))
                if not matches:
                    raise ValueError("calendar coverage mismatch")
            except (KeyError, TypeError, ValueError, AttributeError) as exc:
                raise PodHubUnavailable("hub did not confirm requested calendar coverage") from exc
        return state
