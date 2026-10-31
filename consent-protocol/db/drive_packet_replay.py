"""Pinned Drive replay compatibility; historical SQL and withdrawals stay immutable."""

from __future__ import annotations

import hashlib
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from db.migration_authority import MigrationManifestEntryV2


def cent_prices_replay_sql(entry: MigrationManifestEntryV2) -> str:
    """Preserve immutable 329 and the exact installed 368 waiver constraints."""
    checksum = hashlib.sha256(entry.sql.encode("utf-8")).hexdigest()
    if (
        checksum != "ee91dfcc494deda10e84e0a06b506a93022c3416264c160ae6541db5786dda4a"
        or entry.checksum_sha256 != checksum
    ):
        raise ValueError("Drive cent prices replay source checksum changed")
    original = "    IF NOT EXISTS (SELECT 1 FROM pg_constraint\n"
    if entry.sql.count(original) != 1:
        raise ValueError("Drive cent prices replay source shape changed")
    # Keep Boolean grouping: removing parentheses could accept a weaker CHECK.
    # Only this exact successor skips the old rule; the other five checks and
    # the original repair/failure path remain unchanged. No rows are rewritten.
    successor = """    IF rule.constraint_name='drive_share_requests_locked_quote_check'
      AND EXISTS (SELECT 1 FROM pg_attribute
        WHERE attrelid='drive_share_requests'::regclass
          AND attname='existing_access_waived_at' AND NOT attisdropped
          AND atttypid='timestamptz'::regtype AND NOT attnotnull
          AND NOT atthasdef AND attgenerated='' AND attidentity='')
      AND EXISTS (SELECT 1 FROM pg_constraint
        WHERE conrelid='drive_share_requests'::regclass
          AND conname='drive_share_requests_locked_quote_check'
          AND contype='c' AND convalidated
          AND regexp_replace(pg_get_constraintdef(oid),'[[:space:]]','','g')=
            'CHECK((((quoted_amount_centsISNULL)AND(quote_versionISNULL))OR(((payment_required=true)OR(existing_access_waived_atISNOTNULL))AND((quoted_amount_cents>=50)AND(quoted_amount_cents<=50000))AND(quote_version>=0))))')
      AND EXISTS (SELECT 1 FROM pg_constraint
        WHERE conrelid='drive_share_requests'::regclass
          AND conname='drive_request_existing_access_waiver_check'
          AND contype='c' AND convalidated
          AND regexp_replace(pg_get_constraintdef(oid),'[[:space:]]','','g')=
            'CHECK(((existing_access_waived_atISNULL)OR(payment_required=false)))') THEN
      CONTINUE;
    END IF;
"""
    return entry.sql.replace(original, successor + original, 1)


_RETIREMENT_SOURCE = "915ceedf0a60959b8a546849ba9f4c5605f12950a0c6c9c079414fcd3bfa09d8"
_PACKET_SQL = """UPDATE drive_packet_listings
SET enabled=FALSE, revision=revision+1, updated_at=clock_timestamp()
WHERE enabled;

UPDATE drive_packet_versions SET available=FALSE WHERE available;"""
_PERIOD_CHECK = "CHECK((((packet_kind='content_facts'::text)AND(categoryISNULL)AND(period_startISNULL)AND(period_endISNULL)AND(period_timezoneISNULL))OR((packet_kind='provider_discovery'::text)AND(categoryISNOTNULL)AND(category=ANY(ARRAY['financial'::text,'bank'::text,'brokerage'::text,'insurance'::text]))AND(period_startISNOTNULL)AND(period_endISNOTNULL)AND(period_end>=period_start)AND(period_timezoneISNOTNULL))))"
# Do not qualify a column name alone. Schema drift must abort the original
# transaction, never broaden retirement or infer renewed owner approval.
_RETIREMENT_GUARD = """DO $drive_retirement$
DECLARE
 heads REGCLASS := 'drive_packet_heads'::regclass;
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=heads
    AND attname IN ('packet_kind','category','period_start','period_end','period_timezone')
    AND NOT attisdropped)
  AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=heads
    AND conname='drive_packet_period_kind') THEN
  UPDATE drive_packet_listings
   SET enabled=FALSE,revision=revision+1,updated_at=clock_timestamp() WHERE enabled;
  UPDATE drive_packet_versions SET available=FALSE WHERE available;
 ELSE
  -- Compatible with ordinary writers; prevents concurrent successor DDL drift.
  LOCK TABLE drive_packet_heads IN ROW SHARE MODE;
  IF (SELECT count(*) FROM pg_attribute a
    JOIN (VALUES
      ('packet_kind','text'::regtype,TRUE,'''content_facts''::text'),
      ('category','text'::regtype,FALSE,''),
      ('period_start','date'::regtype,FALSE,''),
      ('period_end','date'::regtype,FALSE,''),
      ('period_timezone','text'::regtype,FALSE,'')
    ) AS expected(name,type_id,required,default_value) ON a.attname=expected.name
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid=heads AND NOT a.attisdropped
      AND a.atttypid=expected.type_id AND a.attnotnull=expected.required
      AND a.attgenerated='' AND a.attidentity=''
      AND COALESCE(pg_get_expr(d.adbin,d.adrelid),'')=expected.default_value) <> 5
   OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=heads
      AND conname='drive_packet_period_kind' AND contype='c' AND convalidated
      AND regexp_replace(pg_get_constraintdef(oid),'[[:space:]]','','g')=__PERIOD_CHECK__)
  THEN
   RAISE EXCEPTION 'Drive period successor changed; refusing historical retirement'
    USING ERRCODE='23514';
  END IF;
  UPDATE drive_packet_listings l
   SET enabled=FALSE,revision=l.revision+1,updated_at=clock_timestamp()
   FROM drive_packet_heads h WHERE l.packet_id=h.packet_id AND l.user_id=h.user_id
    AND l.enabled AND h.packet_kind='content_facts';
  UPDATE drive_packet_versions v SET available=FALSE FROM drive_packet_heads h
   WHERE v.packet_id=h.packet_id AND v.user_id=h.user_id AND v.available
    AND h.packet_kind='content_facts';
 END IF;
END $drive_retirement$;"""


def retirement_replay_sql(entry: MigrationManifestEntryV2) -> str:
    """Retire legacy collection only after qualifying the exact 411 successor."""
    checksum = hashlib.sha256(entry.sql.encode("utf-8")).hexdigest()
    if (
        (entry.migration_id, entry.filename) != ("360", "360_uat_drive_collection_retirement.sql")
        or checksum != _RETIREMENT_SOURCE
        or entry.checksum_sha256 != checksum
        or entry.sql.count(_PACKET_SQL) != 1
    ):
        raise ValueError("Drive retirement replay source checksum or shape changed")
    guard = _RETIREMENT_GUARD.replace(
        "__PERIOD_CHECK__", "'" + _PERIOD_CHECK.replace("'", "''") + "'"
    )
    return entry.sql.replace(_PACKET_SQL, guard, 1)
