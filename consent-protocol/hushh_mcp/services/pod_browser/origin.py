"""Pure browser-origin validation; DNS enforcement remains in the host broker."""

from urllib.parse import urlsplit

from hushh_mcp.services.public_endpoint_policy import validate_mcp_endpoint

from .contracts import BrowserRefused


def public_origin(url: str) -> str:
    try:
        parsed = urlsplit(url)
        if len(url) > 4096 or any(ord(c) <= 32 or ord(c) == 127 for c in url) or "\\" in url:
            raise ValueError()
        if parsed.fragment or not parsed.hostname:
            raise ValueError()
        # Reuse the authored HTTPS host validation while allowing browser paths
        # and queries. DNS is revalidated at the actual TCP connect, not here.
        origin = f"https://{parsed.netloc}"
        if parsed.scheme != "https":
            raise ValueError()
        validate_mcp_endpoint(origin)
        return f"https://{parsed.hostname.lower()}"
    except ValueError:
        raise BrowserRefused("BROWSER_DESTINATION_REFUSED") from None
