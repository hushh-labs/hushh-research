"""Opening a referral link: who gets an attribution, and who must not.

The rules here are the ones that decide whether a referral count is worth
anything. Two of them are easy to get wrong in a way nobody notices:

  * A link-preview crawler opens the URL the moment it is pasted into a chat.
    First eligible attribution wins, so a crawler that takes one spends the
    invitation before the human ever taps it.
  * The negative answer must be identical for an invalid slug, a disabled slug
    and a slug whose owner is gone. Three different answers turn the endpoint
    into an oracle for which slugs are real.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services.one_referral_service import looks_like_a_crawler

REAL_BROWSERS = [
    # iOS Safari, the platform most of our people are on.
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15"
    " (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    # Chrome on Android.
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like"
    " Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
    # Desktop Chrome.
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML,"
    " like Gecko) Chrome/126.0.0.0 Safari/537.36",
    # Desktop Firefox.
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0",
]

CRAWLERS = [
    "WhatsApp/2.23.20.0 A",
    "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
    "TelegramBot (like TwitterBot)",
    "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
    "Twitterbot/1.0",
    "LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)",
    "Discordbot/2.0 (+https://discordapp.com)",
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "Applebot/0.1",
    "curl/8.4.0",
    "python-requests/2.31.0",
]


@pytest.mark.parametrize("agent", REAL_BROWSERS)
def test_a_real_browser_is_never_mistaken_for_a_crawler(agent):
    # The expensive false positive: a genuine person opens the link and silently
    # gets no attribution, so their friend's referral never counts and nobody
    # can see why.
    assert looks_like_a_crawler(agent) is False


@pytest.mark.parametrize("agent", CRAWLERS)
def test_every_known_link_preview_crawler_is_refused(agent):
    assert looks_like_a_crawler(agent) is True


def test_a_missing_user_agent_fails_closed():
    # Not a browser either. Refusing costs a real person nothing -- the link
    # still works, it just resolves again -- while accepting costs the referrer
    # their invitation.
    assert looks_like_a_crawler(None) is True
    assert looks_like_a_crawler("") is True
    assert looks_like_a_crawler("   ") is True


def test_the_check_is_case_insensitive():
    assert looks_like_a_crawler("WHATSAPP/2.0") is True
    assert looks_like_a_crawler("FacebookExternalHit/1.1") is True
