"""Presentation of retained search results; never grant or payment authority.

Historical terminal requests are projected without rewriting their transactions.
Only bounded, owner/request-associated completed search counts establish a reason.
Missing evidence remains unknown rather than inventing an empty search.
"""


def request_outcome_view(row: dict, *, owner: bool = False) -> dict:
    if row.get("status") != "no_match" or row.get("outcome_search_status") != "completed":
        return {}
    if row.get("outcome_search_incomplete") is not False:
        return {}
    matched = row.get("outcome_search_matched")
    blocked = row.get("outcome_search_unshareable")
    if not all(type(value) is int and 0 <= value <= 10000 for value in (matched, blocked)):
        return {}
    if matched == 0 and blocked == 0:
        return {"outcomeReason": "no_matching_files"}
    if matched > 0 and blocked == matched:
        return {
            "outcomeReason": "matching_files_unshareable",
            **({"matchedFileCount": matched, "unshareableFileCount": blocked} if owner else {}),
        }
    return {}
