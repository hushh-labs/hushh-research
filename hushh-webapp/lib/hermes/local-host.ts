import { isNative } from "@/lib/capacitor/platform";

/**
 * Whether this page is being viewed from the machine that serves it.
 *
 * The Hermes bridge reaches a gateway over loopback ON THE SERVER. On a
 * deployed origin that loopback is a Cloud Run container, never the viewer's
 * own Mac, so a developer hint about the bridge's env key is meaningless to
 * everyone but the person running `next dev` on their laptop. This is the one
 * test that separates those two readers, and it is client-side only: on the
 * server there is no viewer to speak of, so the answer is no.
 */
const LOCAL_HOSTNAMES: ReadonlySet<string> = new Set(["localhost", "127.0.0.1"]);

export function isLocalHost(): boolean {
  if (typeof window === "undefined") return false;
  // The iOS and Android shells serve the app from a "localhost" origin too
  // (App://localhost, https://localhost), and nobody holding a phone is the
  // person running next dev. Without this the developer hint could reach the
  // native app the day a status payload carries a message.
  if (isNative()) return false;
  try {
    return LOCAL_HOSTNAMES.has(
      String(window.location?.hostname ?? "").toLowerCase(),
    );
  } catch {
    return false;
  }
}
