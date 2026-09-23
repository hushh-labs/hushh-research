"""The generic Drive path must never bypass selected-file connector policy."""

from fastapi.testclient import TestClient

from server import app


def test_legacy_one_drive_routes_are_not_mounted_or_documented():
    legacy_paths = [
        "/api/one/drive/connect/start",
        "/api/one/drive/connect/complete",
        "/api/one/drive/connect/native/start",
        "/api/one/drive/connect/native/complete",
        "/api/one/drive/status/synthetic-owner",
        "/api/one/drive/disconnect",
    ]
    documented = set(app.openapi()["paths"])
    assert not any(path.startswith("/api/one/drive") for path in documented)
    assert "/api/one/calendar/connect/start" in documented
    assert any(path.startswith("/api/connectors") for path in documented)

    client = TestClient(app)
    for path in legacy_paths:
        response = (
            client.get(path)
            if "/status/" in path
            else client.post(path, json={"user_id": "synthetic-owner"})
        )
        assert response.status_code == 404
