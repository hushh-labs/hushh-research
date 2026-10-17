// Layout fixture only: native sign-in, admission, catalog reads and inference
// are outside this test. The shipped controls and Radix interactions are real.
const catalog = { catalogVersion: "synthetic-v1", defaultModel: "google/gemma-4-12b", models: [{ id: "google/gemma-4-12b" }] };
const load = async () => {};
export function usePuppyCatalog() {
  return { catalog, loading: false, error: "", pending: false, load, applyGlobal: async () => {} };
}
