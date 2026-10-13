import importlib.util
import io
import re
import sys
from email.message import Message
from pathlib import Path

import pytest


MODULE_PATH = Path(__file__).parents[1] / "ops" / "verify_passkey_domain_associations.py"
WEB_APP = Path(__file__).parents[2] / "hushh-webapp" / "app"
SPEC = importlib.util.spec_from_file_location("verify_passkey_domain_associations", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def _aasa(*, paths: list[str]) -> dict:
    return {
        "applinks": {
            "details": [
                {
                    "appIDs": ["TEAM.com.hushh.app"],
                    "components": [{"/": path} for path in paths],
                }
            ]
        },
        "webcredentials": {"apps": ["TEAM.com.hushh.app"]},
    }


def _asset_links(*, relations: list[str]) -> list[dict]:
    return [
        {
            "relation": relations,
            "target": {
                "namespace": "android_app",
                "package_name": "com.hushh.app",
                "sha256_cert_fingerprints": ["AA:BB"],
            },
        }
    ]


def test_aasa_requires_all_declared_oauth_return_paths() -> None:
    with pytest.raises(RuntimeError, match="OAuth return paths"):
        MODULE._verify_aasa(
            _aasa(paths=[MODULE.UNIVERSAL_LINK_PATHS[0]]),
            "TEAM.com.hushh.app",
        )


def test_aasa_accepts_authorized_app_and_paths() -> None:
    MODULE._verify_aasa(
        _aasa(paths=list(MODULE.UNIVERSAL_LINK_PATHS)),
        "TEAM.com.hushh.app",
    )


def test_required_paths_match_served_aasa_without_retired_alpaca_returns() -> None:
    source = (WEB_APP / ".well-known/apple-app-site-association/route.ts").read_text()
    declared = source.split("OAUTH_LINK_PATHS = [", 1)[1].split("] as const;", 1)[0]
    served_paths = set(re.findall(r'"(/[^"]+)"', declared))
    assert set(MODULE.UNIVERSAL_LINK_PATHS) == served_paths
    assert not any("/alpaca/" in path for path in served_paths)


class _FetchResponse:
    status = 200

    def __init__(self) -> None:
        self.headers = Message()
        self.headers["Content-Type"] = "application/json"

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self) -> bytes:
        return b"{}"


class _SequenceOpener:
    def __init__(self, outcomes: list) -> None:
        self.outcomes = outcomes
        self.calls = 0

    def open(self, _request, *, timeout):
        assert timeout == 15
        outcome = self.outcomes[self.calls]
        self.calls += 1
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


@pytest.mark.parametrize(
    "error",
    [TimeoutError("read timed out"), MODULE.urllib.error.URLError("temporary network failure")],
)
def test_fetch_retries_transient_transport_failure(monkeypatch, error) -> None:
    opener = _SequenceOpener([error, _FetchResponse()])
    delays = []
    monkeypatch.setattr(MODULE.urllib.request, "build_opener", lambda *_: opener)
    monkeypatch.setattr(MODULE.time, "sleep", delays.append)

    response = MODULE._fetch("https://uat.example/.well-known/apple-app-site-association", 15)

    assert response.status == 200
    assert opener.calls == 2
    assert delays == [1]


def test_fetch_exhausted_timeout_is_bounded_and_reportable(monkeypatch) -> None:
    opener = _SequenceOpener([TimeoutError("read timed out")] * 3)
    delays = []
    monkeypatch.setattr(MODULE.urllib.request, "build_opener", lambda *_: opener)
    monkeypatch.setattr(MODULE.time, "sleep", delays.append)

    with pytest.raises(RuntimeError, match="after 3 attempts: read timed out"):
        MODULE._fetch("https://uat.example/.well-known/apple-app-site-association", 15)

    assert opener.calls == 3
    assert delays == [1, 2]


def test_fetch_does_not_retry_http_failure(monkeypatch) -> None:
    headers = Message()
    headers["Content-Type"] = "application/json"
    error = MODULE.urllib.error.HTTPError(
        "https://uat.example", 503, "Unavailable", headers, io.BytesIO(b"{}")
    )
    opener = _SequenceOpener([error])
    monkeypatch.setattr(MODULE.urllib.request, "build_opener", lambda *_: opener)
    monkeypatch.setattr(
        MODULE.time, "sleep", lambda _: pytest.fail("HTTP failure must not be retried")
    )

    response = MODULE._fetch("https://uat.example/.well-known/apple-app-site-association", 15)

    assert opener.calls == 1
    with pytest.raises(RuntimeError, match="HTTP 503"):
        MODULE._json(response, "UAT AASA")


def test_asset_links_requires_web_app_link_relation() -> None:
    with pytest.raises(RuntimeError, match="Digital Asset Links"):
        MODULE._verify_asset_links(
            _asset_links(relations=["delegate_permission/common.get_login_creds"]),
            expected_package="com.hushh.app",
            expected_fingerprints={"AA:BB"},
        )


def test_asset_links_accepts_credentials_and_web_app_link_relations() -> None:
    MODULE._verify_asset_links(
        _asset_links(
            relations=[
                "delegate_permission/common.get_login_creds",
                "delegate_permission/common.handle_all_urls",
            ]
        ),
        expected_package="com.hushh.app",
        expected_fingerprints={"AA:BB"},
    )


def test_shared_rp_accepts_credentials_without_app_links() -> None:
    MODULE._verify_aasa(
        {"webcredentials": {"apps": ["TEAM.com.hushh.app"]}},
        "TEAM.com.hushh.app", require_app_links=False,
    )
    MODULE._verify_asset_links(
        _asset_links(relations=["delegate_permission/common.get_login_creds"]),
        expected_package="com.hushh.app", expected_fingerprints={"AA:BB"},
        require_app_links=False,
    )


@pytest.mark.parametrize("apps", [[], ["OTHER.com.hushh.app"]])
def test_shared_rp_rejects_unauthorized_ios_app(apps: list[str]) -> None:
    with pytest.raises(RuntimeError, match="webcredentials"):
        MODULE._verify_aasa(
            {"webcredentials": {"apps": apps}}, "TEAM.com.hushh.app",
            require_app_links=False,
        )


@pytest.mark.parametrize("defect", ["relation", "package", "fingerprint"])
def test_shared_rp_rejects_unauthorized_android_app(defect: str) -> None:
    payload = _asset_links(relations=["delegate_permission/common.get_login_creds"])
    if defect == "relation":
        payload[0]["relation"] = ["delegate_permission/common.handle_all_urls"]
    elif defect == "package":
        payload[0]["target"]["package_name"] = "other.app"
    else:
        payload[0]["target"]["sha256_cert_fingerprints"] = ["CC:DD"]
    with pytest.raises(RuntimeError, match="Digital Asset Links"):
        MODULE._verify_asset_links(
            payload, expected_package="com.hushh.app", expected_fingerprints={"AA:BB"},
            require_app_links=False,
        )
