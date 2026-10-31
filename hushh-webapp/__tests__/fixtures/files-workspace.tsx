import { beforeEach, vi } from "vitest";
import { publishValidatedAuthSessionOwner, publishValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";
import type { FileEntry, FilesSettings } from "@/lib/files/service";
import type { PersonalAgentStatus } from "@/lib/services/personal-agent-status";
const session = vi.hoisted(() => ({
  ownerId: "synthetic-owner",
  vaultKey: "synthetic-memory-only" as string | null,
  vaultOwnerToken: "synthetic-token",
}));
const files = vi.hoisted(() => ({
  list: vi.fn<
    (parent?: string) => Promise<{ entries: FileEntry[]; cursor: string }>
  >(async () => ({ entries: [], cursor: "" })),
  settings: vi.fn<() => Promise<FilesSettings>>(async () => ({
    revision: 1,
    analysis: false,
    automatic: false,
    excluded: [],
  })),
  createFolder: vi.fn(async () => ({})),
  mutate: vi.fn(async () => ({})),
  upload: vi.fn(),
  organize: vi.fn(),
  history: vi.fn(),
  job: vi.fn(),
  entry: vi.fn(),
  usagePage: vi.fn(async () => ({
    bytes: 101 * 1024 ** 3,
    files: 1,
    cursor: "",
  })),
  configure: vi.fn(),
}));
vi.mock("@/lib/files/service", () => ({ FilesService: files }));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { uid: "synthetic-owner" }, userId: session.ownerId }),
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => session,
}));
vi.mock("@/components/profile/pkm-settings-shell", () => ({
  PkmSettingsShell: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("@/components/files/files-organization-history", () => ({
  FilesOrganizationHistory: () => null,
}));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    getPersonalAgentStatus: vi.fn<() => Promise<PersonalAgentStatus>>(
      async () => ({
        filesActivationAvailable: false,
        hostingMode: "byoc",
        state: "active",
      }),
    ),
  },
}));
vi.mock("sonner", () => {
  const toast = {
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn(),
    promise: vi.fn(),
  };
  toast.promise.mockImplementation((request, labels) => {
    const settled = request.then(
      (value: unknown) => {
        const result =
          typeof labels.success === "function"
            ? labels.success(value)
            : labels.success;
        if (result !== undefined) toast.success(result);
        return value;
      },
      (error: unknown) => {
        const result =
          typeof labels.error === "function"
            ? labels.error(error)
            : labels.error;
        if (result !== undefined) toast.error(result);
        throw error;
      },
    );
    return { unwrap: () => settled };
  });
  return { toast };
});

export function fileEntry(fields: Partial<FileEntry>): FileEntry {
  const name = fields.name ?? "notes.txt";
  return {
    id: "synthetic-file",
    name,
    originalName: name,
    parent: "root",
    kind: "file",
    size: 8,
    received: 8,
    receivedHash: "synthetic",
    state: "ready",
    revision: 1,
    ...fields,
  };
}

export { files, session };

beforeEach(() => {
  publishValidatedAuthSessionOwner(null);
  session.ownerId = "synthetic-owner";
  publishValidatedAuthSessionPrincipal({ firebaseUid: "synthetic-owner", ownerId: session.ownerId, accountGeneration: 0 });
});
