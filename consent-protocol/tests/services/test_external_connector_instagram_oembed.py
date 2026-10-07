"""Public oEmbed remains a bounded, presentation-only provider call."""

from __future__ import annotations

from unittest.mock import AsyncMock

import httpx
import pytest

from hushh_mcp.services import external_connector_instagram_oembed as oembed


@pytest.mark.parametrize(
    "value",
    [
        "http://www.instagram.com/p/ABC123/",
        "https://www.instagram.com.evil.test/p/ABC123/",
        "https://www.instagram.com@evil.test/p/ABC123/",
        "https://www.instagram.com/p/ABC123/#fragment",
        "https://www.instagram.com/p/ABC123/../other/",
        "https://www.instagram.com/stories/example/123/",
        "https://www.instagram.com/p/ABC123/\\evil",
    ],
)
def test_only_documented_instagram_post_urls_are_accepted(value):
    with pytest.raises(oembed.InstagramOEmbedError, match="invalid_post_url"):
        oembed.canonical_post_url(value)


def test_share_parameters_are_discarded_before_provider_lookup():
    assert (
        oembed.canonical_post_url("https://instagram.com/reel/ABC_123/?igsh=tracking-value")
        == "https://www.instagram.com/reel/ABC_123/"
    )


@pytest.mark.asyncio
async def test_public_embed_uses_fixed_tokenless_graph_endpoint_and_returns_only_html(monkeypatch):
    seen = []
    html = '<blockquote class="instagram-media">Official presentation</blockquote>'

    def handler(request):
        seen.append(request)
        return httpx.Response(
            200,
            json={
                "provider_name": "Instagram",
                "type": "rich",
                "html": html,
                "author_name": "must-not-be-returned",
                "thumbnail_url": "https://example.test/metadata",
            },
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(oembed.httpx, "AsyncClient", lambda **_: client)
    reserve = AsyncMock(return_value=True)
    service = oembed.ExternalConnectorInstagramOEmbed(reserve_quota=reserve)

    assert await service.embed(post_url="https://instagram.com/p/ABC123/?igsh=tracking-value") == {
        "html": html
    }
    reserve.assert_awaited_once()
    assert len(seen) == 1
    assert str(seen[0].url).startswith(oembed.GRAPH_ENDPOINT)
    assert seen[0].url.params["url"] == "https://www.instagram.com/p/ABC123/"
    assert seen[0].url.params["omitscript"] == "true"
    assert "access_token" not in seen[0].url.params
    assert seen[0].headers.get("authorization") is None


@pytest.mark.asyncio
async def test_missing_or_exhausted_shared_quota_fails_before_provider_call(monkeypatch):
    def unexpected_client(**_):
        raise AssertionError("provider call must not happen")

    monkeypatch.setattr(oembed.httpx, "AsyncClient", unexpected_client)
    with pytest.raises(oembed.InstagramOEmbedError, match="oembed_quota_unavailable"):
        await oembed.ExternalConnectorInstagramOEmbed().embed(
            post_url="https://www.instagram.com/p/ABC123/"
        )
    reserve = AsyncMock(return_value=False)
    with pytest.raises(oembed.InstagramOEmbedError, match="oembed_rate_limited"):
        await oembed.ExternalConnectorInstagramOEmbed(reserve_quota=reserve).embed(
            post_url="https://www.instagram.com/p/ABC123/"
        )
    reserve.assert_awaited_once()


@pytest.mark.asyncio
async def test_provider_error_and_oversize_response_are_bounded_and_redacted(monkeypatch):
    secret = "PRIVATE_PROVIDER_RESPONSE_SENTINEL"
    real_client = httpx.AsyncClient
    for response in (
        httpx.Response(400, json={"error": secret}),
        httpx.Response(200, stream=httpx.ByteStream(b"x" * (oembed._MAX_RESPONSE_BYTES + 1))),
    ):
        seen = []

        def handler(request, result=response, requests=seen):
            requests.append(request)
            return result

        client = real_client(transport=httpx.MockTransport(handler))
        monkeypatch.setattr(oembed.httpx, "AsyncClient", lambda client=client, **_: client)
        service = oembed.ExternalConnectorInstagramOEmbed(
            reserve_quota=AsyncMock(return_value=True)
        )
        with pytest.raises(oembed.InstagramOEmbedError) as caught:
            await service.embed(post_url="https://www.instagram.com/p/ABC123/")
        assert secret not in str(caught.value)
        assert len(seen) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "html",
    [
        '<blockquote class="instagram-media" onmouseover="alert(1)">x</blockquote>',
        '<blockquote class="instagram-media"><a href="javascript:alert(1)">x</a></blockquote>',
        '<blockquote class="instagram-media"><script>alert(1)</script></blockquote>',
    ],
)
async def test_provider_markup_must_not_contain_active_html(monkeypatch, html):
    client = httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda _: httpx.Response(
                200, json={"provider_name": "Instagram", "type": "rich", "html": html}
            )
        )
    )
    monkeypatch.setattr(oembed.httpx, "AsyncClient", lambda **_: client)
    service = oembed.ExternalConnectorInstagramOEmbed(reserve_quota=AsyncMock(return_value=True))
    with pytest.raises(oembed.InstagramOEmbedError, match="oembed_response_invalid"):
        await service.embed(post_url="https://www.instagram.com/p/ABC123/")
