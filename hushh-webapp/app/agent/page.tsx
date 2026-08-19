import { AgentScreen } from "@/components/agent/agent-screen";
import { PhoneMandateGuard } from "@/components/auth/phone-mandate-guard";
import { VaultLockGuard } from "@/components/vault/vault-lock-guard";

export default function AgentPage() {
  // Phone before lock, the same order every other private surface uses. The
  // lock gate holds when the lock is not this person's step, so without a phone
  // gate above it to move them along, somebody who still has to verify would
  // sit on a loader with nothing to advance it.
  return (
    <PhoneMandateGuard>
      <VaultLockGuard>
        <AgentScreen />
      </VaultLockGuard>
    </PhoneMandateGuard>
  );
}
