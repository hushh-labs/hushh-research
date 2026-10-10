"""RIA onboarding's scrape-status poll must be served by the production app.

The onboarding page polls GET /api/ria/crd-scrape-jobs/{job_id} after license
verification returns a scrape job, but api/routes/crd_scraper.py was only ever
registered in tests, so every poll was a 404 and scrape results never prefilled
the form. Only the authenticated status read is mounted: the module's create
endpoints start upstream work and carry no auth, so they stay unmounted.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from server import app

_STATUS = "/api/ria/crd-scrape-jobs/{job_id}"


def _served() -> set[tuple[str, str]]:
    served: set[tuple[str, str]] = set()
    for route in app.routes:
        for method in getattr(route, "methods", None) or ():
            served.add((method, getattr(route, "path", "")))
    return served


def test_production_app_serves_the_scrape_status_read():
    assert ("GET", _STATUS) in _served()


def test_production_app_does_not_serve_the_unauthenticated_create_endpoints():
    served = _served()
    assert ("POST", "/api/ria/crd-scrape-jobs") not in served
    assert ("POST", "/api/ria/financial-verification-jobs") not in served
    assert ("GET", "/api/ria/financial-verification-jobs/{job_id}") not in served


def test_scrape_status_read_requires_a_signed_in_caller():
    client = TestClient(app, raise_server_exceptions=False)
    response = client.get("/api/ria/crd-scrape-jobs/some-job")
    assert response.status_code == 401
