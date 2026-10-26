"""Validate the metadata-only reminder projection committed with encrypted tasks."""

from datetime import datetime, timezone
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator


class TodoReminderItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    task_ref: UUID
    due_at: datetime

    @field_validator("due_at")
    @classmethod
    def aware_instant(cls, value: datetime) -> datetime:
        if value.tzinfo is None or not 2000 <= value.year <= 9998:
            raise ValueError("A reminder requires an absolute UTC instant")
        return value.astimezone(timezone.utc)


class TodoReminderSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid")
    items: list[TodoReminderItem] = Field(max_length=5000)

    @field_validator("items")
    @classmethod
    def unique_tasks(cls, value: list[TodoReminderItem]) -> list[TodoReminderItem]:
        if len({item.task_ref for item in value}) != len(value):
            raise ValueError("Duplicate reminder identity")
        return value


def reminder_projection(domain: str, projections: list[dict] | None) -> dict | None:
    matches = [
        item for item in projections or [] if item.get("projection_type") == "todo_reminders_v1"
    ]
    if not matches:
        return None
    if domain != "one_todos" or len(matches) != 1 or matches[0].get("projection_version", 1) != 1:
        raise ValueError("Invalid reminder projection")
    return TodoReminderSnapshot.model_validate(matches[0].get("payload")).model_dump(mode="json")
