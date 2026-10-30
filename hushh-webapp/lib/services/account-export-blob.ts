/** Validate the account wire format without materializing encrypted history as JS values. */
const SECTIONS = [
  "actor_profile", "runtime_persona_state", "verified_email_aliases", "encrypted_vault_keys",
  "encrypted_pkm_manifests", "encrypted_pkm_index", "encrypted_pkm_blobs",
  "encrypted_pkm_recovery_revisions", "encrypted_pkm_recovery_segments", "consent_audit",
] as const;
const ROOT_KEYS = ["requested_target", "exported_at", "data", "success"];
type Phase = "keyOrEnd" | "key" | "colon" | "valueOrEnd" | "value" | "commaOrEnd";
type Frame = { kind: "object" | "array"; phase: Phase; scope: "root" | "data" | "section" | "other";
  start: number; key: string; seen: Set<string> };
type NumberState = "minus" | "zero" | "integer" | "dot" | "fraction" | "exponent" | "sign" | "digits";

/** Only the four envelope values and ten section ranges are retained. Strings in
 * history are checked for JSON escapes/control bytes but are never accumulated. */
class AccountExportValidator {
  private stack: Frame[] = [];
  private mode: "none" | "string" | "literal" = "none";
  private escaped = false;
  private unicode = 0;
  private capture = false;
  private token = "";
  private tokenStart = 0;
  private keyToken = false;
  private numberState: NumberState | null = null;
  private offset = 0;
  private ended = false;
  private rootValues = new Map<string, unknown>();
  private ranges = new Map<string, [number, number]>();
  private utf8 = new TextDecoder("utf-8", { fatal: true });

  private fail(): never { throw new Error("Incomplete encrypted export"); }
  private top(): Frame { return this.stack[this.stack.length - 1] ?? this.fail(); }

  private begin(kind: "object" | "array" | "scalar", _start: number) {
    if (!this.stack.length) {
      if (this.ended || kind !== "object") this.fail();
      return "root" as const;
    }
    const parent = this.top();
    if (parent.phase !== "value" && parent.phase !== "valueOrEnd") this.fail();
    if (parent.scope === "root") {
      if (parent.key === "data") { if (kind !== "object") this.fail(); return "data" as const; }
      if (kind !== "scalar") this.fail();
    }
    if (parent.scope === "data") {
      const single = parent.key === "actor_profile" || parent.key === "runtime_persona_state";
      if (single ? kind === "array" : kind !== "array") this.fail();
      return "section" as const;
    }
    if (parent.scope === "section" && parent.kind === "array" && kind !== "object") this.fail();
    return "other" as const;
  }

  private complete(start: number, end: number, scalar?: unknown) {
    if (!this.stack.length) { this.ended = true; return; }
    const parent = this.top();
    if (parent.scope === "root" && parent.key !== "data") this.rootValues.set(parent.key, scalar);
    if (parent.scope === "data") {
      if ((parent.key === "actor_profile" || parent.key === "runtime_persona_state") &&
        scalar !== undefined && scalar !== null) this.fail();
      this.ranges.set(parent.key, [start, end]);
    }
    parent.phase = "commaOrEnd";
  }

  private endToken(end: number) {
    if (this.keyToken) {
      const frame = this.top();
      frame.key = this.capture ? JSON.parse(this.token) as string : "";
      if (frame.scope === "root" || frame.scope === "data") {
        const allowed: readonly string[] = frame.scope === "root" ? ROOT_KEYS : SECTIONS;
        if (!allowed.includes(frame.key) || frame.seen.has(frame.key)) this.fail();
        frame.seen.add(frame.key);
      }
      frame.phase = "colon";
    } else {
      let value: unknown;
      if (this.mode === "literal") {
        if (this.numberState) {
          if (!["zero", "integer", "fraction", "digits"].includes(this.numberState)) this.fail();
          // Numbers inside history are preserved as raw bytes, including integers
          // beyond JS precision; the envelope never needs a numeric value.
          value = 0;
        } else {
          if (!["true", "false", "null"].includes(this.token)) this.fail();
          value = JSON.parse(this.token);
        }
      } else if (this.capture) value = JSON.parse(this.token);
      this.complete(this.tokenStart, end, value);
    }
    this.mode = "none";
    this.token = "";
    this.numberState = null;
  }

  private numberByte(b: number) {
    const digit = b >= 48 && b <= 57;
    const nonzero = b >= 49 && b <= 57;
    switch (this.numberState) {
      case "minus": if (b === 48) { this.numberState = "zero"; return; }
        if (nonzero) { this.numberState = "integer"; return; } break;
      case "zero": case "integer":
        if (digit && this.numberState === "integer") return;
        if (b === 46) { this.numberState = "dot"; return; }
        if (b === 101 || b === 69) { this.numberState = "exponent"; return; } break;
      case "dot": if (digit) { this.numberState = "fraction"; return; } break;
      case "fraction": if (digit) return;
        if (b === 101 || b === 69) { this.numberState = "exponent"; return; } break;
      case "exponent": if (b === 43 || b === 45) { this.numberState = "sign"; return; }
        if (digit) { this.numberState = "digits"; return; } break;
      case "sign": if (digit) { this.numberState = "digits"; return; } break;
      case "digits": if (digit) return; break;
    }
    this.fail();
  }

  write(bytes: Uint8Array) {
    // Validate UTF-8 across boundaries independently of the bounded JSON scanner.
    this.utf8.decode(bytes, { stream: true });
    for (let i = 0; i < bytes.length; i++, this.offset++) {
      const b = bytes[i]!;
      if (this.mode === "string") {
        if (this.capture) {
          this.token += String.fromCharCode(b);
          if (this.token.length > 4096) this.fail();
        }
        if (this.unicode) {
          if (!((b >= 48 && b <= 57) || (b >= 65 && b <= 70) || (b >= 97 && b <= 102))) this.fail();
          this.unicode--;
        } else if (this.escaped) {
          if (b === 117) this.unicode = 4;
          else if (![34, 92, 47, 98, 102, 110, 114, 116].includes(b)) this.fail();
          this.escaped = false;
        } else if (b === 92) this.escaped = true;
        else if (b === 34) this.endToken(this.offset + 1);
        else if (b < 32) this.fail();
        continue;
      }
      if (this.mode === "literal") {
        if (![32, 9, 10, 13, 44, 93, 125].includes(b)) {
          if (this.numberState) this.numberByte(b);
          else { this.token += String.fromCharCode(b); if (this.token.length > 5) this.fail(); }
          continue;
        }
        this.endToken(this.offset);
      }
      if ([32, 9, 10, 13].includes(b)) continue;
      if (this.ended) this.fail();
      if (b === 123 || b === 91) {
        const kind = b === 123 ? "object" : "array";
        const scope = this.begin(kind, this.offset);
        this.stack.push({ kind, scope, start: this.offset, phase: kind === "object" ? "keyOrEnd" : "valueOrEnd", key: "", seen: new Set() });
      } else if (b === 125 || b === 93) {
        const frame = this.top();
        if (frame.kind !== (b === 125 ? "object" : "array") ||
          !["keyOrEnd", "valueOrEnd", "commaOrEnd"].includes(frame.phase)) this.fail();
        if (frame.scope === "root" && frame.seen.size !== ROOT_KEYS.length) this.fail();
        if (frame.scope === "data" && frame.seen.size !== SECTIONS.length) this.fail();
        this.stack.pop();
        this.complete(frame.start, this.offset + 1);
      } else if (b === 44) {
        const frame = this.top();
        if (frame.phase !== "commaOrEnd") this.fail();
        frame.phase = frame.kind === "object" ? "key" : "value";
      } else if (b === 58) {
        const frame = this.top();
        if (frame.phase !== "colon") this.fail();
        frame.phase = "value";
      } else if (b === 34) {
        const frame = this.top();
        this.keyToken = frame.kind === "object" && ["key", "keyOrEnd"].includes(frame.phase);
        if (!this.keyToken) this.begin("scalar", this.offset);
        this.capture = frame.scope === "root" || frame.scope === "data";
        this.token = this.capture ? '"' : "";
        this.tokenStart = this.offset;
        this.mode = "string";
      } else {
        this.begin("scalar", this.offset);
        this.keyToken = false;
        this.mode = "literal";
        this.tokenStart = this.offset;
        this.token = String.fromCharCode(b);
        this.numberState = b === 45 ? "minus" : b === 48 ? "zero" : b >= 49 && b <= 57 ? "integer" : null;
      }
    }
  }

  finish(blob: Blob, exclude: readonly string[]): Blob {
    this.utf8.decode();
    if (!this.ended || this.stack.length || this.mode !== "none" ||
      this.rootValues.get("success") !== true || this.rootValues.get("requested_target") !== "account" ||
      typeof this.rootValues.get("exported_at") !== "string" ||
      !Number.isFinite(Date.parse(this.rootValues.get("exported_at") as string))) this.fail();
    const parts: BlobPart[] = ["{"];
    for (const key of SECTIONS) {
      if (exclude.includes(key)) continue;
      const [start, end] = this.ranges.get(key) ?? this.fail();
      if (parts.length > 1) parts.push(",");
      parts.push(JSON.stringify(key), ":", blob.slice(start, end));
    }
    return new Blob([...parts, "}"], { type: "application/json" });
  }
}

export async function readAccountExportBlob(
  body: ReadableStream<Uint8Array>,
  options: { exclude?: readonly string[]; requireCurrent?: () => void } = {},
): Promise<Blob> {
  const reader = body.getReader();
  const validator = new AccountExportValidator();
  const parts: Blob[] = [];
  let expired = false;
  const deadline = performance.now() + 240_000;
  const requireActive = () => {
    options.requireCurrent?.();
    if (expired || performance.now() >= deadline) throw new Error("Export expired");
  };
  const timer = setTimeout(() => { expired = true; void reader.cancel().catch(() => undefined); }, 240_000);
  try {
    while (true) {
      requireActive();
      const { done, value } = await reader.read();
      requireActive();
      if (done) break;
      validator.write(value);
      requireActive();
      parts.push(new Blob([value as Uint8Array<ArrayBuffer>]));
    }
    requireActive();
    return validator.finish(new Blob(parts), options.exclude ?? []);
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
    parts.length = 0;
    reader.releaseLock();
  }
}
