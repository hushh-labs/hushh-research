"""Compatibility entrypoint for the shared organizing-index inventory."""

from hushh_mcp.services.drive_group_index_job import DriveGroupIndexJob
from hushh_mcp.services.drive_groups.inventory import LocalInventory
from hushh_mcp.services.drive_groups.inventory import load_inventory as _load_inventory


async def load_inventory(reads, user, *, saved=None) -> LocalInventory:
    return await _load_inventory(reads, user, saved=saved, listing=DriveGroupIndexJob.list_files)
