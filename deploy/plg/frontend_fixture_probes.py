"""Scoped private ingress and invalid-owner proxy observations."""

from __future__ import annotations
import json
from urllib.error import HTTPError
from urllib.request import Request, build_opener
import frontend_fixture_runtime as runtime
import frontend_release as release
import qualification_image as images


class Http:
    def request(self, url, *, token=None, method="GET", owner=False):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["X-Serverless-Authorization"] = "Bearer " + token
        if owner:
            # Deliberately invalid negative control, never an owner credential.
            headers["Authorization"] = "Bearer plg-qualification-invalid-owner"
        body = (
            runtime.encode(
                {
                    "enabled": False,
                    "frequency": "updates",
                    "expectedRevision": 0,
                    "disclosureVersion": "one-email-updates-v1",
                    "surface": "account",
                }
            )
            if method == "PUT"
            else None
        )
        request = Request(url, method=method, data=body, headers=headers)
        try:
            response = build_opener(images.NoRedirect()).open(request, timeout=45)
        except HTTPError as error:
            response = error
        except Exception:
            raise release.Refused("Fixture HTTP observation unavailable") from None
        with response:
            raw = response.read(65537)
            release.require(len(raw) <= 65536, "Fixture HTTP response oversized")
            return response.code, dict(response.headers.items()), raw


def probes(observation, backend_pair, frontend_token, backend_token, *, http=None):
    """Exercise private ingress and server proxy using an invalid owner only."""
    http = http or Http()
    from qualification_candidate import token_audience

    token_audience(frontend_token, observation["serviceUrl"])
    token_audience(backend_token, backend_pair["serviceUrl"])
    path = "/api/one/plg/preferences"
    release.require(
        http.request(observation["candidateUrl"] + path)[0] in {401, 403},
        "Fixture frontend publicly callable",
    )
    release.require(
        http.request(backend_pair["candidateUrl"] + "/health")[0] in {401, 403},
        "Fixture backend publicly callable",
    )
    outcomes = {}
    for method in ("GET", "PUT"):
        direct = http.request(
            backend_pair["candidateUrl"] + path,
            token=backend_token,
            method=method,
            owner=True,
        )
        proxied = http.request(
            observation["candidateUrl"] + path,
            token=frontend_token,
            method=method,
            owner=True,
        )
        headers = {key.lower(): value for key, value in proxied[1].items()}
        release.require(
            direct[0] == proxied[0] == 401
            and json.loads(direct[2]) == json.loads(proxied[2])
            and "no-store" in headers.get("cache-control", "")
            and headers.get("pragma") == "no-cache",
            "Fixture owner rejection or private proxy failed",
        )
        outcomes[method] = {
            "status": 401,
            "responseMatchesPrivateBackend": True,
            "noStore": True,
        }
    return {
        "kind": "plg-fixture-negative-owner-proxy-checks-v1",
        "privateIngress": True,
        "preferences": outcomes,
        "positiveOwnerPreferenceVerified": False,
        "customerSendingVerified": False,
        "productionTrafficAuthorized": False,
    }
