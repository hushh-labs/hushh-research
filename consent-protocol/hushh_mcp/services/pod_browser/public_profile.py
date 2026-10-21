"""Fixed public-research transport profile, not permission for private headers.

Interactive requests keep their original values and require exact review. Public
reads may bypass that review only with this finite, non-private browser profile.
"""

USER_AGENT = "HusshBrowser/1.0"
# CDP accepts preferences without weights and generates the wire value below.
CHROMIUM_LANGUAGES = "en-US,en"
LANGUAGE = "en-US,en;q=0.9"
_VALUES = {
    "user-agent": {USER_AGENT},
    "accept-language": {LANGUAGE},
    "accept": {
        "*/*",
        "text/css,*/*;q=0.1",
        "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,"
        "image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    },
    "sec-fetch-dest": {"document", "empty", "script", "style", "image", "font"},
    "sec-fetch-mode": {"navigate", "same-origin", "no-cors", "cors"},
    "sec-fetch-site": {"none", "same-origin", "same-site", "cross-site"},
    "sec-fetch-user": {"?1"},
    "upgrade-insecure-requests": {"1"},
    "cache-control": {"no-cache", "max-age=0"},
    "pragma": {"no-cache"},
}


def public_headers(headers: tuple[tuple[str, str], ...], page_urls: tuple[str, ...]) -> bool:
    seen: set[str] = set()
    for name, value in headers:
        name = name.lower()
        if name in seen:
            return False
        seen.add(name)
        # A referrer can disclose credentials or private text. Only an already
        # reviewed exact public page URL is admitted, never an arbitrary path.
        if name == "referer" and value in page_urls:
            continue
        if value not in _VALUES.get(name, set()):
            return False
    return True
