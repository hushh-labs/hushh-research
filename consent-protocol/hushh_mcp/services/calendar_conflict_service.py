"""One reviewed, account-bound keep/decline plan using existing RSVP/Mail ledgers.

Provider operations cannot be atomic. Each child attendance review is claimed
once and replay-safe; the compound token only orders those claims and reports
their independent Calendar and Mail outcomes.
"""

from __future__ import annotations

import secrets
from datetime import UTC, datetime, timedelta
from typing import Any

from hushh_mcp.services.calendar_account_board_service import (
    CalendarAccountBoardService,
    account_schedule,
)
from hushh_mcp.services.calendar_schedule_service import CalendarScheduleService
from hushh_mcp.services.google_connection_service import GoogleConnectionError

MAX_CONFLICT_REVIEW_TOKEN_LENGTH = 200_000


def _ref_key(ref: dict[str, str]) -> tuple[str, str, str]:
    return ref["account_id"], ref["calendar_id"], ref["event_id"]


def _incident(board: dict[str, Any], keep: dict[str, str]) -> set[tuple[str, str, str]]:
    focus = _ref_key(keep)
    return {
        _ref_key(pair["right"] if _ref_key(pair["left"]) == focus else pair["left"])
        for pair in board["conflicts"]
        if focus in (_ref_key(pair["left"]), _ref_key(pair["right"]))
    }


def _event(board: dict[str, Any], ref: dict[str, str]) -> tuple[dict[str, Any], dict[str, Any]]:
    account = next(
        (item for item in board["accounts"] if item["account_id"] == ref["account_id"]), None
    )
    if not account or account["status"] != "complete":
        raise GoogleConnectionError("Refresh the selected Calendar account", status_code=409)
    event = next(
        (
            item
            for item in account["events"]
            if item["calendar_id"] == ref["calendar_id"] and item["id"] == ref["event_id"]
        ),
        None,
    )
    if not event or not event.get("etag"):
        raise GoogleConnectionError(
            "The selected meeting changed. Refresh the board.", status_code=409
        )
    return account, event


def _response(event: dict[str, Any], account_email: str) -> str:
    for attendee in event.get("attendees") or []:
        if str(attendee.get("email") or "").casefold() == account_email.casefold():
            return str(attendee.get("response_status") or "needsAction")
    return "owned"


class CalendarConflictService:
    def __init__(self, board: CalendarAccountBoardService | None = None) -> None:
        self.board = board or CalendarAccountBoardService()

    async def review(
        self,
        *,
        user_id: str,
        date: str,
        time_zone: str,
        keep: dict[str, str],
        decline: list[dict[str, Any]],
    ) -> dict[str, Any]:
        if (
            not decline
            or len(decline) > 2
            or len({_ref_key(item) for item in decline}) != len(decline)
        ):
            raise GoogleConnectionError(
                "Select one or two different invitations to decline", status_code=422
            )
        if _ref_key(keep) in {_ref_key(item) for item in decline}:
            raise GoogleConnectionError("The kept meeting cannot also be declined", status_code=422)
        snapshot = await self.board.day(user_id=user_id, date=date, time_zone=time_zone)
        if not snapshot["complete"] or not snapshot["conflicts_complete"]:
            raise GoogleConnectionError(
                "Refresh every Calendar account before resolving conflicts", status_code=409
            )
        incident = _incident(snapshot, keep)
        if not incident or not {_ref_key(item) for item in decline} <= incident:
            raise GoogleConnectionError(
                "The conflict changed. Review the board again.", status_code=409
            )
        kept_account, kept_event = _event(snapshot, keep)
        kept_binding = await account_schedule(
            keep["account_id"], self.board.connections
        )._read_binding(user_id)
        kept_response = _response(kept_event, kept_account["google_email"])
        if kept_response == "declined":
            raise GoogleConnectionError("The chosen meeting was already declined", status_code=409)
        children = []
        if kept_response == "needsAction" and kept_event.get("can_decline"):
            accepted = await account_schedule(keep["account_id"], self.board.connections).review(
                user_id=user_id,
                event_id=keep["event_id"],
                calendar_id=keep["calendar_id"],
                response_status="accepted",
                expected_account_email=kept_account["google_email"],
                date=date,
                time_zone=time_zone,
            )
            children.append({"kind": "keep", "ref": keep, "review": accepted})
        elif kept_response not in {"accepted", "owned"}:
            raise GoogleConnectionError(
                "This meeting cannot be kept from this Calendar account", status_code=403
            )
        previews = [
            {
                "kind": "keep",
                "ref": keep,
                "title": kept_event["title"],
                "account_email": kept_account["google_email"],
                "start": kept_event["start"],
                "end": kept_event["end"],
                "action": "accept" if children else "leave unchanged",
            }
        ]
        for choice in decline:
            account, event = _event(snapshot, choice)
            if (
                not event.get("can_decline")
                or _response(event, account["google_email"]) == "declined"
            ):
                raise GoogleConnectionError(
                    "The selected invitation cannot be declined", status_code=403
                )
            message = str(choice.get("message") or "").strip()
            if not message:
                raise GoogleConnectionError(
                    "Write a note for each organizer before review", status_code=422
                )
            prepared = await account_schedule(choice["account_id"], self.board.connections).review(
                user_id=user_id,
                event_id=choice["event_id"],
                calendar_id=choice["calendar_id"],
                response_status="declined",
                send_message=True,
                message=message,
                decline_reason=str(choice.get("reason") or ""),
                expected_account_email=account["google_email"],
                date=date,
                time_zone=time_zone,
            )
            if not prepared.get("recipient") or not prepared.get("sender_label"):
                raise GoogleConnectionError(
                    "Mail could not prepare the organizer note", status_code=409
                )
            if (
                prepared.get("title") != event["title"]
                or prepared.get("start") != event["start"]
                or prepared.get("end") != event["end"]
                or str(prepared["recipient"]).casefold()
                != str((event.get("organizer") or {}).get("email") or "").casefold()
            ):
                raise GoogleConnectionError(
                    "The invitation changed while Mail was prepared. Refresh Calendar and review it again.",
                    status_code=409,
                )
            children.append(
                {
                    "kind": "decline",
                    "ref": {key: choice[key] for key in ("account_id", "calendar_id", "event_id")},
                    "review": prepared,
                }
            )
            previews.append(
                {
                    "kind": "decline",
                    "ref": children[-1]["ref"],
                    "title": event["title"],
                    "account_email": account["google_email"],
                    "start": event["start"],
                    "end": event["end"],
                    "recipient": prepared["recipient"],
                    "sender_label": prepared["sender_label"],
                    "subject": prepared["subject"],
                    "message": prepared["message"],
                    "action": "decline and send note",
                }
            )
        review_id = secrets.token_urlsafe(24)
        expires = datetime.now(UTC) + timedelta(minutes=10)
        plan = {
            "user_id": user_id,
            "review_id": review_id,
            "expires": expires.timestamp(),
            "date": date,
            "time_zone": time_zone,
            "keep": keep,
            "kept_binding": list(kept_binding),
            "kept_start": kept_event["start"],
            "kept_end": kept_event["end"],
            "kept_etag": kept_event["etag"],
            "incident": [list(ref) for ref in sorted(incident)],
            "children": [
                {
                    "kind": child["kind"],
                    "ref": child["ref"],
                    "review_id": child["review"]["review_id"],
                    "review_token": child["review"]["review_token"],
                }
                for child in children
            ],
        }
        review_token = CalendarScheduleService._seal(plan, "calendar-conflict-v1")
        if len(review_token) > MAX_CONFLICT_REVIEW_TOKEN_LENGTH:
            raise GoogleConnectionError(
                "The organizer notes are too long for one conflict review. Shorten them and review again.",
                status_code=422,
            )
        return {
            "review_id": review_id,
            "review_token": review_token,
            "expires_at": expires.isoformat(),
            "previews": previews,
        }

    async def confirm(self, *, user_id: str, review_id: str, review_token: str) -> dict[str, Any]:
        plan = CalendarScheduleService._open(
            review_token,
            "calendar-conflict-v1",
            max_length=MAX_CONFLICT_REVIEW_TOKEN_LENGTH,
        )
        if plan["user_id"] != user_id or plan["review_id"] != review_id:
            raise GoogleConnectionError("This review belongs to another account", status_code=403)
        snapshot = await self.board.day(
            user_id=user_id, date=plan["date"], time_zone=plan["time_zone"]
        )
        if not snapshot["complete"] or not snapshot["conflicts_complete"]:
            raise GoogleConnectionError(
                "Refresh every Calendar account before confirming", status_code=409
            )
        current_incident = _incident(snapshot, plan["keep"])
        if current_incident - {tuple(ref) for ref in plan["incident"]}:
            raise GoogleConnectionError(
                "A new conflict appeared. Review the board again.", status_code=409
            )
        keep_account, keep_event = _event(snapshot, plan["keep"])
        keep_schedule = account_schedule(plan["keep"]["account_id"], self.board.connections)
        if tuple(plan["kept_binding"]) != await keep_schedule._read_binding(user_id):
            raise GoogleConnectionError(
                "The kept Calendar account changed. Review again.", status_code=409
            )
        if keep_event["start"] != plan["kept_start"] or keep_event["end"] != plan["kept_end"]:
            raise GoogleConnectionError(
                "The kept meeting time changed. Review again.", status_code=409
            )
        keep_child = next((child for child in plan["children"] if child["kind"] == "keep"), None)
        if not keep_child and keep_event["etag"] != plan["kept_etag"]:
            raise GoogleConnectionError("The kept meeting changed. Review again.", status_code=409)
        if keep_child:
            keep_state = await keep_schedule._sql(
                "SELECT state FROM calendar_attendance_reviews WHERE review_id = :review_id AND user_id = :user_id",
                {"review_id": keep_child["review_id"], "user_id": user_id},
            )
            if keep_state.data and keep_state.data[0].get("state") == "complete":
                if _response(keep_event, keep_account["google_email"]) != "accepted":
                    raise GoogleConnectionError(
                        "The kept meeting changed. Review again.", status_code=409
                    )
        # Preflight all unclaimed children before any mutation. Completed child
        # reviews are replayed without another provider write.
        for child in plan["children"]:
            schedule = account_schedule(child["ref"]["account_id"], self.board.connections)
            rows = await schedule._sql(
                "SELECT state FROM calendar_attendance_reviews WHERE review_id = :review_id AND user_id = :user_id",
                {"review_id": child["review_id"], "user_id": user_id},
            )
            if rows.data and rows.data[0].get("state") == "complete":
                continue
            sealed = CalendarScheduleService._open(child["review_token"], "calendar-review-v1")
            await schedule.calendar._check_read_binding(user_id, tuple(sealed["binding"]))
            current, patch, _ = await schedule._event(
                user_id,
                sealed["event_id"],
                sealed["calendar_id"],
                tuple(sealed["binding"]),
                sealed["response_status"],
            )
            if current["etag"] != sealed["etag"] or patch != sealed["patch"]:
                raise GoogleConnectionError(
                    "An invitation changed. Review the board again.", status_code=409
                )
        results = []
        if not keep_child:
            results.append(
                {"kind": "keep", "ref": plan["keep"], "calendar": "kept", "email": "not_sent"}
            )
        for child in plan["children"]:
            schedule = account_schedule(child["ref"]["account_id"], self.board.connections)
            try:
                if child["kind"] == "decline":
                    fresh = await self.board.day(
                        user_id=user_id, date=plan["date"], time_zone=plan["time_zone"]
                    )
                    if not fresh["complete"] or not fresh["conflicts_complete"]:
                        raise GoogleConnectionError(
                            "Calendar changed. Review again before declining.", status_code=409
                        )
                    if tuple(plan["kept_binding"]) != await keep_schedule._read_binding(user_id):
                        raise GoogleConnectionError(
                            "The kept Calendar account changed. Review again.", status_code=409
                        )
                    current_keep_account, current_keep = _event(fresh, plan["keep"])
                    if (
                        current_keep["start"] != plan["kept_start"]
                        or current_keep["end"] != plan["kept_end"]
                    ):
                        raise GoogleConnectionError(
                            "The kept meeting time changed. Review again.", status_code=409
                        )
                    if _response(current_keep, current_keep_account["google_email"]) not in {
                        "accepted",
                        "owned",
                    }:
                        raise GoogleConnectionError(
                            "The kept meeting is no longer accepted. Review again.", status_code=409
                        )
                    if _ref_key(child["ref"]) not in _incident(fresh, plan["keep"]):
                        # A completed decline leaves the conflict graph.
                        prior = await schedule._sql(
                            "SELECT state FROM calendar_attendance_reviews WHERE review_id = :review_id AND user_id = :user_id",
                            {"review_id": child["review_id"], "user_id": user_id},
                        )
                        if not prior.data or prior.data[0].get("state") != "complete":
                            raise GoogleConnectionError(
                                "This overlap changed. Review again.", status_code=409
                            )
                outcome = await schedule.confirm(
                    user_id=user_id,
                    review_id=child["review_id"],
                    review_token=child["review_token"],
                )
            except GoogleConnectionError as exc:
                results.append(
                    {
                        "kind": child["kind"],
                        "ref": child["ref"],
                        "calendar": "unknown",
                        "email": "unknown",
                        "error": str(exc),
                    }
                )
                break
            results.append({"kind": child["kind"], "ref": child["ref"], **outcome})
            expected = "accepted" if child["kind"] == "keep" else "declined"
            if outcome["calendar"] != expected or outcome["email"] in {"failed", "unknown"}:
                break
        return {
            "results": results,
            "complete": len(results)
            == 1 + len([c for c in plan["children"] if c["kind"] == "decline"])
            and all(
                item["calendar"] in {"kept", "accepted", "declined"}
                and item["email"] in {"sent", "not_sent"}
                for item in results
            ),
        }
