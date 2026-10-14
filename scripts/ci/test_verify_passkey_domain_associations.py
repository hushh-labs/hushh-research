import importlib.util
import re
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


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


class VerifyPasskeyDomainAssociationsTests(unittest.TestCase):
    def test_public_association_fetch_retries_a_read_timeout(self) -> None:
        attempts = 0
        sleeps: list[int] = []

        def fetch_once(_url: str, _timeout: int) -> MODULE._HttpResponse:
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise TimeoutError("The read operation timed out")
            return MODULE._HttpResponse(200, "application/json", b"{}")

        with (
            patch.object(MODULE, "_fetch_once", side_effect=fetch_once),
            patch.object(MODULE.time, "sleep", side_effect=sleeps.append),
        ):
            self.assertEqual(
                MODULE._fetch("https://example.com/.well-known/assetlinks.json", 15).status,
                200,
            )
        self.assertEqual(attempts, 2)
        self.assertEqual(sleeps, [1])

    def test_public_association_fetch_still_fails_after_bounded_timeouts(self) -> None:
        attempts = 0

        def fetch_once(_url: str, _timeout: int) -> MODULE._HttpResponse:
            nonlocal attempts
            attempts += 1
            raise TimeoutError("The read operation timed out")

        with (
            patch.object(MODULE, "_fetch_once", side_effect=fetch_once),
            patch.object(MODULE.time, "sleep"),
        ):
            with self.assertRaisesRegex(RuntimeError, "after 3 attempts"):
                MODULE._fetch("https://example.com/.well-known/assetlinks.json", 15)
        self.assertEqual(attempts, 3)

    def test_aasa_requires_all_declared_oauth_return_paths(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "OAuth return paths"):
            MODULE._verify_aasa(
                _aasa(paths=[MODULE.UNIVERSAL_LINK_PATHS[0]]),
                "TEAM.com.hushh.app",
            )

    def test_aasa_accepts_authorized_app_and_paths(self) -> None:
        MODULE._verify_aasa(
            _aasa(paths=list(MODULE.UNIVERSAL_LINK_PATHS)),
            "TEAM.com.hushh.app",
        )

    def test_required_paths_match_served_oauth_aasa_without_retired_alpaca_returns(self) -> None:
        source = (WEB_APP / ".well-known/apple-app-site-association/route.ts").read_text()
        declared = source.split("OAUTH_LINK_PATHS = [", 1)[1].split("] as const;", 1)[0]
        served_paths = set(re.findall(r'"(/[^"]+)"', declared))
        self.assertSetEqual(set(MODULE.UNIVERSAL_LINK_PATHS), served_paths)
        self.assertFalse(any("/alpaca/" in path for path in served_paths))

    def test_asset_links_requires_web_app_link_relation(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "Digital Asset Links"):
            MODULE._verify_asset_links(
                _asset_links(relations=["delegate_permission/common.get_login_creds"]),
                expected_package="com.hushh.app",
                expected_fingerprints={"AA:BB"},
            )

    def test_asset_links_accepts_credentials_and_web_app_link_relations(self) -> None:
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

    def test_shared_rp_accepts_credentials_without_app_links(self) -> None:
        MODULE._verify_aasa(
            {"webcredentials": {"apps": ["TEAM.com.hushh.app"]}},
            "TEAM.com.hushh.app", require_app_links=False,
        )
        MODULE._verify_asset_links(
            _asset_links(relations=["delegate_permission/common.get_login_creds"]),
            expected_package="com.hushh.app", expected_fingerprints={"AA:BB"},
            require_app_links=False,
        )

    def test_shared_rp_rejects_unauthorized_ios_app(self) -> None:
        for apps in ([], ["OTHER.com.hushh.app"]):
            with self.subTest(apps=apps):
                with self.assertRaisesRegex(RuntimeError, "webcredentials"):
                    MODULE._verify_aasa(
                        {"webcredentials": {"apps": apps}}, "TEAM.com.hushh.app",
                        require_app_links=False,
                    )

    def test_shared_rp_rejects_unauthorized_android_app(self) -> None:
        for defect in ("relation", "package", "fingerprint"):
            with self.subTest(defect=defect):
                payload = _asset_links(relations=["delegate_permission/common.get_login_creds"])
                if defect == "relation":
                    payload[0]["relation"] = ["delegate_permission/common.handle_all_urls"]
                elif defect == "package":
                    payload[0]["target"]["package_name"] = "other.app"
                else:
                    payload[0]["target"]["sha256_cert_fingerprints"] = ["CC:DD"]
                with self.assertRaisesRegex(RuntimeError, "Digital Asset Links"):
                    MODULE._verify_asset_links(
                        payload, expected_package="com.hushh.app",
                        expected_fingerprints={"AA:BB"}, require_app_links=False,
                    )


if __name__ == "__main__":
    unittest.main()
