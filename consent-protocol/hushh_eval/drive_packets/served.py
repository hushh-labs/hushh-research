"""Served mode: grade what UAT already produced, read-only.

A census, not a sample: every current-policy packet version of the owner and its
members' facts, decrypted in process memory with the runtime's own envelope code.
"""

from __future__ import annotations

from hushh_eval.drive_packets.sources import UatReadOnlySource, assert_read_only


def current_packets(source: UatReadOnlySource, *, policy: str) -> list[dict]:
    from sqlalchemy import text

    from hushh_mcp.services.drive_document_store import DriveDocumentCipher
    from hushh_mcp.services.drive_packet_store import DrivePacketStore

    store = object.__new__(DrivePacketStore)
    store.cipher = DriveDocumentCipher()
    packets = []
    with source.engine.connect() as db:
        assert_read_only(db)
        rows = list(
            db.execute(
                text(
                    """SELECT v.*,h.key_envelope,h.dirty FROM drive_packet_versions v
                    JOIN drive_packet_heads h ON h.packet_id=v.packet_id AND h.current_version=v.version
                    WHERE v.user_id=:owner AND v.policy_version=:policy
                    ORDER BY v.packet_id"""
                ),
                {"owner": source.owner, "policy": policy},
            ).mappings()
        )
        for row in rows:
            manifest = store._manifest(dict(row))
            members = []
            for item in manifest.get("sources", []):
                facts_row = (
                    db.execute(
                        text(
                            """SELECT f.*,d.active_version,d.metadata_envelope,d.connection_generation AS doc_generation
                        FROM drive_document_facts f JOIN connected_documents d
                          ON d.document_id=f.document_id AND d.user_id=f.user_id
                        WHERE f.document_id=:document AND f.facts_version=:version AND f.user_id=:owner"""
                        ),
                        {
                            "document": item["document_id"],
                            "version": item["facts_version"],
                            "owner": source.owner,
                        },
                    )
                    .mappings()
                    .one_or_none()
                )
                if facts_row is None:
                    members.append({"document_id": item["document_id"], "facts": None})
                    continue
                metadata = store.cipher.open(
                    {
                        "metadata_envelope": facts_row["metadata_envelope"],
                        "user_id": facts_row["user_id"],
                        "document_id": facts_row["document_id"],
                        "connection_generation": facts_row["doc_generation"],
                    }
                )
                members.append(
                    {
                        "document_id": str(item["document_id"]),
                        "facts": store.facts(dict(facts_row)),
                        "complete": not facts_row["has_gaps"],
                        "active_version": facts_row["active_version"],
                        "generation": facts_row["doc_generation"],
                        "metadata": {
                            "modifiedTime": metadata.get("modified_time"),
                            "createdTime": metadata.get("created_time"),
                            "mime_type": metadata.get("mime_type"),
                        },
                        "file_id": metadata.get("file_id"),
                    }
                )
            packets.append(
                {
                    "packet_id": str(row["packet_id"]),
                    "version": row["version"],
                    "state": row["state"],
                    "available": bool(row["available"]) and not row["dirty"],
                    "document_count": row["document_count"],
                    "price_cents": row["price_cents"],
                    "manifest": manifest,
                    "members": members,
                }
            )
    return packets
