"""Synthetic HTTP fixtures exercise metadata-only read boundaries."""

import io
import json
import sys
from pathlib import Path
from urllib.error import HTTPError

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "deploy/plg"))
import frontend_secret_inventory as module  # noqa: E402


class Response:
    def __init__(self, value):
        self.raw = json.dumps(value).encode()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        pass

    def read(self, limit):
        return self.raw[:limit]


def install(monkeypatch, *, project="hushh-pda-dev", mode="ok"):
    monkeypatch.setenv("CLOUDSDK_AUTH_ACCESS_TOKEN", "synthetic-token")
    calls = []

    class Opener:
        def open(self, request, timeout):
            assert timeout == 30 and request.get_method() == "GET"
            url = request.full_url
            calls.append(url)
            assert ":access" not in url and "?" not in url
            if "cloudresourcemanager" in url:
                return Response({"projectId": project, "projectNumber": "123456789"})
            secret = url.split("/secrets/")[1].split("/")[0]
            optional = secret in module.pins.catalog("dev")[1]
            if optional and mode in {"absent", "denied"}:
                code = 404 if mode == "absent" else 403
                raise HTTPError(url, code, "failure", {}, io.BytesIO(b"sensitive diagnostic"))
            number = "999" if mode == "wrong_project" else "123456789"
            state = "DISABLED" if mode == "disabled" else "ENABLED"
            return Response(
                {"name": f"projects/{number}/secrets/{secret}/versions/7", "state": state}
            )

    monkeypatch.setattr(module, "build_opener", lambda *_args: Opener())
    return calls


def test_metadata_snapshot_binds_provider_project_number_and_no_payload(monkeypatch):
    calls = install(monkeypatch, mode="absent")
    result = module.snapshot("dev")
    assert (
        result["inventory"]["BACKEND_URL"]["name"]
        == "projects/hushh-pda-dev/secrets/BACKEND_URL/versions/7"
    )
    assert result["inventory"]["NEXT_PUBLIC_GOOGLE_SIGN_IN_CLIENT_ID"] is None
    assert not result["snapshotAtomic"] and not result["environmentAccepted"]
    assert not result["buildConsumptionVerified"] and not result["productionTrafficAuthorized"]
    assert all(":access" not in url for url in calls)
    assert len(calls) == 1 + 2 * len(result["inventory"])


@pytest.mark.parametrize("mode", ["denied", "wrong_project", "disabled"])
def test_denied_wrong_project_and_disabled_are_not_absence(monkeypatch, mode):
    install(monkeypatch, mode=mode)
    with pytest.raises(module.Refused):
        module.snapshot("dev")


def test_changed_metadata_fails_closed(monkeypatch):
    install(monkeypatch)
    client = module.MetadataClient("dev")
    original = client.latest
    calls = 0

    def racing(name, *, optional):
        nonlocal calls
        calls += 1
        result = original(name, optional=optional)
        if calls > len(module.pins.catalog("dev")[0] | module.pins.catalog("dev")[1]):
            result["name"] = result["name"].replace("/7", "/8")
        return result

    monkeypatch.setattr(client, "latest", racing)
    with pytest.raises(module.Refused, match="changed"):
        module.snapshot("dev", client=client)


def test_unapproved_secret_name_and_endpoint_are_rejected(monkeypatch):
    install(monkeypatch)
    client = module.MetadataClient("dev")
    with pytest.raises(module.Refused):
        client.latest("UNREVIEWED", optional=True)
    with pytest.raises(module.Refused):
        client._get("secretmanager", "projects/hushh-pda-dev/secrets/BACKEND_URL/versions/7:access")


def test_fixture_client_refuses_shared_backend_and_mismatched_snapshot(monkeypatch):
    calls = install(monkeypatch)
    client = module.MetadataClient("dev", fixture_backend=True)
    count = len(calls)
    with pytest.raises(module.Refused):
        client.latest("BACKEND_URL", optional=False)
    with pytest.raises(module.Refused):
        module.snapshot("dev", client=client, fixture_backend=False)
    assert len(calls) == count
    result = module.snapshot("dev", client=client, fixture_backend=True)
    assert result["fixtureBackend"]
    assert "BACKEND_URL" not in result["inventory"]
    assert module.pins.FIXTURE_BACKEND in result["inventory"]
