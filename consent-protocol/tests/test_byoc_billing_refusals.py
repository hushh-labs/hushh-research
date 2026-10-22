"""Billing refusals carry Google's reason, and the quota wall is a typed move.

The founder hit this live (2026-08-21): a fresh account accepted the suggested
name, the chain created `hussh-one-df5jxz`, and linking billing failed because
their consumer billing account already backed its maximum five projects. Google
answered `FAILED_PRECONDITION` with a QuotaFailure detail; the product showed
"Google refused while trying to link your billing account (HTTP 400)" and
logged nothing. These tests pin the repair on both sides: the log line and the
message carry Google's words, and the quota case is a typed NEEDS_BILLING
refusal naming the person's two moves.
"""

from __future__ import annotations

from copy import deepcopy

import pytest

from hushh_mcp.services import byoc_oauth_authorizer as oauth


@pytest.mark.parametrize(
    "invalid", [None, "etag", "bindings", "version", "readback", "identity", "retention"]
)
def test_authorization_preserves_conditional_grants_and_requires_policy_preconditions(invalid):
    from hushh_mcp.services.user_gcp_bootstrap import BOOTSTRAP_ROLES

    caller = "caller@synthetic-project.iam.gserviceaccount.com"
    bootstrap = "one-bootstrap@synthetic-project.iam.gserviceaccount.com"
    condition = {"title": "existing", "expression": "false"}
    conditional = {
        "role": BOOTSTRAP_ROLES[0][0],
        "members": [f"serviceAccount:{bootstrap}"],
        "condition": condition,
    }
    sa_conditional = {
        "role": "roles/iam.serviceAccountTokenCreator",
        "members": [f"serviceAccount:{caller}"],
        "condition": condition,
    }
    project_policy = {"version": 3, "etag": "project-before", "bindings": [conditional]}
    sa_policy = {"version": 3, "etag": "account-before", "bindings": [sa_conditional]}
    if invalid == "etag":
        project_policy.pop("etag")
    elif invalid == "bindings":
        project_policy["bindings"] = [None]
    elif invalid == "version":
        project_policy["version"] = 1

    class Session:
        def __init__(self):
            self.reads = []
            self.writes = []

        def post(self, url, **kwargs):
            if url.endswith(":getIamPolicy"):
                self.reads.append((url, kwargs))
                if "/serviceAccounts/" in url and len(self.writes) == 2 and invalid != "readback":
                    return _Response(200, {**deepcopy(self.writes[1]), "etag": "account-after"})
                return _Response(
                    200, deepcopy(sa_policy if "/serviceAccounts/" in url else project_policy)
                )
            if url.endswith(":setIamPolicy"):
                self.writes.append(deepcopy(kwargs["json"]["policy"]))
            return _Response(200, {"done": True})

        def get(self, url, **kwargs):
            if url.endswith("/keys"):
                return _Response(200, {})
            return _Response(
                200,
                {
                    "name": f"projects/synthetic-project/serviceAccounts/{bootstrap}",
                    "projectId": "synthetic-project",
                    "email": bootstrap,
                    "uniqueId": "invalid" if invalid == "identity" else "123456789012345678901",
                    "private": "must-not-retain",
                },
            )

    session = Session()
    arguments = {
        "project": "synthetic-project",
        "token": "synthetic",
        "caller_sa": caller,
        "session": session,
    }
    if invalid in {"etag", "bindings", "version"}:
        with pytest.raises(oauth.ByocAuthorizeError, match="safely verified"):
            oauth.apply_authorization(**arguments)
        assert not session.writes
        return
    receipts = []

    def retain(receipt):
        receipts.append(receipt)
        return True

    if invalid == "retention":
        with pytest.raises(oauth.ByocAuthorizeError, match="could not be retained"):
            oauth.apply_authorization(**arguments, on_authorized=lambda receipt: False)
        return
    if invalid:
        with pytest.raises(oauth.ByocAuthorizeError, match="could not be verified"):
            oauth.apply_authorization(**arguments, on_authorized=retain)
        assert not receipts
        return
    result = oauth.apply_authorization(**arguments, on_authorized=retain)
    assert receipts == [result["authorizationReceipt"]]
    assert receipts[0]["bindingObservation"]["member"] == f"serviceAccount:{caller}"
    assert receipts[0]["bindingObservation"]["disposition"] == "added"
    assert receipts[0]["bindingObservation"]["afterEtag"] == "account-after"
    assert "private" not in receipts[0]["bootstrapIdentity"]
    assert session.reads[0][1]["json"] == {"options": {"requestedPolicyVersion": 3}}
    assert session.reads[1][1]["params"] == {"options.requestedPolicyVersion": 3}
    assert session.writes[0]["etag"] == "project-before"
    assert session.writes[0]["bindings"][0] == conditional
    assert session.writes[1]["etag"] == "account-before"
    assert session.writes[1]["bindings"] == [
        sa_conditional,
        {"role": "roles/iam.serviceAccountTokenCreator", "members": [f"serviceAccount:{caller}"]},
    ]
    unconditional = [
        binding for binding in session.writes[0]["bindings"] if "condition" not in binding
    ]
    assert {binding["role"] for binding in unconditional} == {role for role, _ in BOOTSTRAP_ROLES}


# The exact body Google returned for the founder's sixth project, captured live.
_QUOTA_BODY = {
    "error": {
        "code": 400,
        "message": "Precondition check failed.",
        "status": "FAILED_PRECONDITION",
        "details": [
            {
                "@type": "type.googleapis.com/google.rpc.QuotaFailure",
                "violations": [
                    {
                        "subject": "billingAccounts/01AAAA-BBBBBB-CCCCCC",
                        "description": (
                            "Cloud billing quota exceeded: "
                            "https://support.google.com/code/contact/billing_quota_increase"
                        ),
                    }
                ],
            }
        ],
    }
}


class _Response:
    def __init__(self, status_code: int, body: dict | None = None):
        self.status_code = status_code
        self._body = body or {}
        self.content = b"x" if body is not None else b""

    def json(self) -> dict:
        return self._body


class _Session:
    """Answers GET/PUT from queues, so a test scripts the whole exchange."""

    def __init__(self, *, gets: list[_Response], puts: list[_Response]):
        self._gets = list(gets)
        self._puts = list(puts)
        self.put_calls: list[str] = []

    def get(self, url: str, **_kwargs) -> _Response:
        return self._gets.pop(0)

    def put(self, url: str, **_kwargs) -> _Response:
        self.put_calls.append(url)
        return self._puts.pop(0)


_UNBILLED = _Response(200, {"billingEnabled": False})
_ONE_OPEN_ACCOUNT = _Response(
    200,
    {"billingAccounts": [{"name": "billingAccounts/01AAAA-BBBBBB-CCCCCC", "open": True}]},
)


def test_google_error_detail_reads_status_message_and_violations():
    detail = oauth._google_error_detail(_Response(400, _QUOTA_BODY))
    assert "FAILED_PRECONDITION" in detail
    assert "Precondition check failed." in detail
    assert "Cloud billing quota exceeded" in detail


def test_the_billing_quota_wall_is_a_typed_refusal_naming_both_moves():
    session = _Session(
        gets=[_UNBILLED, _ONE_OPEN_ACCOUNT],
        puts=[_Response(400, _QUOTA_BODY)],
    )

    with pytest.raises(oauth.ByocAuthorizeError) as caught:
        oauth.ensure_billing(project_id="hussh-one-sixth1", token="t", session=session)  # noqa: S106 - a fake bearer for a fake session

    err = caught.value
    assert err.code == "NEEDS_BILLING"
    assert err.status_code == 409
    message = str(err)
    # The person can act on it: it names their account, the refused project,
    # and both ways out.
    assert "01AAAA-BBBBBB-CCCCCC" in message
    assert "hussh-one-sixth1" in message
    assert "maximum" in message
    assert "Unlink" in message
    assert "already has billing" in message


def test_a_non_quota_refusal_carries_googles_words_in_the_message():
    body = {"error": {"status": "INVALID_ARGUMENT", "message": "Malformed billing account."}}
    session = _Session(
        gets=[_UNBILLED, _ONE_OPEN_ACCOUNT],
        puts=[_Response(400, body)],
    )

    with pytest.raises(oauth.ByocAuthorizeError) as caught:
        oauth.ensure_billing(project_id="hussh-one-x", token="t", session=session)  # noqa: S106 - a fake bearer for a fake session

    err = caught.value
    assert err.code == "AUTHORIZE_FAILED"
    assert "Google said: INVALID_ARGUMENT: Malformed billing account." in str(err)


def test_refusals_leave_a_log_line_naming_the_reason(caplog):
    session = _Session(
        gets=[_UNBILLED, _ONE_OPEN_ACCOUNT],
        puts=[_Response(400, _QUOTA_BODY)],
    )

    with caplog.at_level("WARNING"), pytest.raises(oauth.ByocAuthorizeError):
        oauth.ensure_billing(project_id="hussh-one-sixth1", token="t", session=session)  # noqa: S106 - a fake bearer for a fake session

    logged = " ".join(record.getMessage() for record in caplog.records)
    assert "byoc_oauth.billing_link_refused" in logged
    assert "Cloud billing quota exceeded" in logged


def test_an_already_billed_project_never_reaches_the_link_call():
    session = _Session(
        gets=[_Response(200, {"billingEnabled": True, "billingAccountName": "billingAccounts/A"})],
        puts=[],
    )

    result = oauth.ensure_billing(project_id="hussh-one-x", token="t", session=session)  # noqa: S106 - a fake bearer for a fake session

    assert result == {"billingLinked": False, "billingAccount": "billingAccounts/A"}
    assert session.put_calls == []


def test_an_api_disabled_403_is_our_fault_not_the_persons(caplog):
    """The client-project API gap never blames the person's permissions.

    Captured live 2026-08-21: the billing READ answered 403 with "Cloud Billing
    API has not been used in project <client-project> before or it is
    disabled", and the product told the founder they were not an owner of a
    project they owned.
    """
    body = {
        "error": {
            "code": 403,
            "status": "PERMISSION_DENIED",
            "message": (
                "Cloud Billing API has not been used in project 1006304528804 "
                "before or it is disabled."
            ),
        }
    }
    session = _Session(gets=[_Response(403, body)], puts=[])

    with caplog.at_level("WARNING"), pytest.raises(oauth.ByocAuthorizeError) as caught:
        oauth.ensure_billing(project_id="hussh-one-x", token="t", session=session)  # noqa: S106 - a fake bearer for a fake session

    err = caught.value
    assert err.code == "NOT_CONFIGURED"
    assert err.status_code == 503
    message = str(err)
    assert "on our" in message
    assert "owner" not in message
    logged = " ".join(record.getMessage() for record in caplog.records)
    assert "has not been used in project" in logged


def test_a_real_permission_403_still_names_ownership():
    body = {
        "error": {
            "code": 403,
            "status": "PERMISSION_DENIED",
            "message": "The caller does not have permission",
        }
    }
    session = _Session(gets=[_Response(403, body)], puts=[])

    with pytest.raises(oauth.ByocAuthorizeError) as caught:
        oauth.ensure_billing(project_id="hussh-one-x", token="t", session=session)  # noqa: S106 - a fake bearer for a fake session

    assert caught.value.code == "INSUFFICIENT_PERMISSION"
    assert "owner" in str(caught.value)


def test_an_enable_operation_that_completes_with_an_error_is_a_refusal(caplog):
    """`done` alone is not success: an LRO can complete WITH an error.

    Treating it as success let an enablement failure re-surface three calls
    later as a permission error naming none of this (audit finding,
    2026-08-21).
    """

    class _PostSession(_Session):
        def __init__(self):
            super().__init__(gets=[], puts=[])
            self.posts = 0

        def post(self, url, **_kwargs):
            self.posts += 1
            return _Response(
                200,
                {
                    "name": "operations/op-1",
                    "done": True,
                    "error": {"code": 9, "message": "Billing must be enabled first."},
                },
            )

    session = _PostSession()

    with caplog.at_level("WARNING"), pytest.raises(oauth.ByocAuthorizeError) as caught:
        oauth.apply_authorization(
            project="hussh-one-x",
            token="t",  # noqa: S106 - a fake bearer for a fake session
            caller_sa="caller@x.iam.gserviceaccount.com",
            session=session,
        )

    err = caught.value
    assert err.code == "AUTHORIZE_FAILED"
    assert "Billing must be enabled first." in str(err)
    assert "byoc_oauth.enable_operation_failed" in " ".join(
        record.getMessage() for record in caplog.records
    )
    # It refused at the enablement step: nothing after it ran.
    assert session.posts == 1
