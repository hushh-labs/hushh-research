"""The one property contact sync is built around, as code instead of prose.

A raw phone number belonging to somebody who is **not** a Hushh user must never
reach a Hushh server. The device normalizes to E.164, hashes on-device, and
sends only `{hash, last4}`; `match_marketplace_contacts` persists nothing, so a
contact who does not match leaves no trace anywhere.

Until this file, that property lived only in comments
(`lib/marketplace/contact-matching.ts:13-18`,
`lib/contacts/phone-normalization.ts:1-19`). Comments do not fail a build.

The specific thing being guarded: adding Google Contacts as a source for web is
about twenty lines if the backend calls the People API — it reuses
`GoogleConnectionService.access_token`, needs no public client id, no JS
origins, and no Capacitor gate. It would read as a simplification in review. It
also puts the phone number of every non-user in somebody's address book onto our
servers. This test is what turns that from a judgement call into a failing test.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

#: Directories that make up the deployed backend. Tests and scripts are excluded
#: on purpose — this file itself names the forbidden host, and a fixture may
#: legitimately need to.
_SERVER_TREES = ("hushh_mcp", "api", "mcp_modules")


def _server_python_files() -> list[Path]:
    files: list[Path] = []
    for tree in _SERVER_TREES:
        root = REPO_ROOT / tree
        if not root.is_dir():
            continue
        files.extend(path for path in root.rglob("*.py") if "__pycache__" not in path.parts)
    return files


def test_no_server_module_talks_to_the_people_api():
    """The backend must not read anybody's Google address book.

    The scope declaration is allowed to exist -- `google_connection_service.py`
    is the single source of truth for what each Google service means, and the
    browser reads that string to ask for the same thing. What is forbidden is a
    server-side CALL: the moment one exists, non-users' phone numbers are on our
    infrastructure and the entire design collapses into "we upload your contacts".
    """

    offenders: list[str] = []
    for path in _server_python_files():
        text = path.read_text(encoding="utf-8", errors="ignore")
        if "people.googleapis.com" not in text:
            continue
        offenders.append(str(path.relative_to(REPO_ROOT)))

    assert not offenders, (
        "A backend module references the Google People API: "
        + ", ".join(offenders)
        + ". Contact reads happen in the browser so a non-user's phone number "
        "never reaches a Hushh server. See tests/test_contacts_never_reach_the_server.py."
    )


def test_the_contacts_scope_is_declared_but_never_exchanged_for_a_token():
    """`contacts` may be a declared GoogleService. It may not be an authenticated caller.

    `GoogleConnectionService.access_token(service=...)` returns an account-wide
    Google token -- the refresh grant carries `include_granted_scopes: "true"`,
    so it accumulates every scope the user has ever granted, including Calendar
    write. Nothing may request one for contacts.
    """

    service_path = REPO_ROOT / "hushh_mcp" / "services" / "google_connection_service.py"
    source = service_path.read_text(encoding="utf-8")

    # The declaration is expected, and is what the browser flow reads.
    assert '"contacts"' in source, (
        "the contacts scope declaration disappeared -- the browser flow reads it "
        "as the source of truth for which scope to request"
    )

    callers: list[str] = []
    for path in _server_python_files():
        if path == service_path:
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        if "access_token" not in text:
            continue
        for match in re.finditer(r"access_token\s*\(([^)]*)\)", text, re.S):
            if "contacts" in match.group(1):
                callers.append(str(path.relative_to(REPO_ROOT)))

    assert not callers, (
        "Something asks for a Google access token scoped to contacts: "
        + ", ".join(callers)
        + ". That token is account-wide, and the contacts read belongs in the browser."
    )


def test_the_match_endpoint_still_stores_nothing():
    """No write on the matching path, so a non-user leaves no trace.

    Guarded at the source rather than behaviourally because the endpoint has no
    DB harness: the assertion is that the function body contains no statement
    that could write. A future INSERT here would be the other way this property
    is lost -- not by reading more, but by remembering what was read.
    """

    import inspect

    from hushh_mcp.services.ria_iam_service import RIAIAMService

    for matcher in (
        RIAIAMService.match_marketplace_contacts,
        RIAIAMService.match_one_network_contact_lookups_exact,
    ):
        lowered = inspect.getsource(matcher).lower()
        for statement in ("insert into", "update ", "delete from"):
            assert statement not in lowered, (
                f"{matcher.__name__} contains {statement!r}. The matching path "
                "persists nothing; a contact who is not a Hushh user must leave "
                "no trace."
            )
