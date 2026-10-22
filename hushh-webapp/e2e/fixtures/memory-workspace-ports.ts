// Infrastructure ports for the synthetic layout rehearsal. No vault or network.
export const usePathname = () => "/one/pkm";
export const useRouter = () => ({ push() {}, replace() {}, prefetch() {} });
export const useSearchParams = () => new URLSearchParams();
export const MAX_MARKDOWN_MEMORY_CHARS = 18000;
export const useSoulMemoryModel = () => { throw new Error("Layout fixture supplies its retained model explicitly."); };
export const useLiveMirrorView = () => ({
  status: "ready",
  view: {
    overall: "current", evaluatedAt: "2026-10-22T10:00:00Z",
    lastVerifiedAt: "2026-10-22T10:00:00Z", conflicts: [],
    facts: [
      { key: "name", kind: "profile", predicate: "profile.name", label: "Name", value: "Synthetic Owner", state: "verified" },
      { key: "email", kind: "profile", predicate: "profile.email", label: "Email", value: "owner@example.test", state: "verified" },
    ],
  },
});
