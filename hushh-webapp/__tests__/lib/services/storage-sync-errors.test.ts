import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Characterization: local storage sync adapter error-isolation matrix.
 *
 * Verified repo truth (truth-first)
 * ---------------------------------
 * The task references a "storage sync adapter" surface under the services
 * layer. There is NO module literally named that under
 * `hushh-webapp/lib/services`. The real, public synchronous storage adapters
 * that wrap the underlying Web Storage engines (`window.localStorage` /
 * `window.sessionStorage`) and own the try/catch error-isolation boundary live
 * in `hushh-webapp/lib/utils/session-storage.ts`. Those are the adapters the
 * service layer (e.g. `OnboardingLocalService`, `UserLocalStateService`)
 * delegates through, so they are the correct, load-bearing surface to
 * characterize.
 *
 * Each exported adapter — `setLocalItem`, `getLocalItem`, `removeLocalItem`,
 * `removeLocalItems`, `clearLocalStorage`, `clearLocalStorageKeys`,
 * `setSessionItem`, `getSessionItem`, `removeSessionItem`,
 * `removeSessionItemsByPrefix`, `clearSessionStorage` — wraps the raw storage
 * call in a try/catch that logs a warning and swallows the failure. Reads
 * return `null` on failure; writes/removes/clears return `void` and never
 * rethrow.
 *
 * This suite injects simulated underlying storage exceptions directly into the
 * adapter layer by stubbing `window.localStorage` / `window.sessionStorage`
 * with throwing implementations (mimicking `QuotaExceededError`,
 * `SecurityError`, and out-of-memory / access failures). It pins the invariant
 * that these boundaries contain the failure — never throwing an unhandled
 * exception up to callers — and that reads degrade to `null`. No production
 * source is modified.
 */

import {
  clearLocalStorage,
  clearLocalStorageKeys,
  clearSessionStorage,
  getLocalItem,
  getSessionItem,
  removeLocalItem,
  removeLocalItems,
  removeSessionItem,
  removeSessionItemsByPrefix,
  setLocalItem,
  setSessionItem,
} from "@/lib/utils/session-storage";

type MutableWindow = typeof globalThis & {
  localStorage?: Storage;
  sessionStorage?: Storage;
  Capacitor?: unknown;
};

const win = globalThis as MutableWindow;

const originalLocalStorage = win.localStorage;
const originalSessionStorage = win.sessionStorage;
const originalCapacitor = win.Capacitor;

/**
 * Build a Storage-shaped object whose every accessor throws the provided error,
 * simulating an underlying engine failure (quota exceeded, security denial,
 * memory pressure, etc.). `length`/`key` are included so prefix/clear paths
 * that iterate the store also hit the throwing boundary.
 */
function makeExplodingStorage(error: Error): Storage {
  const boom = () => {
    throw error;
  };
  return {
    get length(): number {
      throw error;
    },
    clear: boom,
    getItem: boom,
    key: boom,
    removeItem: boom,
    setItem: boom,
  } as unknown as Storage;
}

function installStorage(storage: Storage): void {
  Object.defineProperty(win, "localStorage", {
    configurable: true,
    value: storage,
  });
  Object.defineProperty(win, "sessionStorage", {
    configurable: true,
    value: storage,
  });
}

function restoreStorage(): void {
  Object.defineProperty(win, "localStorage", {
    configurable: true,
    value: originalLocalStorage,
  });
  Object.defineProperty(win, "sessionStorage", {
    configurable: true,
    value: originalSessionStorage,
  });
  if (originalCapacitor === undefined) {
    delete win.Capacitor;
  } else {
    win.Capacitor = originalCapacitor;
  }
}

let warnSpy: ReturnType<typeof vi.spyOn>;
let infoSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Force the non-native (web) branch so sessionStorage is exercised directly.
  delete win.Capacitor;
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  restoreStorage();
  warnSpy.mockRestore();
  infoSpy.mockRestore();
  vi.restoreAllMocks();
});

describe("local storage sync adapters · underlying-engine exception isolation", () => {
  it("swallows a QuotaExceededError from setItem without throwing", () => {
    const quota = new DOMException("Quota exceeded", "QuotaExceededError");
    installStorage(makeExplodingStorage(quota as unknown as Error));

    expect(() => setLocalItem("k", "v")).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("degrades getLocalItem to null when the engine throws on read", () => {
    installStorage(makeExplodingStorage(new Error("read denied")));

    let result: string | null = "sentinel";
    expect(() => {
      result = getLocalItem("k");
    }).not.toThrow();
    expect(result).toBeNull();
  });

  it("isolates removeLocalItem failures", () => {
    installStorage(makeExplodingStorage(new Error("remove failed")));
    expect(() => removeLocalItem("k")).not.toThrow();
  });

  it("isolates batched removeLocalItems failures across every key", () => {
    installStorage(makeExplodingStorage(new Error("batch remove failed")));
    expect(() => removeLocalItems(["a", "b", "c"])).not.toThrow();
  });

  it("isolates clearLocalStorage failures", () => {
    installStorage(makeExplodingStorage(new Error("clear failed")));
    expect(() => clearLocalStorage()).not.toThrow();
  });

  it("isolates clearLocalStorageKeys failures", () => {
    installStorage(makeExplodingStorage(new Error("clear keys failed")));
    expect(() => clearLocalStorageKeys(["x", "y"])).not.toThrow();
  });
});

describe("session storage sync adapters · underlying-engine exception isolation", () => {
  it("swallows setSessionItem failures under simulated memory overflow", () => {
    const overflow = new RangeError("Out of memory");
    installStorage(makeExplodingStorage(overflow));
    expect(() => setSessionItem("k", "v")).not.toThrow();
  });

  it("degrades getSessionItem to null when the engine throws on read", () => {
    installStorage(makeExplodingStorage(new Error("session read denied")));

    let result: string | null = "sentinel";
    expect(() => {
      result = getSessionItem("k");
    }).not.toThrow();
    expect(result).toBeNull();
  });

  it("isolates removeSessionItem failures", () => {
    installStorage(makeExplodingStorage(new Error("session remove failed")));
    expect(() => removeSessionItem("k")).not.toThrow();
  });

  it("isolates removeSessionItemsByPrefix failures while iterating the store", () => {
    installStorage(makeExplodingStorage(new Error("prefix scan failed")));
    expect(() => removeSessionItemsByPrefix("pref_")).not.toThrow();
  });

  it("isolates clearSessionStorage failures", () => {
    installStorage(makeExplodingStorage(new Error("session clear failed")));
    expect(() => clearSessionStorage()).not.toThrow();
  });
});

describe("local storage sync adapters · full error-isolation matrix", () => {
  const simulatedErrors: Array<[string, Error]> = [
    ["QuotaExceededError", new DOMException("quota", "QuotaExceededError") as unknown as Error],
    ["SecurityError", new DOMException("blocked", "SecurityError") as unknown as Error],
    ["memory overflow", new RangeError("Out of memory")],
    ["generic access failure", new Error("access failure")],
  ];

  for (const [label, error] of simulatedErrors) {
    it(`contains all write/remove/clear adapters under ${label}`, () => {
      installStorage(makeExplodingStorage(error));

      expect(() => {
        setLocalItem("k", "v");
        removeLocalItem("k");
        removeLocalItems(["k1", "k2"]);
        clearLocalStorage();
        clearLocalStorageKeys(["k1"]);
        setSessionItem("k", "v");
        removeSessionItem("k");
        removeSessionItemsByPrefix("p_");
        clearSessionStorage();
      }).not.toThrow();
    });

    it(`degrades all read adapters to null under ${label}`, () => {
      installStorage(makeExplodingStorage(error));
      expect(getLocalItem("k")).toBeNull();
      expect(getSessionItem("k")).toBeNull();
    });
  }
});
