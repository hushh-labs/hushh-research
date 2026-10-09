"""Which links a receipt email may offer, and which it never may.

Every rejection here is a real way a mailbox could try to turn "View invoice"
into a tracking beacon, an unsubscribe, an ad click, a phishing page or an open
redirect. The accepted cases are the shapes real receipts use.
"""

from __future__ import annotations

import base64
import json

import pytest

from hushh_mcp.services.receipt_action_links import (
    MAX_LINKS,
    action_links,
    safe_action_url,
    url_digest,
)


def _part(mime: str, text: str, *, filename: str = "") -> dict:
    data = base64.urlsafe_b64encode(text.encode()).decode().rstrip("=")
    return {"mimeType": mime, "filename": filename, "body": {"data": data, "size": len(text)}}


def _payload(*parts: dict) -> dict:
    return {"mimeType": "multipart/alternative", "parts": list(parts)}


@pytest.mark.parametrize(
    ("url", "sender", "expected"),
    [
        # The merchant's own site.
        (
            "https://billing.supabase.com/invoices/ZSUQHV-00028",
            "supabase.com",
            "https://billing.supabase.com/invoices/ZSUQHV-00028",
        ),
        (
            "https://www.amazon.in/gp/css/order-details?orderID=404-1234567-1234567",
            "amazon.in",
            "https://www.amazon.in/gp/css/order-details?orderID=404-1234567-1234567",
        ),
        # A reviewed billing platform, even though the sender is the merchant.
        (
            "https://invoice.stripe.com/i/acct_1ABC/live_secret?s=ap",
            "supabase.com",
            "https://invoice.stripe.com/i/acct_1ABC/live_secret?s=ap",
        ),
        ("https://pay.stripe.com/receipts/abc", None, "https://pay.stripe.com/receipts/abc"),
        # A two-label public suffix belongs to the merchant, not to its registry.
        (
            "https://www.example.co.in/receipt/9",
            "mail.example.co.in",
            "https://www.example.co.in/receipt/9",
        ),
        ("https://evil.co.in/receipt/9", "example.co.in", None),
        (
            "https://my.example.co.in/receipt/9",
            "billing.example.co.in",
            "https://my.example.co.in/receipt/9",
        ),
        # Tracking parameters are removed and the fragment dropped; the rest is kept.
        (
            "https://billing.supabase.com/invoices/1?utm_source=email&gclid=x&id=7#top",
            "supabase.com",
            "https://billing.supabase.com/invoices/1?id=7",
        ),
        ("https://Billing.Supabase.com", "SUPABASE.com", "https://billing.supabase.com/"),
        # An ordinary path that merely contains a watched word is not a tracker.
        (
            "https://shop.example.com/open-orders/5",
            "example.com",
            "https://shop.example.com/open-orders/5",
        ),
    ],
)
def test_safe_links_are_kept(url, sender, expected):
    assert safe_action_url(url, sender_domain=sender) == expected


@pytest.mark.parametrize(
    "url",
    [
        "javascript:alert(1)",
        "JaVaScRiPt:alert(1)",
        "data:text/html;base64,PHNjcmlwdD4=",
        "mailto:billing@supabase.com",
        "tel:+15551234567",
        "ftp://billing.supabase.com/invoice",
        "http://billing.supabase.com/invoices/1",  # not HTTPS
        "//billing.supabase.com/invoices/1",
        "/invoices/1",
        "https://user:secret@billing.supabase.com/invoices/1",
        "https://billing.supabase.com:8443/invoices/1",
        "https://127.0.0.1/invoices/1",
        "https://[::1]/invoices/1",
        "https://localhost/invoices/1",
        "https://billing.supabase.internal/invoices/1",
        "https://xn--supabse-d2a.com/invoices/1",  # punycode look-alike
        "https://supabase.com.evil.example/invoices/1",  # look-alike suffix
        "https://evil-supabase.com/invoices/1",
        "https://evil.example/invoices/1",  # not the sender, not a billing platform
        "https://click.supabase.com/abc",  # mail-platform click tracking
        "https://links.supabase.com/abc",
        "https://email.supabase.com/abc",
        "https://u123.ct.sendgrid.net/ls/click?upn=abc",
        "https://supabase.list-manage.com/track/click?u=1",
        "https://bit.ly/3abc",
        "https://t.co/abc",
        "https://amzn.to/3abc",
        "https://billing.supabase.com/unsubscribe?u=1",
        "https://billing.supabase.com/email-preferences",
        "https://billing.supabase.com/Manage-Subscriptions-Email",
        "https://billing.supabase.com/opt-out",
        "https://billing.supabase.com/track/open/abc.gif",
        "https://billing.supabase.com/pixel.png",
        "https://billing.supabase.com/ads/click?id=1",
        "https://billing.supabase.com/redirect?to=1",
        "https://billing.supabase.com/go?url=https://evil.example/x",  # open redirect
        "https://billing.supabase.com/go?url=https%3A%2F%2Fevil.example%2Fx",
        "https://billing.supabase.com/r?redirect_uri=//evil.example",
        "https://billing.supabase.com/%75nsubscribe",  # encoded
        "https://billing.supabase.com/invoices/1 2",  # whitespace
        "https://billing.supabase.com/‮invoices",  # bidi control
        "https://billing.supabase.com/" + "a" * 1700,
        "",
        None,
        42,
    ],
)
def test_unsafe_links_are_never_offered(url):
    assert safe_action_url(url, sender_domain="supabase.com") is None


def test_reads_anchors_and_plain_text_in_order_and_ignores_attachments_and_scripts():
    html = (
        "<p>Thanks.</p>"
        '<a href="https://billing.supabase.com/invoices/1">  View   invoice </a>'
        '<a href="https://billing.supabase.com/unsubscribe">Unsubscribe</a>'
        '<a href="javascript:void(0)">Pay now</a>'
        '<a href="https://invoice.stripe.com/i/acct_1/live_x">Pay invoice</a>'
        '<a href="https://billing.supabase.com/invoices/1">duplicate</a>'
        "<script>var u='https://billing.supabase.com/from-script'</script>"
    )
    plain = "Receipt: https://billing.supabase.com/receipts/9.\nBad: http://billing.supabase.com/x"
    links = action_links(
        _payload(
            _part("text/plain", plain),
            _part("text/html", html),
            _part(
                "text/html",
                '<a href="https://billing.supabase.com/attached">x</a>',
                filename="a.html",
            ),
        ),
        sender_domain="supabase.com",
    )
    assert [link.url for link in links] == [
        "https://billing.supabase.com/receipts/9",
        "https://billing.supabase.com/invoices/1",
        "https://invoice.stripe.com/i/acct_1/live_x",
    ]
    assert [link.link_id for link in links] == ["link:0", "link:1", "link:2"]
    assert links[0].label == "Receipt:"
    assert links[1].label == "View invoice"
    assert links[2].host == "invoice.stripe.com"
    assert url_digest(links[1].url) != url_digest(links[2].url)


def test_a_malformed_or_oversized_message_yields_no_links_instead_of_failing():
    assert action_links({"parts": "nope"}, sender_domain="supabase.com") == []
    assert action_links(None, sender_domain="supabase.com") == []
    broken = _payload({"mimeType": "text/html", "body": {"data": "@@@"}})
    assert action_links(broken, sender_domain="supabase.com") == []
    many = "".join(f'<a href="https://billing.supabase.com/i/{n}">x</a>' for n in range(300))
    links = action_links(_payload(_part("text/html", many)), sender_domain="supabase.com")
    assert len(links) == MAX_LINKS


def test_no_link_contains_what_the_safety_rules_reject_even_after_normalization():
    # Whatever survives is HTTPS, credential-free, fragment-free and tracking-free.
    html = "".join(
        f'<a href="{href}">x</a>'
        for href in (
            "https://billing.supabase.com/i/1?utm_campaign=a&fbclid=b#frag",
            "https://billing.supabase.com/i/2?mc_eid=1&ok=1",
        )
    )
    for link in action_links(_payload(_part("text/html", html)), sender_domain="supabase.com"):
        assert link.url.startswith("https://") and "#" not in link.url
        assert "utm_" not in link.url and "fbclid" not in link.url and "mc_eid" not in link.url
    assert json.dumps(
        [
            link.url
            for link in action_links(
                _payload(_part("text/html", html)), sender_domain="supabase.com"
            )
        ]
    )
