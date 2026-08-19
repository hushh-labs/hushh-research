import { AgentScreen } from "@/components/agent/agent-screen";
import { VaultLockGuard } from "@/components/vault/vault-lock-guard";

export default function AgentPage() {
  return (
    <VaultLockGuard>
      <AgentScreen />
    </VaultLockGuard>
  );
}
