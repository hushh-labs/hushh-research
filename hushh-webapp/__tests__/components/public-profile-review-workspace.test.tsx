import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  prepareClaim: vi.fn(),
  saveEncryptedDraft: vi.fn(),
  completeClaim: vi.fn(),
  preview: vi.fn(),
  addToPKM: vi.fn(),
  replace: vi.fn(),
  user: { uid: "owner-1", getIdToken: vi.fn(async () => "firebase-token") },
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: mocks.replace }) }));
vi.mock("@/lib/firebase/auth-context", () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ vaultKey: "memory-only-vault-key", vaultOwnerToken: "vault-owner-token" }),
}));
vi.mock("@/lib/services/public-profile-discovery-service", () => ({
  PublicProfileDiscoveryService: {
    getReview: mocks.getStatus,
    prepareClaim: mocks.prepareClaim,
    saveEncryptedDraft: mocks.saveEncryptedDraft,
    completeClaim: mocks.completeClaim,
  },
}));
vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  PersonalKnowledgeModelService: { getMetadata: vi.fn(async () => ({ domains: [] })) },
}));
vi.mock("@/lib/agent/agent-pkm-memory", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/agent/agent-pkm-memory")>(),
  previewAgentPkmMemory: mocks.preview,
  addToPKM: mocks.addToPKM,
}));
vi.mock("@/lib/vault/encrypt", () => ({
  encryptData: vi.fn(async () => ({
    ciphertext: "encrypted-private-draft",
    iv: "AAAAAAAAAAAAAAAA",
    tag: "AAAAAAAAAAAAAAAAAAAAAA==",
    algorithm: "aes-256-gcm",
  })),
  decryptData: vi.fn(),
}));

import { PublicProfileReviewWorkspace } from "@/components/profile/public-profile-review-workspace";

const readyJob = {
  job_id: "job-1",
  status: "ready" as const,
  profile_revision: 3,
  profile: {
    schema_version: "public_profile_review.v1" as const,
    display_name: "Jane Doe",
    summary: "A source-backed profile.",
    collected_at: "2026-09-23T12:00:00Z",
    revision: 3,
    facts: [{
      category: "Professional",
      claim: "Founded Example Labs.",
      confidence: "high" as const,
      support: "Public company page",
      source_urls: ["https://example.com/about"],
      observed_at: null,
      collected_at: "2026-09-23T12:00:00Z",
    }],
    sources: ["https://example.com/about"],
    conflicts: [],
    warnings: [],
  },
  encrypted_draft: null,
  last_error_code: null,
  claimed_at: null,
  claim_decision: null,
  updated_at: "2026-09-23T12:00:00Z",
};

const previewCard = {
  card_id: "profile-card-1",
  source_text: "Founded Example Labs.",
  target_domain: "professional",
  primary_json_path: "work.history",
  write_mode: "can_save" as const,
  candidate_payload: { role: "Founder", company: "Example Labs" },
};

function successfulWrite() {
  return {
    attempted: 1,
    saved: 1,
    failed: 0,
    domains: ["professional"],
    results: [{
      cardId: "profile-card-1",
      domain: "professional",
      scope: "work.history",
      sharingPosture: "private",
      success: true,
    }],
  };
}

describe("PublicProfileReviewWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("crypto", { randomUUID: () => "profile-claim-operation-1" });
    mocks.getStatus.mockResolvedValue(readyJob);
    mocks.prepareClaim.mockResolvedValue({ committed_card_ids: [] });
    mocks.saveEncryptedDraft.mockResolvedValue(readyJob);
    mocks.completeClaim.mockResolvedValue({ ...readyJob, status: "claimed" });
    mocks.preview.mockResolvedValue({ cards: [previewCard] });
    mocks.addToPKM.mockResolvedValue(successfulWrite());
  });

  it("does not claim after a partial write and retries with the same operation key", async () => {
    mocks.addToPKM
      .mockResolvedValueOnce({
        attempted: 1,
        saved: 0,
        failed: 1,
        domains: [],
        results: [{
          cardId: "profile-card-1",
          domain: "professional",
          scope: "work.history",
          sharingPosture: "private",
          success: false,
          message: "Temporary write failure",
        }],
      })
      .mockResolvedValueOnce(successfulWrite());

    render(<PublicProfileReviewWorkspace />);
    expect(await screen.findByText("Jane Doe")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("checkbox"));
    await waitFor(() => expect(screen.getByText("Encrypted review saved.")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Save selected information" }));
    expect(await screen.findByText("Some selected details are still pending. Retry to safely finish the save.")).toBeInTheDocument();
    expect(mocks.completeClaim).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Save selected information" }));
    await waitFor(() => expect(mocks.completeClaim).toHaveBeenCalledWith("vault-owner-token", expect.objectContaining({
      profileRevision: 3,
      idempotencyKey: "profile-claim-operation-1",
      rejectAll: false,
      acceptedCount: 1,
    })));
    expect(mocks.addToPKM).toHaveBeenCalledTimes(2);
    expect(mocks.addToPKM.mock.calls[0][0].idempotencyScope).toBe("profile-claim-operation-1");
    expect(mocks.addToPKM.mock.calls[1][0].idempotencyScope).toBe("profile-claim-operation-1");
    expect(mocks.replace).toHaveBeenCalledWith("/one");
  });

  it("binds the claim to the same authored domain used by the PKM write", async () => {
    mocks.preview.mockResolvedValue({ cards: [{
      ...previewCard,
      target_domain: "legacy",
      structure_decision: { target_domain: "secondary" },
      manifest_draft: { domain: "professional" },
    }] });
    render(<PublicProfileReviewWorkspace />);
    await screen.findByText("Jane Doe");
    fireEvent.click(await screen.findByRole("checkbox"));
    await screen.findByText("Encrypted review saved.");
    fireEvent.click(screen.getByRole("button", { name: "Save selected information" }));
    await waitFor(() => expect(mocks.prepareClaim).toHaveBeenCalledWith(
      "vault-owner-token",
      expect.objectContaining({ cards: [{ card_id: "profile-card-1", domain: "professional" }] }),
    ));
    await waitFor(() => expect(mocks.completeClaim).toHaveBeenCalled());
  });

  it("uses durable receipts after a lost write acknowledgment", async () => {
    mocks.prepareClaim.mockResolvedValue({ committed_card_ids: ["profile-card-1"] });
    render(<PublicProfileReviewWorkspace />);
    await screen.findByText("Jane Doe");
    fireEvent.click(await screen.findByRole("checkbox"));
    await waitFor(() => expect(screen.getByText("Encrypted review saved.")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Save selected information" }));
    await waitFor(() => expect(mocks.completeClaim).toHaveBeenCalled());
    expect(mocks.addToPKM).not.toHaveBeenCalled();
  });

  it("rejects all without writing PKM and completes the one-time handoff", async () => {
    render(<PublicProfileReviewWorkspace />);
    expect(await screen.findByText("Jane Doe")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Discard this profile" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm discard" }));

    await waitFor(() => expect(mocks.completeClaim).toHaveBeenCalledWith("vault-owner-token", expect.objectContaining({
      profileRevision: 3,
      idempotencyKey: "profile-claim-operation-1",
      rejectAll: true,
      acceptedCount: 0,
    })));
    expect(mocks.addToPKM).not.toHaveBeenCalled();
    expect(mocks.replace).toHaveBeenCalledWith("/one");
  });
});
