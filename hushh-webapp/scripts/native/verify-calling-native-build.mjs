import { createServer } from "vite";
import path from "node:path";

// CryptoKit is an Apple SDK. The existing macOS iOS lane and local Mac native
// builds run the same feature gate; non-Apple builds do not claim this proof.
if (process.platform === "darwin") {
  const server = await createServer({ configFile: false, appType: "custom",
    server: { middlewareMode: true }, resolve: { alias: { "@": path.resolve(".") } },
    optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const { verifyCallingWireInterop } = await server.ssrLoadModule("/scripts/native/verify-calling-wire-interop.ts");
    await verifyCallingWireInterop();
  } finally { await server.close(); }
} else {
  console.log("Native calling CryptoKit interoperability requires the macOS native-build lane.");
}
