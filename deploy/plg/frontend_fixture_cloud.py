"""Bounded native IO for the one private Dev/UAT frontend fixture."""

from __future__ import annotations
import json
import re
from urllib.error import HTTPError
from urllib.request import Request, build_opener
import frontend_fixture_runtime as runtime
import frontend_release as release
import qualification_image as images

LIMIT = 4 * 1024 * 1024


class Cloud:
    def __init__(self, environment):
        release.require(environment in release.TARGETS, "Fixture environment invalid")
        self.environment, self.project = environment, release.TARGETS[environment]
        self.base = f"https://us-central1-run.googleapis.com/apis/serving.knative.dev/v1/namespaces/{self.project}/"
        self.gcloud = images.Cloud()

    def request(self, method, path, document=None, *, missing=False):
        release.require(
            (
                method == "GET"
                and (
                    path == "services/" + runtime.SERVICE
                    or re.fullmatch(
                        r"revisions/" + runtime.SERVICE + r"-q[0-9a-f]{12}", path
                    )
                )
            )
            or (method == "POST" and path == "services")
            or (method == "PUT" and path == "services/" + runtime.SERVICE),
            "Fixture provider request invalid",
        )
        token = self.gcloud.command("auth", "print-access-token").decode().strip()
        release.require(
            token and "\n" not in token, "Fixture provider identity unavailable"
        )
        raw = None if document is None else runtime.encode(document)
        release.require(
            raw is None or len(raw) <= LIMIT, "Fixture provider document oversized"
        )
        request = Request(
            self.base + path,
            data=raw,
            method=method,
            headers={
                "Authorization": "Bearer " + token,
                "Content-Type": "application/json",
            },
        )
        try:
            with build_opener(images.NoRedirect()).open(
                request, timeout=60
            ) as response:
                value = response.read(LIMIT + 1)
        except HTTPError as error:
            code = error.code
            error.close()
            if method == "GET" and missing and code == 404:
                return None
            raise release.Refused(
                "Fixture provider request refused; reconcile attempt"
            ) from None
        except Exception:
            raise release.Refused(
                "Fixture provider outcome uncertain; reconcile attempt"
            ) from None
        release.require(len(value) <= LIMIT, "Fixture provider response oversized")
        value = json.loads(value, object_pairs_hook=release.source.backend._json_pairs)
        release.require(isinstance(value, dict), "Fixture provider response invalid")
        return value

    def service(self, *, missing=False):
        return self.request("GET", "services/" + runtime.SERVICE, missing=missing)

    def revision(self, name, *, missing=False):
        return self.request("GET", "revisions/" + name, missing=missing)

    def policy(self):
        return self.gcloud.read(
            "run",
            "services",
            "get-iam-policy",
            runtime.SERVICE,
            "--project=" + self.project,
            "--region=us-central1",
        )
