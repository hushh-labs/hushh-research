"""Tests for open_navigation_route tool and navigation directive generation."""

from __future__ import annotations

import pytest

from hushh_mcp.one_adk import agent_tree
from hushh_mcp.one_adk.action_tools import open_navigation_route


@pytest.mark.asyncio
async def test_open_navigation_route_driving():
    """Default driving navigation produces sanitized Google and Apple Maps URLs."""
    result = await open_navigation_route("Pune International Airport (PNQ)")
    assert result["status"] == "ready"
    assert result["destination"] == "Pune International Airport (PNQ)"
    assert result["travel_mode"] == "driving"
    assert "destination=Pune+International+Airport+%28PNQ%29" in result["maps_url"]
    assert "travelmode=driving" in result["maps_url"]
    assert "daddr=Pune+International+Airport+%28PNQ%29" in result["apple_maps_url"]
    assert "dirflg=d" in result["apple_maps_url"]
    assert result["client_directive"] == "open_navigation"


@pytest.mark.asyncio
async def test_open_navigation_route_transit_and_walking():
    """Transit and walking modes set appropriate mode and URL parameters."""
    transit_result = await open_navigation_route("Mumbai Airport", mode="transit")
    assert transit_result["status"] == "ready"
    assert transit_result["travel_mode"] == "transit"
    assert "travelmode=transit" in transit_result["maps_url"]
    assert "dirflg=r" in transit_result["apple_maps_url"]

    walking_result = await open_navigation_route("Central Station", mode="walking")
    assert walking_result["status"] == "ready"
    assert walking_result["travel_mode"] == "walking"
    assert "travelmode=walking" in walking_result["maps_url"]
    assert "dirflg=w" in walking_result["apple_maps_url"]


@pytest.mark.asyncio
async def test_open_navigation_route_empty_destination():
    """Empty or whitespace destination returns a descriptive error without crashing."""
    result = await open_navigation_route("   ")
    assert result["status"] == "error"
    assert result["reason"] == "missing_destination"


@pytest.mark.asyncio
async def test_open_navigation_route_sanitization():
    """Control characters and injection artifacts are sanitized before URL construction."""
    raw_dest = "Pune\x00 Airport\x1f Hub"
    result = await open_navigation_route(raw_dest)
    assert result["status"] == "ready"
    assert result["destination"] == "Pune Airport Hub"
    assert "\x00" not in result["maps_url"]
    assert "\x1f" not in result["maps_url"]


def test_open_navigation_route_is_on_one_roster():
    """open_navigation_route is wired onto Agent One's tool roster."""
    roster = agent_tree._one_roster_tools(specialist_model="test-model")
    assert open_navigation_route in roster
