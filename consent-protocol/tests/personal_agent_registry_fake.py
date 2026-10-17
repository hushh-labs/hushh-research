"""Shared admission interface for orchestration fakes; concurrency is tested in PostgreSQL."""


class ProvisionAdmissionFake:
    async def claim_provision(self, *, observed, intent):
        if (
            ((await self.get(intent["user_id"])) or {})
            .get("backend_metadata", {})
            .get("provisionAttempt")
        ):
            raise RuntimeError("attempt retained")
        reservation = {
            "ownerId": intent["user_id"],
            "attemptId": "a" * 32,
            "phase": "reserved",
            "intent": intent,
        }
        await self.upsert(
            **intent,
            status="provisioning",
            backend_metadata={"provisionAttempt": reservation.copy()},
        )
        self._provision_rows = getattr(self, "_provision_rows", {})
        self._provision_rows[intent["user_id"]] = {
            **intent,
            "backend_metadata": {"provisionAttempt": reservation.copy()},
        }
        return reservation

    async def publish_provision(self, *, user_id, attempt_id, expected_phase, next_phase, evidence):
        row = self._provision_rows[user_id]
        attempt = row["backend_metadata"]["provisionAttempt"]
        if attempt["attemptId"] != attempt_id or attempt["phase"] != expected_phase:
            return False
        if "expectedPodKey" in evidence and evidence["expectedPodKey"] != row.get("pod_pubkey"):
            return False
        fields = dict(evidence.get("registry", {}))
        metadata = {**row["backend_metadata"], **fields.pop("backend_metadata", {})}
        metadata["provisionAttempt"] = {**attempt, "phase": next_phase}
        row.update(fields)
        row["backend_metadata"] = metadata
        await self.upsert(
            user_id=user_id,
            hushh_id=row["hushh_id"],
            status=next_phase
            if next_phase in {"connecting", "provisioned"}
            else "suspended"
            if next_phase == "failed"
            else "provisioning",
            backend_metadata=metadata,
            **{
                k: v
                for k, v in row.items()
                if k not in {"user_id", "hushh_id", "backend_metadata", "status"}
            },
        )
        return True
