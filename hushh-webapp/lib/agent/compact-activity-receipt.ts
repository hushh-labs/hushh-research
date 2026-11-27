/** Content-free host receipts. Never restore a live Browser controller from history. */
export type CompactActivityReceipt = Readonly<{ v: 1; kind: "browser_sign_in" | "browser_review";
  state: "allowed" | "completed" | "cancelled" | "superseded"; task_id: string; operation_id: string }>;
export function parseCompactActivityReceipt(value: unknown): CompactActivityReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== "kind,operation_id,state,task_id,v" || row.v !== 1 ||
    !["browser_sign_in", "browser_review"].includes(String(row.kind)) || !["allowed", "completed", "cancelled", "superseded"].includes(String(row.state)) ||
    typeof row.task_id !== "string" || !/^browser_[a-f0-9]{32}$/.test(row.task_id) ||
    typeof row.operation_id !== "string" || !/^[A-Za-z0-9_.:-]{8,64}$/.test(row.operation_id) ||
    new TextEncoder().encode(JSON.stringify(row)).length > 256) return null;
  return row as CompactActivityReceipt;
}
export function compactActivityReceipts(value: unknown): CompactActivityReceipt[] {
  if (!Array.isArray(value) || value.length > 8) return [];
  const rows = new Map<string, CompactActivityReceipt>();
  for (const candidate of value) {
    const row = parseCompactActivityReceipt(candidate);
    if (!row) continue;
    const key = JSON.stringify([row.kind, row.task_id, row.operation_id]);
    if (rows.get(key)?.state !== "allowed" && rows.has(key) && row.state === "allowed") continue;
    rows.set(key, row);
  }
  return [...rows.values()];
}
export function compactActivityLabel(receipt: CompactActivityReceipt): string {
  const signIn = receipt.kind === "browser_sign_in";
  if (receipt.state === "allowed") return signIn ? "Sign-in allowed." : "Browser request allowed.";
  if (receipt.state === "completed") return signIn ? "Private sign-in submitted." : "Browser review completed.";
  if (receipt.state === "cancelled") return signIn ? "Sign-in cancelled." : "Browser review cancelled.";
  return signIn ? "Sign-in request replaced." : "Browser review replaced.";
}

export function applyCompactActivityReceipt<T extends { id: string; serverMessageId?: string; compactActivityReceipts?: CompactActivityReceipt[] }>(
  rows: T[], messageId: string, receipt: CompactActivityReceipt,
): T[] {
  let changed = false;
  const next = rows.map(row => {
    if (row.id !== messageId && row.serverMessageId !== messageId) return row;
    const previous = compactActivityReceipts(row.compactActivityReceipts);
    const same = (item: CompactActivityReceipt) => item.kind === receipt.kind && item.task_id === receipt.task_id && item.operation_id === receipt.operation_id;
    const existing = previous.find(same);
    if (existing?.state === receipt.state || existing && existing.state !== "allowed" && receipt.state === "allowed") return row;
    changed = true;
    return { ...row, compactActivityReceipts: [...previous.filter(item => !same(item)), receipt].slice(-8) };
  });
  return changed ? next : rows;
}
