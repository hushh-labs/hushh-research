import importlib.util
import sys
from pathlib import Path

import pytest


MODULE_PATH = Path(__file__).parents[1] / "ops" / "verify_passkey_domain_associations.py"
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
