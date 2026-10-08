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


def http_pages(monkeypatch, pages):
    import requests

    from hushh_mcp.services import gcp_run_client

    monkeypatch.setattr(gcp_run_client, "load_operator_credentials", lambda: object())
    monkeypatch.setattr(gcp_run_client.GcpRunClient, "_headers", lambda _: {})
    calls = []
    responses = iter(pages)

    def get(url, **kwargs):
        calls.append(kwargs)
        assert kwargs["allow_redirects"] is False
        assert kwargs["params"]["labelSelector"] == "app=hussh-one-pod"
        status, body = next(responses)

        def raise_for_status():
            if status >= 400:
                raise requests.HTTPError("sensitive-provider-body")

        return SimpleNamespace(
            status_code=status, json=lambda: body, raise_for_status=raise_for_status
        )

    monkeypatch.setattr(requests, "get", get)
    return calls


@pytest.mark.parametrize(
    "status,items,expected",
    [(200, [], 0), (200, [{"metadata": {"name": "synthetic-pod"}}], 1), (403, [], 77)],
)
def test_fleet_assertion_uses_authoritative_result(monkeypatch, status, items, expected, capsys):
    fleet = module()
    monkeypatch.setattr(sys, "argv", ["fleet", "--assert-empty"])
    http_pages(monkeypatch, [(status, {"items": items})])
    assert fleet.main() == expected
    assert "sensitive-provider-body" not in capsys.readouterr().out


def test_missing_authority_is_unavailable_without_provider_details(monkeypatch, capsys):
    from hushh_mcp.services import gcp_run_client

    fleet = module()
    monkeypatch.setattr(sys, "argv", ["fleet", "--assert-empty"])

    def unavailable():
        raise RuntimeError("sensitive-credential-detail")

    monkeypatch.setattr(gcp_run_client, "load_operator_credentials", unavailable)
    assert fleet.main() == 77
    assert "sensitive-credential-detail" not in capsys.readouterr().out


@pytest.mark.parametrize(
    "second,expected",
    [
        ((200, {"items": [{"metadata": {"name": "synthetic-pod"}}]}), 1),
        ((200, {"items": []}), 0),
        ((403, {}), 77),
        ((200, {"metadata": {"continue": "next"}, "items": []}), 77),
    ],
)
def test_assert_empty_reads_complete_inventory(monkeypatch, second, expected):
    fleet = module()
    monkeypatch.setattr(sys, "argv", ["fleet", "--assert-empty"])
    calls = http_pages(
        monkeypatch, [(200, {"items": [], "metadata": {"continue": "next"}}), second]
    )
    assert fleet.main() == expected
    assert len(calls) == 2
    assert calls[1]["params"]["continue"] == "next"


@pytest.mark.parametrize(
    "status,body",
    [
        (200, {"items": None}),
        (200, {"items": {}}),
        (200, {"items": [{}]}),
        (200, {"error": {"message": "sensitive-provider-body"}}),
        (200, {"unreachable": ["location"]}),
        (302, {}),
        (204, {}),
    ],
)
def test_assert_empty_never_accepts_incomplete_provider_evidence(monkeypatch, status, body, capsys):
    fleet = module()
    monkeypatch.setattr(sys, "argv", ["fleet", "--assert-empty"])
    http_pages(monkeypatch, [(status, body)])
    assert fleet.main() == 77
    assert "sensitive-provider-body" not in capsys.readouterr().out


def test_existing_json_presentation_remains_available(monkeypatch, capsys):
    import json

    fleet = module()
    monkeypatch.setattr(sys, "argv", ["fleet", "--json"])
    http_pages(monkeypatch, [(200, {"items": [{"metadata": {"name": "synthetic-pod"}}]})])
    assert fleet.main() == 0
    assert json.loads(capsys.readouterr().out)[0]["service"] == "synthetic-pod"
