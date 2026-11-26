"""Read explicitly granted additional Gmail accounts in Shared hosting."""

from __future__ import annotations

from hushh_mcp.services.gmail_metadata_reader import GmailMetadataError
from hushh_mcp.services.gmail_receipts_service import GmailReceiptsService


async def additional_mailboxes(google, owner):
    rows = await google._execute_raw_async(
        """SELECT account_id, provider_email, provider_subject, gmail_read_generation
           FROM google_calendar_additional_accounts
           WHERE user_id=:owner AND status='connected' AND gmail_read_enabled
             AND gmail_read_generation IS NOT NULL
           ORDER BY connected_at, account_id""",
        {"owner": owner},
    )
    return [
        {
            "account": "additional/" + str(r["account_id"]),
            "address": r["provider_email"],
            "connection": str(r["gmail_read_generation"]),
        }
        for r in rows.data
        if r["provider_email"]
    ]


class SharedAdditionalGmail(GmailReceiptsService):
    def __init__(self, google, owner, box, binding):
        super().__init__()
        self.google, self.owner, self.box, self.binding = google, owner, box, binding

    def _fetch_connection_row(self, *, user_id):
        if user_id != self.owner:
            raise GmailMetadataError("permission_denied")
        return {
            "google_sub": self.binding[3],
            "google_email": self.box["address"],
            "status": "connected",
            "scope_csv": self.binding[6],
            "revoked": False,
            "generation": self.box["connection"],
        }

    @staticmethod
    def _refresh_observation(row):
        return {"generation": row["generation"]}

    def _mark_connection_needs_reauth(self, **kwargs):
        # This grant belongs to GoogleConnectionService; the primary Gmail row is unrelated.
        raise GmailMetadataError("reconnect_required")

    async def _ensure_access_token(self, *, user_id):
        row = self._fetch_connection_row(user_id=user_id)
        token = await self.google.access_token(
            user_id=user_id, service="gmail", access_level="read", account_id=self.binding[2]
        )
        return token, row
