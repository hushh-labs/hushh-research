"""Azure's settling refusals are waited out; a subscription limit is named plainly.

Measured on the first live Connect Azure (2026-10-04): the key creation was refused
with ``VaultRegisteringDns`` seconds after its vault was created, and the setup
failed on it; the retry then hit a free trial's one-environment limit
(``MaxNumberOfGlobalEnvironmentsInSubExceeded``) and told the person only "Azure
refused a setup step".
"""

from __future__ import annotations

from typing import Any

import pytest

from hushh_mcp.services.azure_arm_client import ArmClient, ArmError
from hushh_mcp.services.azure_subscription_limits import environment_limit_refusal

SUB = "22222222-2222-2222-2222-222222222222"


class _Raw:
    def __init__(self, status: int, body: dict[str, Any]) -> None:
        self.status_code = status
        self.headers: dict[str, str] = {}
        self._body = body
        self.content = b"x"

    def json(self) -> dict[str, Any]:
        return self._body


class _Session:
    def __init__(self, *responses: _Raw) -> None:
        self._responses = list(responses)
        self.calls = 0

    def request(self, method: str, url: str, **_: Any) -> _Raw:
        self.calls += 1
        return self._responses.pop(0)


def _refusal(status: int, code: str) -> _Raw:
    return _Raw(status, {"error": {"code": code, "message": f"{code} happened"}})


def _client(session: _Session, slept: list[float]) -> ArmClient:
    return ArmClient("token", session=session, sleep=slept.append)


def test_a_settling_vault_is_waited_out_not_failed() -> None:
    session = _Session(
        _refusal(400, "VaultRegisteringDns"),
        _refusal(400, "VaultRegisteringDns"),
        _Raw(200, {"id": "key"}),
    )
    slept: list[float] = []
    assert _client(session, slept).get("/subscriptions/x/k", api_version="7") == {"id": "key"}
    assert session.calls == 3 and len(slept) == 2


def test_settling_is_bounded_and_then_refuses() -> None:
    session = _Session(*[_refusal(400, "VaultRegisteringDns")] * 4)
    client = ArmClient("token", session=session, sleep=lambda _: None, transient_retries=3)
    with pytest.raises(ArmError) as exc:
        client.get("/subscriptions/x/k", api_version="7")
    assert exc.value.code == "VaultRegisteringDns" and session.calls == 4


def test_an_ordinary_bad_request_is_not_retried_negative_control() -> None:
    session = _Session(_refusal(400, "InvalidParameter"))
    slept: list[float] = []
    with pytest.raises(ArmError):
        _client(session, slept).get("/subscriptions/x/k", api_version="7")
    assert session.calls == 1 and slept == []


class _Arm:
    def __init__(self, listed: Any) -> None:
        self.listed = listed
        self.paths: list[str] = []

    def get(self, path: str, *, api_version: str, op: str = "") -> dict[str, Any]:
        self.paths.append(path)
        if isinstance(self.listed, Exception):
            raise self.listed
        return {"value": self.listed}


def _env_limit() -> ArmError:
    return ArmError(
        "conflict",
        status=409,
        code="MaxNumberOfGlobalEnvironmentsInSubExceeded",
        message="limit",
        op="creating_environment",
    )


def test_the_environment_limit_names_what_fills_the_slot() -> None:
    arm = _Arm(
        [
            {
                "name": "hussh-spike-env",
                "id": f"/subscriptions/{SUB}/resourceGroups/rg-hussh-spike/providers/Microsoft.App/managedEnvironments/hussh-spike-env",
            }
        ]
    )
    refusal = environment_limit_refusal(_env_limit(), arm, SUB)  # type: ignore[arg-type]
    assert refusal is not None and refusal.code == "AZURE_ENVIRONMENT_LIMIT"
    assert "hussh-spike-env (rg-hussh-spike)" in str(refusal)
    assert "free trial allows one" in str(refusal) and "Nothing was removed" in str(refusal)
    assert arm.paths == [f"/subscriptions/{SUB}/providers/Microsoft.App/managedEnvironments"]


def test_an_unreadable_listing_still_explains_the_limit() -> None:
    arm = _Arm(ArmError("forbidden", status=403, code="AuthorizationFailed", message="", op="x"))
    refusal = environment_limit_refusal(_env_limit(), arm, SUB)  # type: ignore[arg-type]
    assert refusal is not None and "In use" not in str(refusal)


def test_any_other_refusal_is_left_alone_negative_control() -> None:
    other = ArmError("bad_request", status=400, code="InvalidParameter", message="", op="x")
    assert environment_limit_refusal(other, _Arm([]), SUB) is None  # type: ignore[arg-type]
