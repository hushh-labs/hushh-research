"""Strict in-memory Azure native API fixture; never a cloud/browser executor."""

import asyncio
import copy
import json
import time

import httpx

from hushh_mcp.services.pod_browser import azure_probe as probe

AUTH_MARKER = "synthetic.host.only.token"


class Credential:
    def __init__(self, *, expired=False):
        self.scopes = []
        self.expired = expired

    async def get_token(self, scope):
        self.scopes.append(scope)
        return probe.AzureAccessToken(
            token=AUTH_MARKER,
            expires_at=int(time.time()) + (-1 if self.expired else 3600),
        )


class NativeAPI:
    def __init__(self, *, change=None, lose=None, inventory=None, exec_response=None):
        self.change, self.lose, self.inventory = change, lose, inventory
        self.exec_response = exec_response
        self.requests = []
        self.document = None
        self.deleted = False
        self.exec_started = asyncio.Event()
        self.hold_exec = False
        self.gets = 0

    async def __call__(self, request):
        self.requests.append(request)
        path = request.url.path
        if request.method == "POST" and path.endswith("/sandboxes"):
            self.document = {**json.loads(request.content), "id": "synthetic-1", "state": "Running"}
            if self.lose == "create":
                raise httpx.ReadError("synthetic lost response")
            return httpx.Response(201, json=self.document)
        if request.method == "DELETE":
            assert path.endswith("/synthetic-1")
            self.deleted = True
            if self.lose == "delete":
                raise httpx.ReadError("synthetic lost delete response")
            return httpx.Response(202)
        if request.method == "GET" and path.endswith("/sandboxes"):
            assert (
                request.url.params["labels"]
                == "hushhProbe=" + self.document["labels"]["hushhProbe"]
            )
            return httpx.Response(
                200,
                json=self.inventory if self.inventory is not None else {"value": [self.document]},
            )
        if request.method == "GET":
            if self.deleted:
                return httpx.Response(404)
            self.gets += 1
            value = copy.deepcopy(self.document)
            if self.change:
                self.change(value, self.gets)
            return httpx.Response(200, json=value)
        if request.method == "POST":
            assert path.endswith("/executeShellCommand")
            assert request.url.params["containerName"] == probe._CONTAINER_NAME
            assert json.loads(request.content) == {
                "command": probe._COMMAND,
            }
            self.exec_started.set()
            if self.hold_exec:
                await asyncio.Future()
            if self.lose == "exec":
                raise httpx.ReadError("synthetic lost execution response")
            return httpx.Response(
                200,
                json=self.exec_response
                if self.exec_response is not None
                else {"exitCode": 0, "stdout": probe._MARKER, "stderr": "", "executionTimeMs": 1},
            )
        raise AssertionError("Unexpected native request")
