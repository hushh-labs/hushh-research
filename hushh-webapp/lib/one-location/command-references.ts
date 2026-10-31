export type LocationObservation = {
  reference: string;
  kind: "circle" | "person" | "place" | "share" | "request";
  id: string;
  name: string;
  observed_at: string;
};

export function isLocationObservation(
  value: unknown,
): value is LocationObservation {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.reference === "string" &&
    /^candidate_[a-f0-9]{32}$/.test(item.reference) &&
    ["circle", "person", "place", "share", "request"].includes(
      String(item.kind),
    ) &&
    typeof item.id === "string" &&
    item.id.length > 0 &&
    item.id.length <= 300 &&
    typeof item.name === "string" &&
    item.name.length > 0 &&
    item.name.length <= 120 &&
    typeof item.observed_at === "string" &&
    Number.isFinite(Date.parse(item.observed_at))
  );
}

/** Unlocked-session locators only. No browser storage, coordinates or authority.
 * The owning preparer must refresh the exact resource before any effect. */
export class LocationReferenceSession {
  private owner: string | null = null;
  private entries = new Map<string, LocationObservation>();
  constructor(private readonly now = Date.now) {}
  clear() {
    this.owner = null;
    this.entries.clear();
  }
  list(owner: string): LocationObservation[] {
    if (owner !== this.owner) {
      this.clear();
      this.owner = owner;
    }
    const now = this.now();
    for (const [key, value] of this.entries) {
      const age = now - Date.parse(value.observed_at);
      if (age < 0 || age > 15 * 60_000) this.entries.delete(key);
    }
    return [...this.entries.values()].map((value) => ({ ...value }));
  }
  observe(owner: string, values: readonly unknown[], replacePlaces = false) {
    this.list(owner);
    const now = this.now();
    const valid = values
      .filter(isLocationObservation)
      .filter((value) => {
        const age = now - Date.parse(value.observed_at);
        return age >= 0 && age <= 15 * 60_000;
      })
      .slice(-50);
    if (replacePlaces) {
      for (const [key, value] of this.entries)
        if (value.kind === "place") this.entries.delete(key);
    }
    for (const value of valid) {
      this.entries.delete(value.reference);
      const { reference, kind, id, name, observed_at } = value;
      this.entries.set(reference, { reference, kind, id, name, observed_at });
      while (this.entries.size > 50)
        this.entries.delete(this.entries.keys().next().value!);
    }
    this.list(owner);
  }
}
