"""Single source of truth for the brand name in user-facing backend copy.

The connection-request banner used to spell the brand as a bare literal in two
places in ``push_notifications`` and a third time as JSX in the web toast. Three
independent authors of one sentence is why the misspelling ("hushh") survived on
the notification surface long after the rest of the product had moved to
"Hussh": nothing tied them together, and the docs brand gate
(``scripts/verify-doc-brand.cjs``) only looks for the capitalised ``Hushh``, so
the lowercase form was invisible to it.

``hushh`` remains correct and load-bearing as an *identifier* -- package names,
bundle ids, domains, headers, env vars, storage keys. This module is only about
prose a person reads. See ``docs/reference/operations/hussh-rebrand-classification.md``:
user-facing product copy is "public-brand prose" and reads ``Hussh``.
"""

from __future__ import annotations

BRAND_NAME = "Hussh"
PRODUCT_NAME = "Hussh One"

# What the banner says when we genuinely cannot name the requester. Kept here
# rather than inlined so the web fallback and this one stay the same word.
GENERIC_REQUESTER_LABEL = "Someone"


def connection_request_body(requester_label: str | None = None) -> str:
    """The one connection-request sentence, for every platform.

    This is the *only* body text the OS banner can show on web, iOS and
    Android -- ``build_push_message`` puts it on ``WebpushNotification.body``,
    the top-level ``messaging.Notification`` and ``aps.alert.body``
    respectively, and none of those can be rewritten on-device (no
    ``mutable_content``). So this string is authoritative, not decorative.

    Never emits ``None``/``undefined``: a blank or whitespace-only label
    degrades to the generic line rather than producing " wants to connect...".
    """
    label = str(requester_label or "").strip() or GENERIC_REQUESTER_LABEL
    return f"{label} wants to connect with you on {BRAND_NAME}."
