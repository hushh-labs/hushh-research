"""Owned synthetic assets exercise the real feed adapter and catalog publisher.

Only external HTTP is substituted; these fixtures are not licensed bank coverage.
"""

import hashlib
import json
from datetime import datetime, timedelta, timezone
from io import BytesIO

import httpx
import pytest
from PIL import Image, PngImagePlugin

from hushh_mcp.services import wallet_artwork_providers as providers
from hushh_mcp.services.wallet_artwork_catalog import (
    load_catalog,
    read_asset,
    resolve_artwork,
    validate_artwork_selections,
)
from hushh_mcp.services.wallet_artwork_sync import synchronize_artwork


@pytest.fixture
def licensed_feed(tmp_path, monkeypatch):
    """Explicit test-only approval, server credential and owned blank artwork."""
    output = BytesIO()
    info = PngImagePlugin.PngInfo()
    info.add_text("test-only", "strip metadata")
    Image.new("RGB", (160, 101), "navy").save(output, format="PNG", pnginfo=info)
    image = output.getvalue()
    grant = providers.ProviderGrant(
        provider_id="owned-test-source",
        adapter="approved_feed_v1",
        manifest_url="https://api.artwork.example/approved/feed.json",
        asset_base_url="https://cdn.artwork.example/approved/",
        agreement_reference="owned-fixtures-only-no-production-license",
        blank_artwork_review_reference="test-generated-blank-pixels",
        approved_by="test-reviewer",
        approved_at="2000-01-01T00:00:00Z",
        rights_policy="perpetual_private_display",
        audience="all_authenticated_wallet_owners",
        metadata_stripping_allowed=True,
        countries=["US", "IN"],
        networks=["visa", "mastercard", "amex", "rupay", "discover", "diners", "jcb", "unionpay"],
    )
    policy = tmp_path / "policy.json"
    policy.write_text(
        providers.ProviderRegistry(
            schema_version="hushh.wallet.artwork.providers.v1", providers=[grant]
        ).model_dump_json()
    )
    monkeypatch.setenv("HUSHH_WALLET_ARTWORK_PROVIDERS_ENABLED", "true")
    monkeypatch.setenv("HUSHH_WALLET_ARTWORK_PROVIDERS_PATH", str(policy))
    monkeypatch.setenv(
        "WALLET_ARTWORK_PROVIDER_CREDENTIALS_JSON",
        json.dumps({grant.provider_id: "test-only-provider-credential"}),
    )
    target = tmp_path / "catalog.json"
    monkeypatch.setenv("HUSHH_WALLET_ARTWORK_CATALOG_PATH", str(target))
    now = datetime.now(timezone.utc)
    artwork = {
        "source_asset_id": "owned-gold-blue",
        "artwork_version": "2026-1",
        "issuer_id": "owned-issuer",
        "product_id": "gold",
        "variant_id": "blue",
        "issuer_name": "Synthetic Test Bank",
        "product_name": "Test Gold",
        "variant_name": "Test Blue",
        "family": "Test family",
        "country": "US",
        "network": "visa",
        "iin_prefixes": ["424242"],
        "source_digest": hashlib.sha256(image).hexdigest(),
        "mime": "image/png",
        "status": "approved",
        "issuer_approval_reference": "owned-test-fixture-review",
        "rights_policy": "perpetual_private_display",
        "blank_artwork": True,
    }
    metadata = {
        "issuer_id": "owned-issuer",
        "product_id": "gold",
        "variant_id": "blue",
        "artwork_version": "2026-1",
        "issuer_name": "Synthetic Test Bank",
        "country": "US",
        "product_family": "Test family",
        "product_verified": True,
        "variant_verified": True,
        "evidence_reference": "owned-fixture-authoritative-registry",
        "network": "visa",
        "iin_prefixes": ["424242"],
        "pan_lengths": [16],
    }
    feed = providers.ArtworkFeed(
        schema_version="hushh.wallet.artwork.feed.v1",
        provider_id=grant.provider_id,
        revision=1,
        complete=True,
        published_at=now,
        valid_until=now + timedelta(minutes=20),
        artworks=[artwork],
        metadata=[metadata],
    )
    state = {"feed": feed, "image": image, "requests": [], "image_status": 200}

    def handler(request):
        state["requests"].append(request)
        if str(request.url) == grant.manifest_url:
            return httpx.Response(
                state.get("manifest_status", 200), json=json.loads(state["feed"].model_dump_json())
            )
        return httpx.Response(
            state["image_status"], content=state["image"], headers={"Content-Type": "image/png"}
        )

    def client(headers, timeout, *, max_response_bytes):
        return httpx.AsyncClient(
            headers=headers,
            timeout=timeout,
            transport=httpx.MockTransport(handler),
            follow_redirects=False,
            trust_env=False,
        )

    monkeypatch.setattr(providers, "create_public_mcp_http_client", client)
    return grant, target, state


@pytest.mark.asyncio
async def test_authenticated_feed_sanitizes_and_publishes_atomically_without_disclosing_cards(
    licensed_feed,
):
    grant, path, state = licensed_feed
    provider = providers.configured_artwork_providers()[grant.provider_id]
    result = await synchronize_artwork(provider, path, apply=True)
    assert result["applied"] and result["approvedAssets"] == 1
    catalog = load_catalog()[0]
    asset = catalog.assets[0]
    assert asset.source_digest != asset.digest and asset.width == 160 and asset.height == 101
    assert read_asset(asset.digest)[1] == "image/png"
    resolution = resolve_artwork("42424200", 16, "visa")
    assert (
        resolution["match"] == "exact" and resolution["variants"][0]["artworkVersion"] == "2026-1"
    )
    assert state["requests"][0].headers["Authorization"] == "Bearer test-only-provider-credential"
    assert "Authorization" not in state["requests"][1].headers
    assert all(
        request.method == "GET" and request.content == b"" and "424242" not in str(request.url)
        for request in state["requests"]
    )
    assert "test-only-provider-credential" not in path.read_text()
    # Owner resolution above is exclusively local: no new upstream call.
    assert len(state["requests"]) == 2


@pytest.mark.asyncio
async def test_bank_browse_refuses_incomplete_provider_state(licensed_feed):
    from hushh_mcp.services.wallet_bank_artwork import bank_designs

    grant, path, _ = licensed_feed
    await synchronize_artwork(
        providers.configured_artwork_providers()[grant.provider_id], path, apply=True
    )
    catalog = load_catalog()[0]
    catalog.assets[0] = catalog.assets[0].model_copy(update={"bank_design": True})
    assert len(bank_designs("visa", catalog=catalog)["banks"]) == 1
    catalog.provider_states[grant.provider_id] = catalog.provider_states[
        grant.provider_id
    ].model_copy(update={"complete": False})
    assert bank_designs("visa", catalog=catalog)["banks"] == []


@pytest.mark.asyncio
async def test_dry_run_creates_no_catalog_or_asset_files_and_retries_are_idempotent(licensed_feed):
    grant, path, state = licensed_feed
    provider = providers.configured_artwork_providers()[grant.provider_id]
    assert not (await synchronize_artwork(provider, path))["applied"]
    assert (
        not path.exists()
        and not (path.parent / "assets").exists()
        and not path.with_suffix(".json.lock").exists()
    )
    await synchronize_artwork(provider, path, apply=True)
    before = path.read_bytes()
    count = len(state["requests"])
    assert (await synchronize_artwork(provider, path, apply=True))["unchanged"]
    assert path.read_bytes() == before and len(state["requests"]) == count + 1


@pytest.mark.asyncio
async def test_partial_download_failure_keeps_verified_revocation_and_retries_same_release(
    licensed_feed,
):
    grant, path, state = licensed_feed
    provider = providers.configured_artwork_providers()[grant.provider_id]
    await synchronize_artwork(provider, path, apply=True)
    old = load_catalog()[0].assets[0]
    original = state["feed"].artworks[0]
    state["feed"] = state["feed"].model_copy(
        update={
            "revision": 2,
            "metadata": [],
            "artworks": [
                original.model_copy(update={"status": "revoked"}),
                original.model_copy(
                    update={"source_asset_id": "replacement", "artwork_version": "2026-2"}
                ),
            ],
        }
    )
    state["image_status"] = 503
    with pytest.raises(providers.ProviderUnavailable):
        await synchronize_artwork(provider, path, apply=True)
    partial = load_catalog()[0]
    assert (
        partial.assets[0].status == "revoked"
        and not partial.provider_states[grant.provider_id].complete
    )
    with pytest.raises(FileNotFoundError):
        read_asset(old.digest)
    state["image_status"] = 200
    await synchronize_artwork(provider, path, apply=True)
    final = load_catalog()[0]
    assert final.provider_states[grant.provider_id].complete
    assert {row.status for row in final.assets} == {"approved", "revoked"}


@pytest.mark.asyncio
async def test_stale_releases_and_revoked_revision_reactivation_fail_closed(licensed_feed):
    grant, path, state = licensed_feed
    provider = providers.configured_artwork_providers()[grant.provider_id]
    original = state["feed"]
    await synchronize_artwork(provider, path, apply=True)
    state["feed"] = original.model_copy(update={"revision": 2, "artworks": [], "metadata": []})
    await synchronize_artwork(provider, path, apply=True)
    state["feed"] = original
    with pytest.raises(ValueError, match="stale_provider_revision"):
        await synchronize_artwork(provider, path, apply=True)
    state["feed"] = original.model_copy(update={"revision": 3})
    with pytest.raises(ValueError, match="immutable_artwork_revision_changed"):
        await synchronize_artwork(provider, path, apply=True)
    assert load_catalog()[0].assets[0].status == "revoked"


@pytest.mark.asyncio
async def test_unrelated_product_update_preserves_confirmed_asset_not_pending_picker_version(
    licensed_feed,
):
    grant, path, state = licensed_feed
    provider = providers.configured_artwork_providers()[grant.provider_id]
    await synchronize_artwork(provider, path, apply=True)
    original = load_catalog()[0]
    old = original.assets[0]
    choice = {
        "assetId": old.asset_id,
        "issuerId": old.issuer_id,
        "productId": old.product_id,
        "variantId": old.variant_id,
        "digest": old.digest,
        "catalogVersion": original.version,
    }
    second = (
        state["feed"]
        .artworks[0]
        .model_copy(update={"source_asset_id": "platinum", "product_id": "platinum"})
    )
    state["feed"] = state["feed"].model_copy(
        update={"revision": 2, "artworks": [*state["feed"].artworks, second]}
    )
    await synchronize_artwork(provider, path, apply=True)
    assert not validate_artwork_selections([choice])[0]["approved"]
    assert validate_artwork_selections([choice], purpose="saved")[0]["approved"]
    assert read_asset(old.digest)[1] == "image/png"


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [401, 403, 429, 302])
async def test_auth_expiry_rate_limits_and_redirects_never_forward_credentials(
    licensed_feed, status
):
    grant, path, state = licensed_feed
    state["manifest_status"] = status
    with pytest.raises(providers.ProviderUnavailable) as error:
        await synchronize_artwork(
            providers.configured_artwork_providers()[grant.provider_id], path, apply=True
        )
    assert str(error.value) == "artwork_provider_unavailable"
    assert len(state["requests"]) == 1 and not path.exists()


@pytest.mark.asyncio
async def test_missing_credentials_and_disabled_configuration_make_no_requests(
    licensed_feed, monkeypatch
):
    grant, path, state = licensed_feed
    monkeypatch.delenv("WALLET_ARTWORK_PROVIDER_CREDENTIALS_JSON")
    with pytest.raises(providers.ProviderUnavailable):
        await synchronize_artwork(
            providers.configured_artwork_providers()[grant.provider_id], path, apply=True
        )
    assert not state["requests"] and not path.exists()
    monkeypatch.setenv("HUSHH_WALLET_ARTWORK_PROVIDERS_ENABLED", "false")
    assert providers.configured_artwork_providers() == {}


@pytest.mark.asyncio
async def test_replaced_grant_invalidates_reads_then_same_feed_is_readmitted(licensed_feed):
    grant, path, state = licensed_feed
    await synchronize_artwork(
        providers.configured_artwork_providers()[grant.provider_id], path, apply=True
    )
    old = load_catalog()[0].assets[0]
    policy = path.parent / "policy.json"
    updated = grant.model_copy(update={"approved_by": "replacement-reviewer", "countries": ["US"]})
    policy.write_text(
        providers.ProviderRegistry(
            schema_version="hushh.wallet.artwork.providers.v1", providers=[updated]
        ).model_dump_json()
    )
    with pytest.raises(FileNotFoundError):
        read_asset(old.digest)
    assert resolve_artwork("424242", 16, "visa")["match"] == "unknown"
    result = await synchronize_artwork(
        providers.configured_artwork_providers()[grant.provider_id], path, apply=True
    )
    assert result["applied"] and not result["unchanged"]
    assert load_catalog()[0].assets[0].grant_digest != old.grant_digest
    assert resolve_artwork("424242", 16, "visa")["match"] == "exact"


@pytest.mark.asyncio
async def test_exact_evidence_cannot_cross_provider_id_namespaces(licensed_feed, monkeypatch):
    grant, path, state = licensed_feed
    await synchronize_artwork(
        providers.configured_artwork_providers()[grant.provider_id], path, apply=True
    )
    original = load_catalog()[0]
    other = grant.model_copy(update={"provider_id": "other-provider"})
    monkeypatch.setattr(
        providers,
        "active_provider_grants",
        lambda: {grant.provider_id: grant, other.provider_id: other},
    )
    # Identical product/variant strings from a different supplier aren't proof.
    original.assets[0] = original.assets[0].model_copy(
        update={"provider_id": other.provider_id, "grant_digest": providers.grant_digest(other)}
    )
    original.provider_states[other.provider_id] = original.provider_states[
        grant.provider_id
    ].model_copy(update={"grant_digest": providers.grant_digest(other)})
    result = resolve_artwork("424242", 16, "visa", catalog=original)
    assert result["match"] != "exact" and result["variants"] == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "network", ["visa", "mastercard", "amex", "rupay", "discover", "diners", "jcb", "unionpay"]
)
async def test_approved_product_and_generation_matching_is_network_independent(
    licensed_feed, network
):
    grant, path, state = licensed_feed
    state["feed"] = state["feed"].model_copy(
        update={
            "artworks": [state["feed"].artworks[0].model_copy(update={"network": network})],
            "metadata": [state["feed"].metadata[0].model_copy(update={"network": network})],
        }
    )
    await synchronize_artwork(
        providers.configured_artwork_providers()[grant.provider_id], path, apply=True
    )
    assert resolve_artwork("424242", 16, network)["match"] == "exact"
    assert resolve_artwork("424242", 16, "other")["match"] == "unknown"


@pytest.mark.asyncio
async def test_incomplete_custom_adapter_cannot_publish_omission_revocations(licensed_feed):
    grant, path, state = licensed_feed
    source = providers.configured_artwork_providers()[grant.provider_id]
    await synchronize_artwork(source, path, apply=True)
    before = path.read_bytes()

    class Incomplete:
        async def snapshot(self):
            return state["feed"].model_copy(
                update={"revision": 2, "complete": False, "artworks": []}
            )

    broken = Incomplete()
    broken.grant = grant
    with pytest.raises(ValueError):
        await synchronize_artwork(broken, path, apply=True)
    assert path.read_bytes() == before


@pytest.mark.asyncio
async def test_conflicting_asset_prefix_restriction_cannot_be_overridden_by_product_proof(
    licensed_feed,
):
    grant, path, state = licensed_feed
    state["feed"] = state["feed"].model_copy(
        update={
            "artworks": [state["feed"].artworks[0].model_copy(update={"iin_prefixes": ["555555"]})]
        }
    )
    await synchronize_artwork(
        providers.configured_artwork_providers()[grant.provider_id], path, apply=True
    )
    result = resolve_artwork("424242", 16, "visa")
    assert result["match"] != "exact" and result["variants"] == []


@pytest.mark.parametrize("field", ["issuer_approval_reference", "issuer_name", "product_name"])
def test_blank_issuer_approval_or_display_metadata_is_rejected(licensed_feed, field):
    _, _, state = licensed_feed
    row = state["feed"].artworks[0].model_dump()
    row[field] = "   "
    with pytest.raises(ValueError):
        providers.FeedArtwork.model_validate(row)


@pytest.mark.parametrize(
    "changes",
    [
        {"manifest_url": "https://127.0.0.1/feed"},
        {"manifest_url": "https://169.254.169.254/feed"},
        {"manifest_url": "https://user:password@api.artwork.example/feed"},
        {"asset_base_url": "https://cdn.artwork.example/../private/"},
        {"asset_base_url": "https://cdn.artwork.example/%2e%2e/"},
        {"asset_requires_auth": True},
        {"agreement_reference": ""},
        {"blank_artwork_review_reference": ""},
        {"rights_policy": "temporary_display"},
        {"audience": "issuer-tenant-only"},
    ],
)
def test_unreviewed_rights_private_destinations_and_cross_origin_credentials_are_rejected(
    licensed_feed, changes
):
    grant = licensed_feed[0]
    with pytest.raises(ValueError):
        providers.ProviderGrant.model_validate({**grant.model_dump(), **changes})


@pytest.mark.asyncio
async def test_invalid_personalized_or_expired_feed_is_not_published(licensed_feed):
    grant, path, state = licensed_feed
    provider = providers.configured_artwork_providers()[grant.provider_id]
    state["feed"] = state["feed"].model_copy(
        update={"valid_until": datetime.now(timezone.utc) - timedelta(seconds=1)}
    )
    with pytest.raises(providers.ProviderUnavailable):
        await synchronize_artwork(provider, path, apply=True)
    assert not path.exists()
    row = state["feed"].artworks[0].model_dump()
    with pytest.raises(ValueError):
        providers.FeedArtwork.model_validate({**row, "blank_artwork": False})
    with pytest.raises(ValueError):
        providers.FeedArtwork.model_validate({**row, "pan": "must-never-be-an-artwork-field"})
