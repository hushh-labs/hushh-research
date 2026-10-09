"""Verified action links found in one receipt email.

A gene: pure, import-safe, and defensive about provider shape. It reads the
anchors and plain-text URLs of one Gmail ``format=full`` payload and keeps only
links that are safe to offer: HTTPS, an ordinary DNS host, no credentials, no
tracking, unsubscribe, advertising or redirect wrapper, and a host that belongs
to the email's sender or to a reviewed billing platform. It never fetches a
URL and never follows a redirect, so reading a receipt cannot reach the network.

What a link *means* (view the receipt, view the invoice, pay what is due) is a
semantic judgment and stays with the receipt extractor. This module only
decides which links the extractor may choose from, and later re-derives the
chosen one so a stored reference never has to hold a URL.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from html.parser import HTMLParser
from typing import Any, Final
from urllib.parse import parse_qsl, unquote, urlencode, urlsplit, urlunsplit

from hushh_mcp.services.gmail_message_text import MessageTextError, decode_part_text
from hushh_mcp.services.gmail_receipt_documents import receipt_parts

ACTION_KINDS: Final = ("view_receipt", "view_invoice", "pay_due")
# A payment action is offered only for a receipt the extractor found unpaid.
PAY_DUE_STATUSES: Final = frozenset({"overdue", "payment_failed", "suspended", "renewal_due"})

MAX_HTML_CHARS: Final = 500_000
MAX_ANCHORS: Final = 200
MAX_LINKS: Final = 12
MAX_URL_LENGTH: Final = 1_600
MAX_LABEL: Final = 80

# Billing platforms whose hosted receipt and invoice pages are linked from the
# merchant's own mail. Every other host must belong to the sender.
_BILLING_HOSTS: Final = (
    "stripe.com",
    "paypal.com",
    "paddle.com",
    "razorpay.com",
    "lemonsqueezy.com",
    "chargebee.com",
    "recurly.com",
    "gumroad.com",
    "squareup.com",
)
_TWO_LEVEL_SUFFIXES: Final = frozenset(
    {
        "co.in", "co.uk", "com.au", "co.jp", "com.br", "co.nz", "co.za", "com.sg", "com.hk",
        "org.uk", "ac.in", "net.in", "org.in", "gov.in", "com.mx", "co.kr", "com.tr", "com.cn",
        "com.tw", "co.id", "com.my", "com.ph", "com.vn", "com.ar",
    }
)  # fmt: skip
# Mail-platform click tracking is usually a CNAME such as click.example.com.
_TRACKING_FIRST_LABELS: Final = frozenset(
    {
        "click", "clicks", "clk", "link", "links", "lnk", "email", "mail", "em", "e", "t", "r",
        "ct", "trk", "track", "tracking", "tr", "redirect", "redir", "go", "ablink", "sp", "mkt",
        "marketing", "news", "newsletter", "info", "l", "u", "url", "s",
    }
)  # fmt: skip
# Mail platforms, shorteners and ad networks: none of them says where a link goes.
_REDIRECT_HOSTS: Final = (
    "sendgrid.net", "sendgrid.com", "mandrillapp.com", "list-manage.com", "mailchimp.com",
    "mailgun.org", "mailgun.net", "hubspotlinks.com", "sparkpostmail.com", "customeriomail.com",
    "customer.io", "iterable.com", "exacttarget.com", "exct.net", "klclick.com", "klaviyomail.com",
    "braze.com", "appboy.com", "sailthru.com", "e2ma.net", "rs6.net", "constantcontact.com",
    "campaign-archive.com", "createsend.com", "t.co", "bit.ly", "tinyurl.com", "goo.gl", "ow.ly",
    "lnkd.in", "fb.me", "rb.gy", "is.gd", "cutt.ly", "shorturl.at", "s.id", "buff.ly", "dlvr.it",
    "amzn.to", "doubleclick.net", "googleadservices.com", "googlesyndication.com",
    "google-analytics.com", "adservice.google.com",
)  # fmt: skip
_UNSAFE_PATH: Final = re.compile(
    r"unsubscri|/unsub\b|opt[-_]?out|preferences?\b|manage[-_]?(?:email|subscri|notif)|"
    r"/pixel|/beacon|/open(?:/|$)|/track|/click|/redirect|/redir\b|/trk\b|/ads?/|adserver|"
    r"/out/|/goto/|/ls/click|/wf/click|/e/c/",
    re.I,
)
# A parameter that carries another URL is an open redirect.
_REDIRECT_PARAMS: Final = frozenset(
    {
        "url", "u", "redirect", "redirect_url", "redirect_uri", "redir", "next", "target", "dest",
        "destination", "goto", "link", "continue", "return", "returnurl", "return_url", "r",
    }
)  # fmt: skip
_TRACKING_PARAMS: Final = re.compile(
    r"^(?:utm_.*|mc_(?:cid|eid)|fbclid|gclid|msclkid|_hsenc|_hsmi|mkt_tok|igshid|yclid)$", re.I
)
_HOST: Final = re.compile(r"(?=.{1,253}\Z)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\Z")
_PLAIN_URL: Final = re.compile(r"https?://[^\s<>\"')\]]+", re.I)
_SPACE_OR_CONTROL: Final = re.compile(r"[\s\x00-\x1f\x7f]")
_URL_IN_LABEL: Final = re.compile(r"https?://\S+|www\.\S+", re.I)


@dataclass(frozen=True)
class ActionLink:
    """A link the extractor may choose. `url` stays inside this process."""

    link_id: str
    url: str
    label: str
    host: str


class _Anchors(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.found: list[tuple[str, str]] = []
        self._href: str | None = None
        self._text: list[str] = []
        self._skipping = 0

    def _close(self) -> None:
        if self._href is not None and len(self.found) < MAX_ANCHORS:
            self.found.append((self._href, " ".join("".join(self._text).split())))
        self._href = None
        self._text = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style", "template", "noscript"}:
            self._skipping += 1
        elif tag == "a":
            self._close()
            href = next((value for name, value in attrs if name == "href" and value), None)
            self._href = href.strip() if isinstance(href, str) else None

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "template", "noscript"} and self._skipping:
            self._skipping -= 1
        elif tag == "a":
            self._close()

    def handle_data(self, data: str) -> None:
        if self._href is not None and not self._skipping:
            self._text.append(data)

    def close(self) -> None:
        super().close()
        self._close()


def registrable_domain(host: str) -> str:
    labels = host.split(".")
    if len(labels) >= 3 and ".".join(labels[-2:]) in _TWO_LEVEL_SUFFIXES:
        return ".".join(labels[-3:])
    return ".".join(labels[-2:])


def _under(host: str, domain: str) -> bool:
    return host == domain or host.endswith(f".{domain}")


def _clean_query(query: str) -> str | None:
    """The query without tracking parameters, or ``None`` when it hides a redirect."""
    kept: list[tuple[str, str]] = []
    for key, value in parse_qsl(query, keep_blank_values=True):
        if key.lower() in _REDIRECT_PARAMS and re.match(r"(?i)^\s*(?:https?:)?//", unquote(value)):
            return None
        if _TRACKING_PARAMS.match(key):
            continue
        kept.append((key, value))
    return urlencode(kept, doseq=True, safe="/:@,;+") if kept else ""


def safe_action_url(raw: object, *, sender_domain: str | None) -> str | None:
    """A normalized, safe HTTPS URL for this email, or ``None``. Never fetches anything."""
    if not isinstance(raw, str):
        return None
    text = raw.strip()
    # ASCII only: a real receipt link is percent-encoded, and any other character
    # (a bidirectional override, a look-alike letter) can only disguise the target.
    if (
        not text
        or len(text) > MAX_URL_LENGTH
        or not text.isascii()
        or _SPACE_OR_CONTROL.search(text)
    ):
        return None
    try:
        parts = urlsplit(text)
        port = parts.port
    except ValueError:
        return None
    # `javascript:`, `data:`, `mailto:`, `tel:` and plain `http:` all stop here.
    if parts.scheme.lower() != "https" or parts.username is not None or parts.password is not None:
        return None
    if port not in (None, 443):
        return None
    host = (parts.hostname or "").lower().rstrip(".")
    labels = host.split(".")
    if (
        not _HOST.fullmatch(host)
        or any(label.startswith("xn--") for label in labels)
        or host == "localhost"
        or labels[0] in _TRACKING_FIRST_LABELS
        or any(_under(host, blocked) for blocked in _REDIRECT_HOSTS)
    ):
        return None
    sender = (sender_domain or "").strip().lower()
    belongs_to_sender = bool(sender) and registrable_domain(host) == registrable_domain(sender)
    if not belongs_to_sender and not any(_under(host, billing) for billing in _BILLING_HOSTS):
        return None
    if _UNSAFE_PATH.search(unquote(parts.path)) or _UNSAFE_PATH.search(unquote(parts.query)):
        return None
    query = _clean_query(parts.query)
    if query is None:
        return None
    return urlunsplit(("https", host, parts.path or "/", query, ""))


def url_digest(url: str) -> str:
    """A short fingerprint that lets a stored reference name a link without holding it."""
    return hashlib.sha256(url.encode("utf-8")).hexdigest()[:32]


def _label(value: str) -> str:
    cleaned = " ".join(_URL_IN_LABEL.sub(" ", value).split())
    return cleaned[:MAX_LABEL].strip()


def _candidates(payload: Any) -> list[tuple[str, str]]:
    found: list[tuple[str, str]] = []
    for part in receipt_parts(payload):
        if part.get("filename") or part.get("parts") is not None:
            continue
        mime_type = str(part.get("mimeType") or "").lower()
        if mime_type not in {"text/html", "text/plain"}:
            continue
        try:
            text = decode_part_text(part)[:MAX_HTML_CHARS]
        except MessageTextError:
            continue
        if mime_type == "text/html":
            parser = _Anchors()
            try:
                parser.feed(text)
                parser.close()
            except Exception:  # noqa: BLE001 - malformed provider HTML yields no links
                continue
            found.extend(parser.found)
        else:
            for line in text.splitlines():
                for match in _PLAIN_URL.finditer(line):
                    found.append((match.group(0).rstrip(".,;:"), _label(line[: match.start()])))
    return found


def action_links(payload: Any, *, sender_domain: str | None) -> list[ActionLink]:
    """The safe links in one message, in document order, each with a stable id."""
    links: list[ActionLink] = []
    seen: set[str] = set()
    for href, label in _candidates(payload):
        url = safe_action_url(href, sender_domain=sender_domain)
        if url is None or url in seen:
            continue
        seen.add(url)
        links.append(
            ActionLink(
                link_id=f"link:{len(links)}",
                url=url,
                label=_label(label),
                host=urlsplit(url).hostname or "",
            )
        )
        if len(links) >= MAX_LINKS:
            break
    return links


__all__ = [
    "ACTION_KINDS",
    "MAX_LINKS",
    "PAY_DUE_STATUSES",
    "ActionLink",
    "action_links",
    "registrable_domain",
    "safe_action_url",
    "url_digest",
]
