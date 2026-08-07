"""The signing provider seam: which identity signs, and how it degrades.

The switch matters operationally. `local` signs as `pass.com.hushh.app.one`
from this project's own certificate; `service` delegates to `hushh-wallet-api`,
which signs as `pass.com.hushh.wallet`. Flipping one environment variable is
the whole rollback plan, so these tests pin that it really is one variable and
that an unset environment keeps the behaviour the deployment already had.
"""

from __future__ import annotations

import pytest

from hushh_mcp.runtime_settings import get_wallet_pass_settings
from hushh_mcp.services import wallet_pass_provider as provider
from hushh_mcp.services.apple_wallet_pass_service import WalletPassContent

PASS_SERIAL = "6f2f0e6a-6d5e-4b0a-9f0a-0d1c2b3a4e5f"  # noqa: S105 — fixture id, not a credential
PROVIDER_ENV = "WALLET_PASS_PROVIDER"
KEY_ENV = "WALLET_API_KEY"
URL_ENV = "WALLET_API_BASE_URL"


@pytest.fixture(autouse=True)
def _clear_settings_cache():
    """`get_wallet_pass_settings` may memoise; force a fresh read per case."""
    cache_clear = getattr(get_wallet_pass_settings, "cache_clear", None)
    if cache_clear:
        cache_clear()
    yield
    if cache_clear:
        cache_clear()


def _content() -> WalletPassContent:
    return WalletPassContent.from_card_payload(
        pass_serial=PASS_SERIAL,
        public_card_url="https://uat.one.hushh.ai/c/token",
        card_payload={"full_name": "Ada Lovelace"},
    )


# ---------------------------------------------------------------------------
# Which provider is active
# ---------------------------------------------------------------------------


def test_an_unset_environment_stays_local(monkeypatch) -> None:
    monkeypatch.delenv(PROVIDER_ENV, raising=False)
    assert provider.active_provider() == provider.LOCAL_PROVIDER


@pytest.mark.parametrize("raw", ["service", "SERVICE", " service "])
def test_service_is_selected_case_and_space_insensitively(monkeypatch, raw) -> None:
    monkeypatch.setenv(PROVIDER_ENV, raw)
    assert provider.active_provider() == provider.SERVICE_PROVIDER


@pytest.mark.parametrize("raw", ["local", "", "nonsense", "remote"])
def test_anything_unrecognised_falls_back_to_local(monkeypatch, raw) -> None:
    """A typo must not silently disable pass signing, and must never pick the
    provider with different certificate custody."""
    monkeypatch.setenv(PROVIDER_ENV, raw)
    assert provider.active_provider() == provider.LOCAL_PROVIDER


# ---------------------------------------------------------------------------
# Readiness
# ---------------------------------------------------------------------------


def test_service_provider_needs_a_key_before_it_reports_ready(monkeypatch) -> None:
    monkeypatch.setenv(PROVIDER_ENV, "service")
    monkeypatch.setenv(URL_ENV, "https://wallet.example.invalid")
    monkeypatch.delenv(KEY_ENV, raising=False)

    assert provider.signing_available() is False


def test_service_provider_is_ready_with_url_and_key(monkeypatch) -> None:
    monkeypatch.setenv(PROVIDER_ENV, "service")
    monkeypatch.setenv(URL_ENV, "https://wallet.example.invalid")
    monkeypatch.setenv(KEY_ENV, "test-key-not-a-real-secret")

    assert provider.signing_available() is True


def test_service_readiness_never_consults_the_local_certificate(monkeypatch) -> None:
    """A deployment using the service must not need PEMs provisioned at all."""
    monkeypatch.setenv(PROVIDER_ENV, "service")
    monkeypatch.setenv(URL_ENV, "https://wallet.example.invalid")
    monkeypatch.setenv(KEY_ENV, "test-key-not-a-real-secret")
    monkeypatch.setattr(
        provider,
        "_local_signing_available",
        lambda: (_ for _ in ()).throw(AssertionError("local path must not be consulted")),
    )

    assert provider.signing_available() is True


# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------


def test_service_provider_delegates_to_the_api_client(monkeypatch) -> None:
    monkeypatch.setenv(PROVIDER_ENV, "service")
    monkeypatch.setenv(URL_ENV, "https://wallet.example.invalid")
    monkeypatch.setenv(KEY_ENV, "test-key-not-a-real-secret")
    seen: dict[str, object] = {}

    def fake_sign(content, *, base_url, api_key):
        seen["base_url"] = base_url
        seen["api_key"] = api_key
        return b"PK\x03\x04service"

    monkeypatch.setattr(provider.hushh_wallet_api_client, "sign_pass", fake_sign)
    monkeypatch.setattr(
        provider,
        "build_pkpass",
        lambda *a, **kw: (_ for _ in ()).throw(AssertionError("local signer must not run")),
    )

    assert provider.build_wallet_pass(_content()) == b"PK\x03\x04service"
    assert seen["base_url"] == "https://wallet.example.invalid"
    assert seen["api_key"] == "test-key-not-a-real-secret"


def test_local_provider_signs_in_process(monkeypatch) -> None:
    monkeypatch.setenv(PROVIDER_ENV, "local")
    monkeypatch.setattr(provider, "build_pkpass", lambda *a, **kw: b"PK\x03\x04local")
    monkeypatch.setattr(
        provider.hushh_wallet_api_client,
        "sign_pass",
        lambda *a, **kw: (_ for _ in ()).throw(AssertionError("service must not be called")),
    )

    assert provider.build_wallet_pass(_content()) == b"PK\x03\x04local"


def test_the_service_card_drops_an_avatar_rather_than_sending_it(monkeypatch) -> None:
    """The gold card has no thumbnail slot, so an avatar has nowhere to land.

    Dropping it explicitly beats shipping bytes the service will ignore.
    """
    monkeypatch.setenv(PROVIDER_ENV, "service")
    monkeypatch.setenv(URL_ENV, "https://wallet.example.invalid")
    monkeypatch.setenv(KEY_ENV, "test-key-not-a-real-secret")
    captured: dict[str, object] = {}

    def fake_sign(content, *, base_url, api_key):
        captured["kwargs_seen"] = True
        return b"ok"

    monkeypatch.setattr(provider.hushh_wallet_api_client, "sign_pass", fake_sign)
    sentinel = object()

    assert provider.build_wallet_pass(_content(), avatar_image=sentinel) == b"ok"
    assert captured["kwargs_seen"] is True


def test_local_provider_still_receives_the_avatar(monkeypatch) -> None:
    monkeypatch.setenv(PROVIDER_ENV, "local")
    seen: dict[str, object] = {}

    def fake_build(content, *, avatar_image=None):
        seen["avatar"] = avatar_image
        return b"local"

    monkeypatch.setattr(provider, "build_pkpass", fake_build)
    sentinel = object()

    provider.build_wallet_pass(_content(), avatar_image=sentinel)
    assert seen["avatar"] is sentinel
