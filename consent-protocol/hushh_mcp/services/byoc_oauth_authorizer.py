"""One-click BYOC authorization: the person signs in to Google, hushh runs the plan.

THE DEFAULT IS SIMPLE (founder directive, 2026-08-20)
-----------------------------------------------------
The copy-a-command flow asked a person to open a terminal in the middle of
onboarding. It stays — as the FALLBACK. The default is now: sign in to Google,
approve once, done. This module is the server side of that flow.

WHAT THE PERSON'S TOKEN IS USED FOR, AND FOR HOW LONG
-----------------------------------------------------
The OAuth grant is ``cloud-platform`` scoped and ONLINE-ONLY: no refresh token is
requested, nothing is persisted, and the access token lives in memory for exactly
one ``apply_authorization`` call. What hushh DURABLY holds afterwards is identical
to the script's end state: ``roles/iam.serviceAccountTokenCreator`` on the
person's own ``one-bootstrap`` service account — one narrow grant, revocable with
one command, over an account the person owns.

THE PLAN IS THE SCRIPT'S PLAN
-----------------------------
Both routes read ``BOOTSTRAP_ROLES`` and ``REQUIRED_SERVICES`` from
``user_gcp_bootstrap`` — the same constants
``tests/test_byoc_authorization_script_matches_the_applier.py`` pins the shell
script to — so the two paths cannot drift apart without a test going red.

IAM WRITES ARE ADD-ONLY, STRUCTURALLY
-------------------------------------
Every policy write here is read-merge-write: fetch the policy, append only the
missing bindings, set with the fetched etag. A whole-policy replace silently
drops every binding you did not know about (safe-changes R3); the merge shape
makes that mistake unrepresentable rather than remembered-against.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import time
import urllib.parse
from typing import Any

logger = logging.getLogger(__name__)

_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
_TOKEN_URL = "https://oauth2.googleapis.com/token"  # noqa: S105 - OAuth endpoint, not a credential
_SCOPE = "https://www.googleapis.com/auth/cloud-platform"
_STATE_PREFIX = "byoc."
_STATE_TTL_SECONDS = 600
_ENABLE_POLL_SECONDS = 150
_TOKEN_CREATOR_ROLE = "roles/iam.serviceAccountTokenCreator"  # noqa: S105 - an IAM role name, not a credential


class ByocAuthorizeError(Exception):
    """A refusal with an HTTP shape, so the route can pass it through honestly."""

    def __init__(self, message: str, *, status_code: int = 400, code: str = "AUTHORIZE_FAILED"):
        super().__init__(message)
        self.status_code = status_code
        self.code = code


def _signing_key() -> bytes:
    from hushh_mcp.runtime_settings import get_core_security_settings

    key = get_core_security_settings().app_signing_key
    if not key:
        raise ByocAuthorizeError(
            "Authorization signing is not configured", status_code=503, code="NOT_CONFIGURED"
        )
    return key.encode()


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _unb64(raw: str) -> bytes:
    return base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4))


def make_state(user_id: str, project: str) -> str:
    """A stateless, signed, expiring binding of (who, which project) for the round-trip."""
    exp = str(int(time.time()) + _STATE_TTL_SECONDS)
    payload = _b64(f"{user_id}|{project}".encode())
    mac = hmac.new(_signing_key(), f"{exp}.{payload}".encode(), hashlib.sha256).hexdigest()
    return f"{_STATE_PREFIX}{exp}.{payload}.{mac}"


def verify_state(state: str, user_id: str) -> str:
    """The project the state names — or a refusal. Binds to the CALLER's uid."""
    if not state.startswith(_STATE_PREFIX):
        raise ByocAuthorizeError("Unrecognized authorization state", code="BAD_STATE")
    try:
        exp, payload, mac = state[len(_STATE_PREFIX) :].split(".", 2)
        expected = hmac.new(_signing_key(), f"{exp}.{payload}".encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(mac, expected):
            raise ByocAuthorizeError("Authorization state failed verification", code="BAD_STATE")
        if int(exp) < time.time():
            raise ByocAuthorizeError(
                "This authorization expired; start it again", code="STATE_EXPIRED"
            )
        uid, project = _unb64(payload).decode().split("|", 1)
    except ByocAuthorizeError:
        raise
    except Exception as exc:  # noqa: BLE001 - malformed input is a refusal, not a crash
        raise ByocAuthorizeError("Malformed authorization state", code="BAD_STATE") from exc
    if uid != user_id:
        # The state is not a bearer secret: it only completes for the signed-in
        # account that began it.
        raise ByocAuthorizeError(
            "This authorization belongs to a different sign-in", code="BAD_STATE"
        )
    return project


def _oauth_client() -> tuple[str, str, str]:
    """client_id, client_secret, redirect_uri — the SAME registered client and
    return route the Google connectors use, so no new console surface exists."""
    from hushh_mcp.services.google_connection_service import GoogleConnectionService

    svc = GoogleConnectionService()
    client_id = svc._client_id()  # noqa: SLF001 - deliberate in-repo reuse of one config source
    client_secret = svc._client_secret()  # noqa: SLF001
    if not client_id or not client_secret:
        raise ByocAuthorizeError(
            "Google sign-in is not configured on this deployment",
            status_code=503,
            code="NOT_CONFIGURED",
        )
    redirect = svc._redirect_uri(None)  # noqa: SLF001 - enforces the registered origin
    return client_id, client_secret, redirect


def begin(user_id: str, project: str) -> str:
    """The Google consent URL for a one-time, online-only cloud-platform grant."""
    client_id, _secret, redirect = _oauth_client()
    query = urllib.parse.urlencode(
        {
            "client_id": client_id,
            "redirect_uri": redirect,
            "response_type": "code",
            "scope": _SCOPE,
            # ONLINE ONLY: no refresh token exists to store, so "we keep nothing"
            # is a property of the request, not a promise about our database.
            "access_type": "online",
            "prompt": "consent",
            "state": make_state(user_id, project),
        }
    )
    return f"{_AUTH_URL}?{query}"


def exchange_code(code: str, *, session: Any = None) -> str:
    """The person's transient access token. Never logged, never stored."""
    if session is None:
        import requests as session  # noqa: PLC0415

    client_id, client_secret, redirect = _oauth_client()
    response = session.post(
        _TOKEN_URL,
        data={
            "code": code,
            "client_id": client_id,
            "client_secret": client_secret,
            "redirect_uri": redirect,
            "grant_type": "authorization_code",
        },
        timeout=30,
    )
    if response.status_code != 200:
        raise ByocAuthorizeError(
            "Google did not accept the sign-in; try again", status_code=502, code="EXCHANGE_FAILED"
        )
    token = str(response.json().get("access_token") or "")
    if not token:
        raise ByocAuthorizeError(
            "Google returned no usable token", status_code=502, code="EXCHANGE_FAILED"
        )
    return token


def _check(response: Any, what: str, *, ok_statuses: tuple[int, ...] = (200,)) -> dict:
    if response.status_code in ok_statuses:
        try:
            return response.json() if response.content else {}
        except Exception:  # noqa: BLE001
            return {}
    if response.status_code == 403:
        raise ByocAuthorizeError(
            f"Your Google account does not have permission to {what} on this project. "
            "You need to be an owner of the project you named.",
            status_code=403,
            code="INSUFFICIENT_PERMISSION",
        )
    raise ByocAuthorizeError(
        f"Google refused while trying to {what} (HTTP {response.status_code})",
        status_code=502,
        code="AUTHORIZE_FAILED",
    )


def apply_authorization(
    *,
    project: str,
    token: str,
    caller_sa: str,
    bootstrap_account_id: str = "one-bootstrap",
    session: Any = None,
    sleep: Any = time.sleep,
) -> dict[str, Any]:
    """Run the script's exact plan under the PERSON's own identity.

    Idempotent throughout: re-running against an already-authorized project
    changes nothing and succeeds.
    """
    if session is None:
        import requests as session  # noqa: PLC0415

    from hushh_mcp.services.user_gcp_bootstrap import BOOTSTRAP_ROLES, REQUIRED_SERVICES

    headers = {"Authorization": f"Bearer {token}"}
    sa_email = f"{bootstrap_account_id}@{project}.iam.gserviceaccount.com"
    sa_member = f"serviceAccount:{sa_email}"
    caller_member = f"serviceAccount:{caller_sa}"

    # 1. Enable the APIs the bootstrap needs (long-running operation; poll it).
    enable = session.post(
        f"https://serviceusage.googleapis.com/v1/projects/{project}/services:batchEnable",
        headers=headers,
        json={"serviceIds": list(REQUIRED_SERVICES)},
        timeout=60,
    )
    op = _check(enable, "enable the required Google APIs")
    op_name = str(op.get("name") or "")
    deadline = time.monotonic() + _ENABLE_POLL_SECONDS
    while op_name and not op.get("done"):
        if time.monotonic() > deadline:
            raise ByocAuthorizeError(
                "Enabling Google APIs is taking too long; try again in a minute",
                status_code=504,
                code="ENABLE_TIMEOUT",
            )
        sleep(5)
        op = _check(
            session.get(
                f"https://serviceusage.googleapis.com/v1/{op_name}", headers=headers, timeout=30
            ),
            "check API enablement",
        )

    # 2. The bootstrap service account (409 = it already exists = fine).
    created = session.post(
        f"https://iam.googleapis.com/v1/projects/{project}/serviceAccounts",
        headers=headers,
        json={
            "accountId": bootstrap_account_id,
            "serviceAccount": {"displayName": "One bootstrap (BYOC)"},
        },
        timeout=30,
    )
    _check(created, "create the bootstrap service account", ok_statuses=(200, 409))

    # 3. Project roles for the bootstrap SA — read-merge-write, add-only (R3).
    crm = f"https://cloudresourcemanager.googleapis.com/v1/projects/{project}"
    policy = _check(
        session.post(f"{crm}:getIamPolicy", headers=headers, json={}, timeout=30),
        "read the project's IAM policy",
    )
    bindings = list(policy.get("bindings") or [])
    changed = False
    for role, _why in BOOTSTRAP_ROLES:
        entry = next((b for b in bindings if b.get("role") == role), None)
        if entry is None:
            bindings.append({"role": role, "members": [sa_member]})
            changed = True
        elif sa_member not in (entry.get("members") or []):
            entry.setdefault("members", []).append(sa_member)
            changed = True
    if changed:
        policy["bindings"] = bindings
        _check(
            session.post(
                f"{crm}:setIamPolicy", headers=headers, json={"policy": policy}, timeout=30
            ),
            "grant the bootstrap roles",
        )

    # 4. The ONE durable grant to hushh: tokenCreator on that SA alone.
    sa_url = f"https://iam.googleapis.com/v1/projects/{project}/serviceAccounts/{sa_email}"
    sa_policy = _check(
        session.post(f"{sa_url}:getIamPolicy", headers=headers, json={}, timeout=30),
        "read the bootstrap account's policy",
    )
    sa_bindings = list(sa_policy.get("bindings") or [])
    entry = next((b for b in sa_bindings if b.get("role") == _TOKEN_CREATOR_ROLE), None)
    if entry is None:
        sa_bindings.append({"role": _TOKEN_CREATOR_ROLE, "members": [caller_member]})
        sa_policy["bindings"] = sa_bindings
        _check(
            session.post(
                f"{sa_url}:setIamPolicy", headers=headers, json={"policy": sa_policy}, timeout=30
            ),
            "grant hushh's one permission",
        )
    elif caller_member not in (entry.get("members") or []):
        entry.setdefault("members", []).append(caller_member)
        sa_policy["bindings"] = sa_bindings
        _check(
            session.post(
                f"{sa_url}:setIamPolicy", headers=headers, json={"policy": sa_policy}, timeout=30
            ),
            "grant hushh's one permission",
        )

    # 5. The script's closing assertion: the bootstrap account has NO exportable keys.
    keys = _check(
        session.get(
            f"{sa_url}/keys", headers=headers, params={"keyTypes": "USER_MANAGED"}, timeout=30
        ),
        "verify the bootstrap account has no keys",
    )
    if keys.get("keys"):
        raise ByocAuthorizeError(
            "The bootstrap account has an exportable key; delete it and authorize again",
            status_code=409,
            code="KEY_EXISTS",
        )

    logger.info("byoc_oauth.authorized project=%s services=%d", project, len(REQUIRED_SERVICES))
    return {"project": project, "bootstrapServiceAccount": sa_email}


# ---------------------------------------------------------------------------
# The PRODUCTION path: nothing exists yet, and the app is the person's only tool.
#
# A real person has no pre-created project, no gcloud, and no operator behind
# the curtain. So the same transient token that authorizes must also be able to
# CREATE the project (personal account, no parent) and LINK billing — the two
# steps the guided console route made manual. The console + CLI route remains,
# demoted to fallback.
# ---------------------------------------------------------------------------

_CRM_URL = "https://cloudresourcemanager.googleapis.com/v1"
_BILLING_URL = "https://cloudbilling.googleapis.com/v1"
_CREATE_POLL_SECONDS = 90


def ensure_project(
    *,
    project_id: str,
    display_name: str,
    token: str,
    session: Any = None,
    sleep: Any = time.sleep,
) -> dict[str, Any]:
    """The project exists and is the caller's, creating it if needed.

    Personal-account creation, deliberately parentless: ``projects.create`` with
    no parent lands the project directly under the signed-in person, which is
    exactly the tenancy BYOC promises. (The delegated org/folder path lives in
    ``user_gcp_project.create_project`` and stays separate — it needs an
    org-level grant this flow never asks for.)
    """
    if session is None:
        import requests as session  # noqa: PLC0415

    headers = {"Authorization": f"Bearer {token}"}

    probe = session.get(f"{_CRM_URL}/projects/{project_id}", headers=headers, timeout=30)
    if probe.status_code == 200:
        state = str(probe.json().get("lifecycleState") or "")
        if state == "ACTIVE":
            return {"projectId": project_id, "created": False}
        raise ByocAuthorizeError(
            f"The name {project_id} belongs to a project that is "
            f"{'being deleted' if state == 'DELETE_REQUESTED' else state.lower() or 'unavailable'}. "
            "Google reserves deleted names for about 30 days — pick a different name.",
            status_code=409,
            code="NAME_UNAVAILABLE",
        )

    created = session.post(
        f"{_CRM_URL}/projects",
        headers={**headers, "Content-Type": "application/json"},
        json={
            "projectId": project_id,
            "name": display_name or project_id,
            "labels": {"created-by": "hussh-one", "tenancy": "user-owned"},
        },
        timeout=60,
    )
    if created.status_code == 409:
        # Exists but the probe could not see it: someone else's, or this
        # person's own soft-deleted one. Either way the name is not usable.
        raise ByocAuthorizeError(
            f"The name {project_id} is already taken (possibly by a recently "
            "deleted project — Google reserves those names for about 30 days). "
            "Pick a different name.",
            status_code=409,
            code="NAME_UNAVAILABLE",
        )
    op = _check(created, "create your Google Cloud project")

    op_name = str(op.get("name") or "")
    deadline = time.monotonic() + _CREATE_POLL_SECONDS
    while op_name and not op.get("done"):
        if time.monotonic() > deadline:
            raise ByocAuthorizeError(
                "Google is taking unusually long to create the project; try again "
                "in a minute — the name is yours now.",
                status_code=504,
                code="CREATE_TIMEOUT",
            )
        sleep(3)
        op = _check(
            session.get(f"{_CRM_URL}/{op_name}", headers=headers, timeout=30),
            "check project creation",
        )
    if op.get("error"):
        raise ByocAuthorizeError(
            "Google refused to create the project: "
            + str(op["error"].get("message") or "no reason given"),
            status_code=502,
            code="CREATE_FAILED",
        )

    logger.info("byoc_oauth.project_created project=%s", project_id)
    return {"projectId": project_id, "created": True}


def ensure_billing(*, project_id: str, token: str, session: Any = None) -> dict[str, Any]:
    """The project has billing, linking the person's own account if needed.

    Google refuses almost every API on an unbilled project, so this is not
    optional polish — without it the authorize step fails three calls later with
    an error naming none of this. When the person has exactly one open billing
    account the link is automatic; zero or several is THEIR decision, returned
    as a typed refusal the UI can explain rather than guessed at.
    """
    if session is None:
        import requests as session  # noqa: PLC0415

    headers = {"Authorization": f"Bearer {token}"}

    info = _check(
        session.get(
            f"{_BILLING_URL}/projects/{project_id}/billingInfo", headers=headers, timeout=30
        ),
        "read the project's billing state",
    )
    if info.get("billingEnabled"):
        return {"billingLinked": False, "billingAccount": str(info.get("billingAccountName") or "")}

    accounts = _check(
        session.get(f"{_BILLING_URL}/billingAccounts", headers=headers, timeout=30),
        "list your billing accounts",
    )
    open_accounts = [a for a in (accounts.get("billingAccounts") or []) if a.get("open")]
    if len(open_accounts) != 1:
        raise ByocAuthorizeError(
            (
                "Your Google account has no open billing account. Create one at "
                "console.cloud.google.com/billing, then press Continue again."
                if not open_accounts
                else f"Your Google account has {len(open_accounts)} open billing accounts; "
                "link the one you want to this project in the Google console, then "
                "press Continue again."
            ),
            status_code=409,
            code="NEEDS_BILLING",
        )

    account_name = str(open_accounts[0].get("name") or "")
    _check(
        session.put(
            f"{_BILLING_URL}/projects/{project_id}/billingInfo",
            headers={**headers, "Content-Type": "application/json"},
            json={"billingAccountName": account_name},
            timeout=30,
        ),
        "link your billing account",
    )
    logger.info("byoc_oauth.billing_linked project=%s", project_id)
    return {"billingLinked": True, "billingAccount": account_name}
