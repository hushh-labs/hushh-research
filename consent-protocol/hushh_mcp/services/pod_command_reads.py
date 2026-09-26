"""Bounded command observations through the existing authenticated hub broker."""

from __future__ import annotations

import asyncio
import json
from typing import Any, Literal

from pydantic import Field

from hushh_mcp.operons.location.plan import CommandValue
from hushh_mcp.operons.location.references import LocationObservation, fresh_observations
from hushh_mcp.services.location_command_reads import (
    CommandReadInputError,
    LocationCommandReadService,
)
from hushh_mcp.services.pod_hub_client import PodHubClient, PodHubUnavailable


class CommandReadOptions(CommandValue):
    kind: Literal[
        "connections",
        "directory",
        "circles",
        "members",
        "settings",
        "shares",
        "requests",
        "links",
        "nearby",
    ]
    query: str = Field(default="", max_length=160)
    reference: str = Field(default="", max_length=128)
    page: int = Field(default=1, ge=1, le=250, strict=True)
    limit: int = Field(default=20, ge=1, le=20, strict=True)
    observations: list[LocationObservation] = Field(default_factory=list, max_length=50)
    saved_observations: list[LocationObservation] = Field(default_factory=list, max_length=50)


async def read_command_projection(owner_id: str, options: CommandReadOptions) -> dict:
    reads = LocationCommandReadService(
        user_id=owner_id,
        observations=options.observations,
        saved_observations=options.saved_observations,
    )
    projection = await reads.read(
        **options.model_dump(exclude={"observations", "saved_observations"})
    )
    return {"projection": projection, "observations": reads.observations()}


class PodCommandReads(LocationCommandReadService):
    """Request-local handles; no mutable service or database may be constructed."""

    def __init__(self, *, scope_token: str, client: Any = None, **kwargs: Any):
        super().__init__(**kwargs)
        self._scope_token = scope_token
        self._hub = client or PodHubClient()
        self._serial = asyncio.Lock()

    def _services(self):
        raise RuntimeError("Pod command reads cannot construct database services")

    async def read(self, kind: str, **kwargs: Any) -> dict[str, Any]:
        async with self._serial:
            selected = self.observations(
                {kwargs["reference"]} if kwargs.get("reference") else set()
            )
            options = CommandReadOptions(
                kind=kind,
                **kwargs,
                observations=[
                    item for item in selected if item["reference"] not in self._saved_handles
                ],
                saved_observations=[
                    item for item in selected if item["reference"] in self._saved_handles
                ],
            )
            self._calls += 1
            if self._calls > 10:
                raise CommandReadInputError("The command read budget is exhausted.")
            if kind == "nearby":
                places = [
                    item
                    for item in self.semantic_observations()
                    if item["kind"] == "place"
                    and item["observation_status"] == "recent_observation"
                ]
                return (
                    {"status": "observed", "items": places[:10]}
                    if places
                    else {
                        "status": "needs_client_observation",
                        "reason": "Run the authored Nearby search to obtain current provider results.",
                    }
                )
            response = await asyncio.to_thread(
                self._hub.post,
                "/api/one/pod/specialist/location/read",
                json={
                    "scopeToken": self._scope_token,
                    "commandRead": options.model_dump(mode="json"),
                },
            )
            if response.status_code != 200:
                raise PodHubUnavailable("Command read authority is unavailable")
            value = response.json().get("state")
            if (
                not isinstance(value, dict)
                or len(json.dumps(value)) > 64_000
                or not isinstance(value.get("projection"), dict)
            ):
                raise PodHubUnavailable("Invalid command read projection")
            observations = [
                LocationObservation.model_validate(item) for item in value.get("observations", [])
            ]
            observations = fresh_observations(observations)
            merged = {
                **self.references,
                **{
                    item.reference: item.model_dump(mode="json", exclude={"reference"})
                    for item in observations
                },
            }
            if len(merged) > self._imported_count + 50:
                raise CommandReadInputError("Narrow the request before reading more candidates.")
            self.references = merged
            self._saved_handles -= {item.reference for item in observations}
            return value["projection"]
