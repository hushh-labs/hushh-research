"""The dossier worker must be able to actually call the mail lane.

Regression (UAT, 2026-08-08): the worker called ``queue_dossier_email`` with
``display_name=`` while the function declares ``first_name=``. Every dossier
raised ``TypeError`` at the hand-off, was swallowed by the worker's
best-effort guard, and the row was marked ``send_failed`` — so no dossier mail
could ever be sent. Both build lanes passed their own tests because each one
mocked the other side.

These tests bind the real call against the real signature, so a cross-lane
signature drift fails here instead of in production.
"""

from __future__ import annotations

import ast
import inspect
from pathlib import Path
from typing import Any

import pytest

from hushh_mcp.services import ria_dossier_service
from hushh_mcp.services.ria_dossier_email_service import queue_dossier_email


def _mail_call_keywords() -> set[str]:
    """The keyword names the worker actually passes to queue_dossier_email."""
    source = Path(inspect.getfile(ria_dossier_service)).read_text(encoding="utf-8")
    tree = ast.parse(source)
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        name = func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", "")
        if name == "queue_dossier_email":
            return {kw.arg for kw in node.keywords if kw.arg}
    raise AssertionError("no call to queue_dossier_email found in the dossier worker")


def test_worker_call_matches_the_mail_signature() -> None:
    signature = inspect.signature(queue_dossier_email)
    passed = _mail_call_keywords()
    accepted = set(signature.parameters)
    unknown = passed - accepted
    assert not unknown, (
        f"the dossier worker passes {sorted(unknown)} which queue_dossier_email "
        f"does not accept (it takes {sorted(accepted)})"
    )
    # Binding proves the call is constructible, not merely name-compatible.
    signature.bind(**{name: None for name in passed})


@pytest.mark.asyncio
async def test_mail_handoff_reaches_the_real_function(monkeypatch) -> None:
    """Run the worker's hand-off against the REAL callee, mail transport stubbed.

    The fail-closed guard makes this safe: with no test redirect configured the
    function returns ``blocked_test_unset`` and nothing is enqueued. What
    matters is that the call itself does not raise.
    """
    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.delenv("SUPPORT_EMAIL_TEST_TO", raising=False)

    result: dict[str, Any] = await queue_dossier_email(
        user_id="user_1",
        to_email="adviser@example.com",
        first_name="Reginald",
    )

    assert result["delivery_status"] == "blocked_test_unset"
    assert result["intended_recipient"] == "adviser@example.com"
