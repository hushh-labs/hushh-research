"""Bounded nearby discovery with replaceable provider and normalization ports."""

from __future__ import annotations

import asyncio
import math
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from hushh_mcp.services import place_taxonomy
from hushh_mcp.services.place_geometry import distance_meters, offset_coordinates

Place = dict[str, Any]
Query = tuple[float, float, float, tuple[str, ...] | None]
Batch = tuple[Query, list[Place]]
Fetch = Callable[[Query], Awaitable[list[Place]]]
Normalize = Callable[[Place], Place | None]


@dataclass(frozen=True)
class DiscoveryLimits:
    radius: float
    result_limit: int
    max_queries: int
    max_depth: int
    concurrency: int
    timeout_seconds: float


@dataclass(frozen=True)
class DiscoveryResult:
    places: list[Place]
    received_response: bool
    incomplete: bool
    failures: int


async def _run_batch(
    queries: list[Query], fetch: Fetch, semaphore: asyncio.Semaphore, deadline: float
) -> tuple[list[Batch], int]:
    async def bounded_fetch(query: Query) -> list[Place]:
        async with semaphore:
            return await fetch(query)

    tasks = [asyncio.create_task(bounded_fetch(query)) for query in queries]
    failures = 0
    try:
        done, pending = await asyncio.wait(
            tasks, timeout=max(0.0, deadline - asyncio.get_running_loop().time())
        )
        failures += len(pending)
        completed = [
            (query, task.result())
            for query, task in zip(queries, tasks, strict=True)
            if task in done and not task.cancelled() and task.exception() is None
        ]
    finally:
        # Preserve completed batches, and settle every task before the caller's
        # provider client closes, including cancellation of this discovery run.
        for task in tasks:
            if task.done() and not task.cancelled() and task.exception() is not None:
                failures += 1
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
    return completed, failures


def _refinement_queries(
    frontier: list[Batch], lat: float, lng: float, limits: DiscoveryLimits
) -> list[Query]:
    queries = []
    for (query_lat, query_lng, radius, types), batch in frontier:
        if len(batch) < limits.result_limit:
            continue
        # Four overlapping circles cover their parent. Only query children
        # intersecting the original allowed area; normalization enforces it.
        child_radius = radius / math.sqrt(2) + 0.1
        for bearing in (45, 135, 225, 315):
            child_lat, child_lng = offset_coordinates(
                query_lat, query_lng, radius / math.sqrt(2), bearing
            )
            separation = distance_meters(
                origin_lat=lat,
                origin_lng=lng,
                destination_lat=child_lat,
                destination_lng=child_lng,
            )
            if separation <= limits.radius + child_radius:
                queries.append((child_lat, child_lng, child_radius, types))
    return queries


async def _sweep(
    initial_queries: list[Query], fetch: Fetch, lat: float, lng: float, limits: DiscoveryLimits
) -> tuple[list[Batch], bool, bool, int]:
    semaphore = asyncio.Semaphore(limits.concurrency)
    deadline = asyncio.get_running_loop().time() + limits.timeout_seconds
    initial, failures = await _run_batch(initial_queries, fetch, semaphore, deadline)
    batches = list(initial)
    frontier = initial
    remaining = max(0, limits.max_queries - len(initial_queries))
    coverage_limited = False
    for _depth in range(limits.max_depth):
        queries = _refinement_queries(frontier, lat, lng, limits)
        if not queries:
            frontier = []
            break
        if len(queries) > remaining:
            coverage_limited = True
        queries = queries[:remaining]
        if not queries or asyncio.get_running_loop().time() >= deadline:
            coverage_limited = True
            break
        frontier, batch_failures = await _run_batch(queries, fetch, semaphore, deadline)
        failures += batch_failures
        batches.extend(frontier)
        remaining -= len(queries)
    coverage_limited |= any(len(batch) >= limits.result_limit for _query, batch in frontier)
    return batches, bool(initial), coverage_limited, failures


def _place_types(place: Place) -> list[str]:
    """Every type Google reported, primary first, de-duplicated."""

    ordered: list[str] = []
    seen: set[str] = set()
    for raw in (place.get("primaryType"), *(place.get("types") or [])):
        if not isinstance(raw, str):
            continue
        value = raw.strip()[:80]
        if not value or value in seen:
            continue
        seen.add(value)
        ordered.append(value)
    return ordered


def _merge_place(existing: Place, place: Place, normalize: Normalize) -> None:
    # Classify combined provider evidence once. Unioning classified chips
    # would let vague lodging defeat a later precise restaurant type.
    types = list(dict.fromkeys([*_place_types(existing), *_place_types(place)]))
    if normalize(existing) is None and normalize(place) is not None:
        existing.update(place)
    for field, value in place.items():
        if not existing.get(field) and value is not None:
            existing[field] = value
    primary = place.get("primaryType")
    if (
        primary
        and primary not in place_taxonomy.VAGUE_TYPES
        and (
            not existing.get("primaryType")
            or existing.get("primaryType") in place_taxonomy.VAGUE_TYPES
        )
    ):
        existing["primaryType"] = primary
        existing["primaryTypeDisplayName"] = place.get("primaryTypeDisplayName")
    existing["types"] = types


def _normalize_batches(batches: list[Batch], normalize: Normalize, category: str) -> list[Place]:
    sources: dict[str, Place] = {}
    for _query, batch in batches:
        for place in batch:
            place_id = str(place.get("id") or "").strip()
            existing = sources.get(place_id)
            if existing is None:
                sources[place_id] = dict(place)
            else:
                _merge_place(existing, place, normalize)
    merged = []
    for place in sources.values():
        normalized = normalize(place)
        if normalized is not None and (category == "all" or category in normalized["categories"]):
            merged.append(normalized)
    return sorted(
        merged,
        key=lambda item: (item["distanceMeters"], str(item["name"]).casefold(), item["placeId"]),
    )


async def discover_nearby_places(
    *,
    lat: float,
    lng: float,
    category: str,
    type_groups: list[tuple[str, ...] | None],
    fetch: Fetch,
    normalize: Normalize,
    limits: DiscoveryLimits,
) -> DiscoveryResult:
    chunks = [
        chunk
        for group in type_groups
        for chunk in (
            [None] if group is None else [group[i : i + 50] for i in range(0, len(group), 50)]
        )
    ]
    initial_queries = [(lat, lng, limits.radius, types) for types in chunks]
    batches, received, limited, failures = await _sweep(initial_queries, fetch, lat, lng, limits)
    return DiscoveryResult(
        places=_normalize_batches(batches, normalize, category),
        received_response=received,
        incomplete=bool(failures) or limited,
        failures=failures,
    )
