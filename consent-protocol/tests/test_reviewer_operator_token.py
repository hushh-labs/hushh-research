"""Operator-token authority is separate from the backend reviewer mint API."""

import pytest


def test_operator_reviewer_uses_real_uid_admission_and_preserves_lane_containment():
    import importlib.util
    from pathlib import Path
    from types import SimpleNamespace

    script = (
        Path(__file__).resolve().parents[2]
        / ".codex/skills/reviewer-app-testing/scripts/reviewer_operator_token.py"
    )
    spec = importlib.util.spec_from_file_location("reviewer_operator_token", script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    calls = []
    users = {uid: SimpleNamespace(uid=uid, disabled=False) for uid in ("primary", "counterpart")}
    user = users["primary"]
    sdk = SimpleNamespace(
        get_user=lambda uid, app: users[uid],
        create_custom_token=lambda uid, claims, app: (
            calls.append((uid, claims, app)) or b"synthetic-proof"
        ),
    )
    app = object()
    assert (
        module.mint_reviewer_token(sdk, app, "primary", {"primary", "counterpart"}, "uat")
        == b"synthetic-proof"
    )
    assert calls == [("primary", {"hushh_review_mint": "uat"}, app)]
    calls.clear()
    for requested, lane, disabled, actual_uid in (
        ("foreign", "uat", False, "foreign"),
        ("primary", "production", False, "primary"),
        ("primary", "uat", True, "primary"),
        ("primary", "uat", False, "foreign"),
    ):
        user.disabled, user.uid = disabled, actual_uid
        with pytest.raises(ValueError):
            module.mint_reviewer_token(sdk, app, requested, {"primary", "counterpart"}, lane)
    assert calls == []

    user.disabled, user.uid = False, "primary"
    users["counterpart"].disabled = True
    with pytest.raises(ValueError):
        module.mint_reviewer_token(sdk, app, "primary", {"primary", "counterpart"}, "uat")
    users.pop("counterpart")
    with pytest.raises(KeyError):
        module.mint_reviewer_token(sdk, app, "primary", {"primary", "counterpart"}, "uat")
    assert calls == []
