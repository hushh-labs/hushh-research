"""Command metadata reads; the private agent retains its observations locally."""

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


class MetadataCommandReadOptions(CommandValue):
    """Hub-owned metadata selection only; no private or saved observations."""

    kind: Literal[
        "connections", "directory", "circles", "members", "settings", "shares", "requests", "links"
    ]
    query: str = Field(default="", max_length=160)
    reference: str = Field(default="", max_length=128)
    page: int = Field(default=1, ge=1, le=250, strict=True)
    limit: int = Field(default=20, ge=1, le=20, strict=True)


class _MetadataCommandReads(LocationCommandReadService):
    def _resolve(self, reference: str, kind: str) -> str:
        # The pod resolves its private candidate handle locally. The owning
        # Circle service still revalidates this resource id under the owner.
        if kind != "circle" or not reference:
            raise CommandReadInputError(
                "Read the current candidate list before selecting a reference."
            )
        return reference


async def read_metadata_command_projection(
    owner_id: str, options: MetadataCommandReadOptions
) -> dict:
    reads = _MetadataCommandReads(user_id=owner_id)
    projection = await reads.read(**options.model_dump())
    return {"projection": projection, "observations": reads.observations()}


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


_AUTO: Any = object()


class PodCommandReads(LocationCommandReadService):
    """Request-local handles; no mutable service or database may be constructed.

    On an owner-cloud agent (``feed`` resolves to the owner feed client) every read
    goes to the signed owner feed and the scope token never reaches a hub door.
    """

    def __init__(self, *, scope_token: str, client: Any = None, feed: Any = _AUTO, **kwargs: Any):
        super().__init__(**kwargs)
        self._scope_token = scope_token
        if feed is _AUTO:
            from hushh_mcp.services.pod_owner_feed_client import owner_feed_client

            feed = owner_feed_client()
        from hushh_mcp.services.pod_owner_cloud import owner_cloud_agent

        self._metadata_only = owner_cloud_agent() or feed is not None
        self._feed = feed
        self._hub = None if self._metadata_only else (client or PodHubClient())
        self._serial = asyncio.Lock()

    def _remote_read(self, options: CommandReadOptions) -> Any:
        if self._metadata_only:
            if self._feed is None:
                raise PodHubUnavailable("Owner feed command read unavailable")
            metadata = MetadataCommandReadOptions.model_validate(
                options.model_dump(exclude={"observations", "saved_observations"})
            )
            if metadata.kind == "members":
                metadata = metadata.model_copy(
                    update={"reference": self._resolve(metadata.reference, "circle")}
                )
            try:
                return self._feed.read(
                    "command", self.user_id, command=metadata.model_dump(mode="json")
                )
            except Exception as exc:  # noqa: BLE001 - one typed state, as the door
                raise PodHubUnavailable("Owner feed command read unavailable") from exc
        # Through the client's data door, so the request is signed and its
        # refusals fail loud exactly like every other specialist read.
        return self._hub.read_specialist(
            "location", self._scope_token, command_read=options.model_dump(mode="json")
        )

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
            value = await asyncio.to_thread(self._remote_read, options)
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
