"""Fixed page and response budgets for Drive request discovery.

The owner scanner may request larger metadata pages. Ordinary live reads keep
their existing smaller limit; neither lane can request unbounded responses.
"""

from __future__ import annotations

import re

FILE_LIST_PAGE_SIZE_MAX = 100
OWNER_SEARCH_PAGE_SIZE_MAX = 1000
OWNER_SEARCH_METADATA_BYTES_MAX = 2 * 1024 * 1024

_PAGE_SIZE = re.compile(r"[1-9][0-9]{0,3}\Z")


def valid_file_list_page_size(value: object, *, owner_search_page: bool) -> bool:
    """Accept only canonical decimal Drive page sizes within the selected lane."""
    return (
        isinstance(value, str)
        and _PAGE_SIZE.fullmatch(value) is not None
        and int(value)
        <= (OWNER_SEARCH_PAGE_SIZE_MAX if owner_search_page else FILE_LIST_PAGE_SIZE_MAX)
    )
