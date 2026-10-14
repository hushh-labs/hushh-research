"""Consumer mailbox domains that an organization can never own.

WorkOS only marks a domain verified after a DNS check, so none of these should
ever appear on an organization. The service still refuses them: email
auto-link trusts a verified domain, and a free-mail domain must never be one.
"""

from __future__ import annotations

CONSUMER_EMAIL_DOMAINS = frozenset(
    {
        "aol.com",
        "gmail.com",
        "googlemail.com",
        "gmx.com",
        "gmx.net",
        "hotmail.com",
        "icloud.com",
        "live.com",
        "mac.com",
        "mail.com",
        "me.com",
        "msn.com",
        "outlook.com",
        "proton.me",
        "protonmail.com",
        "yahoo.com",
        "ymail.com",
    }
)
