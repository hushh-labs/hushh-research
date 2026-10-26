"""Cross-surface document notification vocabulary, copy and routing contract."""

from pathlib import Path


def test_every_surface_shares_one_type_list_and_the_same_words():
    """The backend worker, the web worker and the app must agree, or a new type
    is silently dropped on one surface (five hard-coded lists before 244)."""
    import re

    from hushh_mcp.services.drive_share_notification_worker import (
        DOCUMENT_REQUEST_SETUP_STEPS,
        DOCUMENT_SHARE_NOTIFICATION_COPY,
    )

    web = Path(__file__).resolve().parents[2] / "hushh-webapp"
    for relative in (
        "public/notification-payload-contract.js",
        "lib/consent/document-share-consent.ts",
    ):
        source = (web / relative).read_text()
        allowlist = re.search(
            r"DOCUMENT_SHARE_NOTIFICATION_TYPES = new Set\(\[(.*?)\]\)", source, re.S
        )
        assert allowlist, relative
        assert set(re.findall(r'"(document_share_[a-z_]+)"', allowlist.group(1))) == set(
            DOCUMENT_SHARE_NOTIFICATION_COPY
        ), relative
        for title, body in DOCUMENT_SHARE_NOTIFICATION_COPY.values():
            assert f'"{title}"' in source and f'"{body}"' in source, (relative, title)
    # A setup step the web worker cannot route would silently open the review.
    worker = (web / "public/notification-payload-contract.js").read_text()
    transport = (web / "public/firebase-messaging-sw.js").read_text()
    assert 'importScripts("/notification-payload-contract.js")' in transport
    targets = re.search(r"DOCUMENT_REQUEST_SETUP_TARGETS = \{(.*?)\};", worker, re.S)
    assert targets and set(re.findall(r"^\s*([a-z]+):", targets.group(1), re.M)) == (
        DOCUMENT_REQUEST_SETUP_STEPS
    )
