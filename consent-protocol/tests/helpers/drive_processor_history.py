"""Produce saved Drive rollout receipts using the actual recovery transaction."""

from sqlalchemy import text

from hushh_mcp.runtime_providers import managed_text


async def record_processor_history(store, monkeypatch, *, source, request_id, job, flash, carbon):
    if source in {"legacy_unbound", "carbon_at_creation", "other_carbon_at_creation"}:
        return None
    profiles = [None]
    if source in {"previously_migrated_flash", "previously_migrated_carbon", "other_flash_binding"}:
        version = (
            "another-drive-vertex-flash-binding"
            if source == "other_flash_binding"
            else "drive-vertex-flash-v2"
        )
        profiles.append({**flash, "version": version, "model": "gemini-3.8-flash"})
    if source == "previously_migrated_carbon":
        profiles.append(carbon)

    with store.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE drive_owner_search_jobs SET status='queued' WHERE job_id=:job"),
            {"job": job},
        )
    previous = None
    for profile in profiles:
        with monkeypatch.context() as historical:
            historical.delenv("HUSHH_UAT_MANAGED_AI_PROVIDER", raising=False)
            historical.setenv("HUSHH_UAT_MANAGED_TEXT_PROVIDER", "azure_openai")
            historical.setattr(managed_text, "load_drive_text_policy", lambda value=profile: value)
            assert await store.migrate_request_processor(user_id="owner", request_id=request_id)
        with store.db.engine.connect() as connection:
            row = store._row(
                connection,
                "SELECT * FROM drive_owner_search_jobs WHERE job_id=:job",
                {"job": job},
            )
            receipt = store._checkpoint(row)["processor_migration"]
        assert receipt.get("previous_migration") == previous
        if profile is None:
            assert receipt["to_binding"]["provider"] == "azure_openai"
        else:
            assert receipt["to_binding"]["deployment"] == profile["model"]
        previous = receipt
    return previous
