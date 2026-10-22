"""Finding the directory that holds a person's Azure, from who they signed in as."""

from __future__ import annotations

from hushh_mcp.services import azure_home_directory as home

_WORK = "44444444-4444-4444-4444-444444444444"
_DEFAULT = "8703ed52-8300-4535-980a-6a82a6a6c2eb"


class _Response:
    def __init__(self, status: int, issuer: str = "") -> None:
        self.status_code = status
        self._issuer = issuer

    def json(self) -> dict:
        return {"issuer": self._issuer}


class _Session:
    """Microsoft's public OpenID configuration, for the domains given."""

    def __init__(self, known: dict[str, str]) -> None:
        self.known = known
        self.urls: list[str] = []

    def get(self, url: str, timeout: float = 0) -> _Response:
        self.urls.append(url)
        for domain, tenant in self.known.items():
            if f"/{domain}/" in url:
                return _Response(200, f"https://login.microsoftonline.com/{tenant}/v2.0")
        return _Response(400)


def test_a_work_account_is_sent_to_its_own_directory_without_a_lookup():
    session = _Session({})
    assert home.home_directory({"tid": _WORK}, session=session) == _WORK
    assert session.urls == []


def test_a_personal_account_resolves_to_the_default_directory_azure_made_for_it():
    # Measured 2026-10-03: kushaltrivedi1711@gmail.com -> kushaltrivedi1711gmail.onmicrosoft.com.
    session = _Session({"kushaltrivedi1711gmail.onmicrosoft.com": _DEFAULT})
    claims = {"tid": home.CONSUMER_TENANT, "preferred_username": "KushalTrivedi1711@gmail.com"}
    assert home.home_directory(claims, session=session) == _DEFAULT


def test_a_personal_account_with_no_findable_directory_falls_back_to_asking():
    session = _Session({})
    claims = {"tid": home.CONSUMER_TENANT, "email": "someone@outlook.com"}
    assert home.home_directory(claims, session=session) is None
    assert session.urls  # it looked, and found nothing


def test_the_consumer_directory_itself_is_never_an_answer():
    session = _Session({"persongmail.onmicrosoft.com": home.CONSUMER_TENANT})
    claims = {"tid": home.CONSUMER_TENANT, "email": "person@gmail.com"}
    assert home.home_directory(claims, session=session) is None


def test_candidate_domains_follow_azures_naming_and_refuse_garbage():
    assert home.default_directory_domains("first.last+tag@gmail.com")[0] == (
        "firstlasttaggmail.onmicrosoft.com"
    )
    assert home.default_directory_domains("not-an-email") == []
    assert home.default_directory_domains("") == []


def test_a_lookup_failure_is_a_miss_not_a_crash():
    class Broken:
        def get(self, url: str, timeout: float = 0) -> _Response:
            raise ConnectionError("offline")

    claims = {"tid": home.CONSUMER_TENANT, "email": "person@gmail.com"}
    assert home.home_directory(claims, session=Broken()) is None
