import { afterEach, describe, expect, it, vi } from "vitest";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { readChatStatementImport, startChatStatementImport } from "@/lib/kai/import/chat-statement-import";

const ports = vi.hoisted(() => ({ extract: vi.fn(), save: vi.fn() }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: { importPortfolioStream: ports.extract } }));
vi.mock("@/lib/services/vault-service", () => ({ VaultService: {} }));
vi.mock("@/lib/kai/import/commit-statement-portfolio", () => ({ commitStatementPortfolio: ports.save }));

const request = () => ({
  userId: "owner", vaultKey: "test-key", vaultOwnerToken: "test-token", offerId: "offer",
  file: new File(["statement"], "Statement.csv", { type: "text/csv" }),
});

function completion(severity: string) {
  const envelope = {
    schema_version: "1.0", stream_id: "import-run", stream_kind: "portfolio_import",
    seq: 1, event: "complete", terminal: true,
    payload: {
      portfolio_data_v2: { holdings: [{ symbol: "AAPL", name: "Apple", quantity: 1, price: 100, market_value: 100 }] },
      quality_report_v2: { quality_gate: { severity, passed: true } },
    },
  };
  return new Response(`event: complete\ndata: ${JSON.stringify(envelope)}\n\n`);
}

afterEach(() => {
  advanceVaultSessionEpoch();
  vi.resetAllMocks();
});

describe("chat statement import", () => {
  it("reports saved only once the encrypted write succeeds", async () => {
    ports.extract.mockResolvedValue(completion("pass"));
    let finish!: () => void;
    ports.save.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const task = startChatStatementImport(request());
    await vi.waitFor(() => expect(ports.save).toHaveBeenCalledOnce());
    expect(ports.extract.mock.calls[0]?.[0].formData.get("file").name).toBe("Statement.csv");
    expect(readChatStatementImport()?.phase).toBe("processing");
    finish();
    await task;
    expect(readChatStatementImport()).toEqual({ userId: "owner", offerId: "offer", phase: "saved" });
  });

  it("keeps a statement with a quality warning out of the vault until review", async () => {
    ports.extract.mockResolvedValue(completion("warn"));
    await startChatStatementImport(request());
    expect(ports.save).not.toHaveBeenCalled();
    expect(readChatStatementImport()?.phase).toBe("review");
  });

  it("drops an in-flight statement if the vault session changes", async () => {
    let finish!: (response: Response) => void;
    ports.extract.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
    const task = startChatStatementImport(request());
    advanceVaultSessionEpoch();
    finish(completion("pass"));
    await task;
    expect(readChatStatementImport()).toBeNull();
    expect(ports.save).not.toHaveBeenCalled();
  });
});
