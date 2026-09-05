"""Fleet completion must distinguish an empty fleet from unavailable authority."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest


def module():
    path = Path(__file__).parents[1] / "scripts/ops/pod_fleet.py"
    spec = importlib.util.spec_from_file_location("pod_fleet_assertion", path)
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


@pytest.mark.parametrize("status,items,expected", [(200, [], 0), (200, [{}], 1), (403, [], 77)])
def test_fleet_assertion_uses_authoritative_result(monkeypatch, status, items, expected, capsys):
    fleet = module()
    monkeypatch.setattr(sys, "argv", ["fleet", "--assert-empty"])
    monkeypatch.setattr(fleet, "load_operator_credentials", lambda: object())
    response = SimpleNamespace(
        ok=status == 200,
        status_code=status,
        text="sensitive-provider-body",
        json=lambda: {"items": items},
    )
    monkeypatch.setattr(fleet, "_session", lambda _: SimpleNamespace(get=lambda *a, **k: response))
    assert fleet.main() == expected
    assert "sensitive-provider-body" not in capsys.readouterr().out


def test_missing_authority_is_unavailable_without_provider_details(monkeypatch, capsys):
    fleet = module()
    monkeypatch.setattr(sys, "argv", ["fleet", "--assert-empty"])

    def unavailable():
        raise RuntimeError("sensitive-credential-detail")

    monkeypatch.setattr(fleet, "load_operator_credentials", unavailable)
    assert fleet.main() == 77
    assert "sensitive-credential-detail" not in capsys.readouterr().out
