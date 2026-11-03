"""Explicit funding for an admitted managed project; no account discovery."""

from __future__ import annotations

import re
from typing import Any


def observe_provider_account_transition_billing(
    *,
    project_id: str,
    old_account: str,
    target_account: str,
    token: str,
    session: Any,
) -> dict[str, Any]:
    """Read the open target account and native project billing state for C2."""
    from hushh_mcp.services.provision_attempt import ProvisionReconciliationRequired
    from hushh_mcp.services.user_gcp_project import validate_project_id

    account_re = r"billingAccounts/[A-Z0-9]{6}-[A-Z0-9]{6}-[A-Z0-9]{6}"
    if (
        not validate_project_id(project_id).valid
        or not re.fullmatch(account_re, old_account)
        or not re.fullmatch(account_re, target_account)
        or old_account == target_account
        or not isinstance(token, str)
        or not token
    ):
        raise ProvisionReconciliationRequired("Provider account transition authority is invalid")
    headers = {"Authorization": "Bearer " + token}
    base = "https://cloudbilling.googleapis.com/v1"
    account_response = session.get(
        f"{base}/{target_account}",
        headers=headers,
        timeout=20,
        allow_redirects=False,
    )
    if account_response.status_code != 200:
        raise ProvisionReconciliationRequired("Target billing account status is unverified")
    account = account_response.json()
    if (
        not isinstance(account, dict)
        or account.get("name") != target_account
        or account.get("open") is not True
    ):
        raise ProvisionReconciliationRequired("Target billing account is not open")

    billing_response = session.get(
        f"{base}/projects/{project_id}/billingInfo",
        headers=headers,
        timeout=20,
        allow_redirects=False,
    )
    if billing_response.status_code != 200:
        raise ProvisionReconciliationRequired("Project billing readback is unverified")
    billing = billing_response.json()
    if (
        not isinstance(billing, dict)
        or billing.get("projectId") != project_id
        or not isinstance(billing.get("billingAccountName", ""), str)
        or type(billing.get("billingEnabled")) is not bool
    ):
        raise ProvisionReconciliationRequired("Project billing readback is malformed")
    return {
        "projectId": project_id,
        "billingAccountName": billing.get("billingAccountName", ""),
        "billingEnabled": billing["billingEnabled"],
    }


def link_provider_account_transition_once(
    *, project_id: str, target_account: str, token: str, session: Any
) -> None:
    """Issue exactly one C2 billing PUT; callers must journal before calling."""
    from hushh_mcp.services.provision_attempt import ProvisionReconciliationRequired
    from hushh_mcp.services.user_gcp_project import validate_project_id

    if (
        not validate_project_id(project_id).valid
        or not re.fullmatch(r"billingAccounts/[A-Z0-9]{6}-[A-Z0-9]{6}-[A-Z0-9]{6}", target_account)
        or not isinstance(token, str)
        or not token
    ):
        raise ProvisionReconciliationRequired("Provider account transition authority is invalid")
    response = session.put(
        f"https://cloudbilling.googleapis.com/v1/projects/{project_id}/billingInfo",
        headers={"Authorization": "Bearer " + token},
        json={"billingAccountName": target_account},
        timeout=60,
        allow_redirects=False,
    )
    if response.status_code != 200:
        raise ProvisionReconciliationRequired("Provider billing update requires reconciliation")


def ensure_explicit_billing(
    *,
    project_id: str,
    expected_account: str,
    token: str,
    session: Any,
) -> dict[str, Any]:
    from hushh_mcp.services.byoc_oauth_authorizer import ByocAuthorizeError, _check
    from hushh_mcp.services.user_gcp_project import validate_project_id

    if not validate_project_id(project_id).valid or not re.fullmatch(
        r"billingAccounts/[A-Z0-9]{6}-[A-Z0-9]{6}-[A-Z0-9]{6}", expected_account
    ):
        raise ValueError("Managed project funding authority is invalid")
    headers = {"Authorization": f"Bearer {token}"}
    base = "https://cloudbilling.googleapis.com/v1"
    account = _check(
        session.get(f"{base}/{expected_account}", headers=headers, timeout=30),
        "verify the admitted billing account",
    )
    if account.get("name") != expected_account or account.get("open") is not True:
        raise ByocAuthorizeError(
            "The admitted billing account is unavailable", status_code=409, code="NEEDS_BILLING"
        )
    url = f"{base}/projects/{project_id}/billingInfo"
    before = _check(session.get(url, headers=headers, timeout=30), "read admitted project funding")
    if before.get("billingAccountName") not in {None, "", expected_account}:
        raise ByocAuthorizeError(
            "Project billing differs from the admitted account",
            status_code=409,
            code="BILLING_AUTHORITY_MISMATCH",
        )
    linked = before.get("billingEnabled") is not True
    if linked:
        _check(
            session.put(
                url, headers=headers, json={"billingAccountName": expected_account}, timeout=60
            ),
            "link the admitted billing account",
        )
    observed = _check(session.get(url, headers=headers, timeout=30), "verify project billing")
    if (
        observed.get("billingAccountName") != expected_account
        or observed.get("billingEnabled") is not True
    ):
        raise ByocAuthorizeError(
            "Admitted project billing could not be verified",
            status_code=502,
            code="BILLING_READBACK_UNVERIFIED",
        )
    return {
        "billingLinked": linked,
        "billingAccount": expected_account,
        "observation": {
            "projectId": project_id,
            "billingAccountName": expected_account,
            "billingEnabled": True,
        },
    }


def ensure_project_billing(
    *,
    project_id: str,
    token: str,
    session: Any = None,
    expected_account: str | None = None,
) -> dict[str, Any]:
    from hushh_mcp.services.byoc_oauth_authorizer import (
        _BILLING_URL,
        ByocAuthorizeError,
        _check,
        logger,
    )

    if session is None:
        import requests as session  # noqa: PLC0415

    if expected_account is not None:
        return ensure_explicit_billing(
            project_id=project_id, expected_account=expected_account, token=token, session=session
        )

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
    link = session.put(
        f"{_BILLING_URL}/projects/{project_id}/billingInfo",
        headers={**headers, "Content-Type": "application/json"},
        json={"billingAccountName": account_name},
        timeout=30,
    )
    if link.status_code != 200:
        _raise_billing_link_failure(link, project_id, account_name)
    logger.info("byoc_oauth.billing_linked project=%s", project_id)
    return {"billingLinked": True, "billingAccount": account_name}


def _raise_billing_link_failure(link: Any, project_id: str, account_name: str) -> None:
    from hushh_mcp.services.byoc_oauth_authorizer import (
        ByocAuthorizeError,
        _google_error_detail,
        logger,
    )

    detail = _google_error_detail(link)
    logger.warning(
        "byoc_oauth.billing_link_refused project=%s account=%s http=%s detail=%r",
        project_id,
        account_name,
        link.status_code,
        detail,
    )
    if "quota" in detail.lower():
        # Consumer billing accounts back a small fixed number of projects
        # (five, typically). Google reports the refusal as a bare
        # FAILED_PRECONDITION, which shipped to a person as "HTTP 400"
        # naming nothing (founder-hit, 2026-08-21, hussh-one-df5jxz as the
        # sixth project on a five-project account). This is the person's
        # decision to make, so it is a typed NEEDS_BILLING refusal that
        # names both moves, not a server error.
        account_id = account_name.removeprefix("billingAccounts/")
        raise ByocAuthorizeError(
            f"Your billing account ({account_id}) already backs its maximum "
            f"number of Google Cloud projects, so Google refused to add "
            f"{project_id}. Unlink a project you no longer use at "
            "console.cloud.google.com/billing, or change the name above to a "
            "project of yours that already has billing and press Continue.",
            status_code=409,
            code="NEEDS_BILLING",
        )
    raise ByocAuthorizeError(
        f"Google refused while trying to link your billing account "
        f"(HTTP {link.status_code})" + (f". Google said: {detail}" if detail else ""),
        status_code=502,
        code="AUTHORIZE_FAILED",
    )
