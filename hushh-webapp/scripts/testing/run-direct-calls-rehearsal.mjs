import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createServer as createSocketServer } from "node:net";
import { get } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const protocol = path.resolve(web, "../consent-protocol");
const python = process.env.CALLING_PYTHON_BIN || path.join(protocol, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const go = process.env.CALLING_GO_BIN || "go";
const firebase = process.env.CALLING_FIREBASE_CLI;
if (!firebase || !process.env.ONE_COMMAND_TEST_DATABASE_URL) {
  throw new Error("Set CALLING_FIREBASE_CLI to firebase-tools 15.34.0's lib/bin/firebase.js and ONE_COMMAND_TEST_DATABASE_URL to the loopback command_test fixture.");
}
const children = [];
const inherited = Object.fromEntries(["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "COMSPEC", "WINDIR",
  "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "JAVA_HOME", "GOPATH", "GOCACHE", "GOMODCACHE"]
  .filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
const database = new URL(process.env.ONE_COMMAND_TEST_DATABASE_URL);
if (database.protocol !== "postgresql+psycopg2:" || !["127.0.0.1", "localhost"].includes(database.hostname)
  || database.pathname !== "/command_test" || database.search || database.hash || database.username !== "command_test") {
  throw new Error("Requires the canonical loopback command_test database without connection overrides.");
}
const temporary = await mkdtemp(path.join(tmpdir(), "hussh-calling-rehearsal-"));
const environment = { ...inherited, ENVIRONMENT: "development", DB_OFFLINE: "false", DB_UNIX_SOCKET: "",
  ONE_COMMAND_TEST_DATABASE_URL: process.env.ONE_COMMAND_TEST_DATABASE_URL,
  DB_HOST: database.hostname, DB_PORT: database.port || "5432", DB_USER: "command_test", DB_PASSWORD: decodeURIComponent(database.password) || "rehearsal",
  APP_SIGNING_KEY: randomBytes(32).toString("hex"), VAULT_DATA_KEY: randomBytes(32).toString("hex"),
  DIRECT_CALLS_ENABLED: "1", DIRECT_MESSAGES_E2EE_QUALIFIED: "1", DIRECT_CALLS_NATIVE_QUALIFIED: "1",
  DIRECT_CALLS_TURN_HOST: "127.0.0.1", DIRECT_CALLS_TURN_SECRET: randomBytes(32).toString("hex"),
  CALLING_REHEARSAL_PASSWORD: randomBytes(32).toString("base64url"),
  CALLING_REHEARSAL_DATABASE: `calling_rehearsal_${randomUUID().replaceAll("-", "")}`,
  HUSSH_TRUSTED_DEVICE_ENABLED: "true", GCLOUD_PROJECT: "demo-hushh-calling",
  FIREBASE_ADMIN_CREDENTIALS_JSON: "", FIREBASE_SERVICE_ACCOUNT_JSON: "", GOOGLE_APPLICATION_CREDENTIALS: "",
  PYTHONPATH: protocol, CI: "1", PLAYWRIGHT_START_SERVER: "0" };
environment.DB_NAME = environment.CALLING_REHEARSAL_DATABASE;
let vite;
let interrupted = false;

function safeLog(value) {
  let result = String(value).replace(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, "[token]");
  for (const [name, secret] of Object.entries(environment)) {
    if (/PASSWORD|SECRET|TOKEN|KEY|DATABASE_URL/.test(name) && secret && secret.length >= 8) result = result.replaceAll(secret, "[redacted]");
  }
  return result;
}

function launch(command, args, cwd, stream = false) {
  if (interrupted && !args.includes("--cleanup")) throw new Error("Rehearsal interrupted");
  const child = spawn(command, args, { cwd, env: environment, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  child.messages = "";
  child.done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} exited ${code}: ${safeLog(child.messages.slice(-6000))}`)));
  });
  child.done.catch(() => {});
  for (const output of [child.stdout, child.stderr]) output.on("data", chunk => {
    child.messages = (child.messages + chunk.toString()).slice(-16000);
    if (stream) process.stdout.write(safeLog(chunk));
  });
  children.push(child);
  return child;
}

async function unusedPort() {
  const socket = createSocketServer();
  await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

async function ready(probe, child, phase) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) await child.done;
    if (await probe().catch(() => false)) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`${phase} did not become ready: ${safeLog(child.messages.slice(-3000))}`);
}

async function stop(child) {
  // Never target a saved PID/group after its root has exited: it can be reused.
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    // Verify the live root's unique run marker before inspecting descendants.
    const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
      path.join(web, "scripts/testing/stop-rehearsal-process-tree.ps1"), "-RootProcessId", String(child.pid),
      "-RunMarker", path.basename(temporary)];
    const killer = spawn("powershell.exe", args, { windowsHide: true, stdio: "ignore" });
    await new Promise((resolve, reject) => { killer.once("error", reject); killer.once("exit", code => code === 0 ? resolve() : reject(new Error("Owned process-tree cleanup failed"))); });
  } else {
    const killGroup = signal => { try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; } };
    killGroup("SIGTERM");
    await Promise.race([child.done.catch(() => {}), new Promise(resolve => setTimeout(resolve, 5000))]);
    if (child.exitCode === null) killGroup("SIGKILL");
  }
  await child.done.catch(() => {});
}

async function health(port, route = "/") {
  return new Promise((resolve, reject) => {
    const request = get({ host: "127.0.0.1", port, path: route, timeout: 2000 }, response => {
      let body = "";
      response.on("data", chunk => { body += chunk; if (body.length > 4096) request.destroy(new Error("Oversized health response")); });
      response.on("end", () => resolve({ status: response.statusCode, body }));
    });
    request.on("timeout", () => request.destroy(new Error("Health probe timed out")));
    request.on("error", reject);
  });
}

let cleaning;
function cleanup() {
  return cleaning ??= (async () => {
    const failures = [];
    const attempt = async operation => { try { await operation(); } catch (error) { failures.push(error); } };
    await attempt(() => vite?.close());
    for (const child of [...children].reverse()) await attempt(() => stop(child));
    await attempt(() => launch(python, ["tests/calling_rehearsal.py", "--cleanup"], protocol).done);
    const safeTemporary = path.resolve(temporary);
    if (path.dirname(safeTemporary) !== path.resolve(tmpdir()) || !path.basename(safeTemporary).startsWith("hussh-calling-rehearsal-")) throw new Error("Unsafe rehearsal cleanup path");
    await attempt(() => rm(safeTemporary, { recursive: true, force: true }));
    if (failures.length) throw new AggregateError(failures, "Rehearsal cleanup incomplete");
  })();
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  interrupted = true;
  void cleanup().catch(error => console.error(safeLog(error.message))).finally(() => process.exit(130));
});

async function fixtureServer(backendPort, authPort) {
  const publicEnvironment = { NODE_ENV: "development", NEXT_PUBLIC_APP_ENV: "development",
    NEXT_PUBLIC_OBSERVABILITY_ENABLED: "false", NEXT_PUBLIC_FIREBASE_API_KEY: "calling-emulator",
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: "demo-hushh-calling", NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "demo-hushh-calling.firebaseapp.com",
    NEXT_PUBLIC_FIREBASE_APP_ID: "calling-rehearsal", NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: "123456789" };
  const entry = `/@fs/${path.join(web, "e2e/fixtures/direct-calls-rehearsal.tsx").replaceAll("\\", "/")}`;
  await writeFile(path.join(temporary, "index.html"), `<html><body data-auth-emulator="http://127.0.0.1:${authPort}"><div id="root"></div><script type="module" src="${entry}"></script></body></html>`);
  const server = await createServer({ root: temporary, configFile: false, envDir: false, publicDir: false, logLevel: "error",
    plugins: [react()], define: { "process.env": JSON.stringify(publicEnvironment) },
    resolve: { alias: { "@": web }, dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: await unusedPort(), strictPort: true,
      fs: { allow: [web, temporary] }, proxy: { "/api": `http://127.0.0.1:${backendPort}` } } });
  await server.listen();
  return server;
}

try {
  const [authPort, backendPort, hubPort, logPort] = await Promise.all(Array.from({ length: 4 }, unusedPort));
  environment.FIREBASE_AUTH_EMULATOR_HOST = `127.0.0.1:${authPort}`;
  const config = path.join(temporary, "firebase.json");
  await writeFile(config, JSON.stringify({ emulators: { auth: { host: "127.0.0.1", port: authPort },
    hub: { host: "127.0.0.1", port: hubPort }, logging: { host: "127.0.0.1", port: logPort }, ui: { enabled: false } } }));
  console.log("calling rehearsal: starting isolated Auth emulator");
  const emulator = launch(process.execPath, [firebase, "emulators:start", "--only", "auth", "--project", "demo-hushh-calling", "--config", config], temporary);
  await ready(async () => (await health(authPort)).status < 500, emulator, "Auth emulator");
  const relayBinary = path.join(temporary, process.platform === "win32" ? "relay.exe" : "relay");
  await launch(go, ["build", "-mod=readonly", "-o", relayBinary, "."], path.join(web, "e2e/fixtures/direct-calls-relay")).done;
  const relay = launch(relayBinary, [], temporary);
  await ready(async () => relay.messages.includes('"relayReady":true'), relay, "TURN relay");
  const backend = launch(python, ["tests/calling_rehearsal.py", "--port", String(backendPort), "--run-marker", path.basename(temporary)], protocol);
  await ready(async () => {
    const result = await health(backendPort, "/rehearsal-health");
    return result.status === 200 && JSON.parse(result.body).scope === "disposable-calling-rehearsal";
  }, backend, "Calling backend");
  vite = await fixtureServer(backendPort, authPort);
  environment.CALLING_REHEARSAL_ORIGIN = `http://127.0.0.1:${vite.httpServer.address().port}`;
  console.log("calling rehearsal: production UI/API/crypto/media, real PostgreSQL and UDP TURN; synthetic microphone; no traces or screenshots");
  await launch(process.execPath, ["node_modules/@playwright/test/cli.js", "test", "--config=playwright.calling.config.ts", `--output=${path.join(temporary, "browser-results")}`], web, true).done;
  await launch(python, ["tests/calling_rehearsal.py", "--inspect"], protocol, true).done;
  console.log("calling rehearsal passed; this does not qualify deployed TLS, history migration or physical native calls.");
} finally {
  await cleanup();
}
