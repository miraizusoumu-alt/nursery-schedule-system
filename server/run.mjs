import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import net from "node:net";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRuntimeDatabasePath } from "../db/sqlite.mjs";
import { createGateway } from "./gateway.mjs";
import { createProxyTrust } from "./request-context.mjs";
import { resolveGatewayPorts } from "./runtime-config.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const mode = process.argv[2] === "start" ? "start" : "dev";
const { publicPort, internalPort } = resolveGatewayPorts();
const isTrustedProxy = createProxyTrust({ enabled: process.env.NURSERY_TRUST_PROXY, trustedCidrs: process.env.NURSERY_TRUSTED_PROXY_CIDRS });
const vinextCli = resolve(projectRoot, "node_modules", "vinext", "dist", "cli.js");
const gatewaySecret = randomBytes(32).toString("base64url");
const verificationMode = process.env.NURSERY_VERIFICATION_MODE === "true";
const databasePath = resolveRuntimeDatabasePath(undefined, { verificationMode });

console.log(`Using database: ${databasePath}`);

function waitForPort(port, timeoutMilliseconds = 30_000) {
  const startedAt = Date.now();
  return new Promise((resolvePromise, reject) => {
    const attempt = () => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolvePromise();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - startedAt >= timeoutMilliseconds) reject(new Error("画面サーバーの起動を確認できませんでした。"));
        else setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

function localIpv4Addresses() {
  return Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
}

const child = spawn(process.execPath, [vinextCli, mode, "--port", String(internalPort), "--hostname", "127.0.0.1"], {
  cwd: projectRoot,
  env: {
    ...process.env,
    NURSERY_DB_PATH: databasePath,
    NURSERY_VERIFICATION_MODE: String(verificationMode),
    NURSERY_INTERNAL_PORT: String(internalPort),
    NURSERY_GATEWAY_SECRET: gatewaySecret,
    NURSERY_NODE_PRODUCTION_RUNTIME: String(mode === "start"),
  },
  stdio: "inherit",
});

let gateway;
let stopping = false;

async function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  if (gateway) await gateway.close();
  if (!child.killed) child.kill();
  process.exitCode = exitCode;
}

try {
  await waitForPort(internalPort);
  gateway = await createGateway({ databasePath, verificationMode, publicPort, internalPort, gatewaySecret, isTrustedProxy });
  console.log("\n認証付き試作サーバーを起動しました。");
  console.log(`PC: http://localhost:${publicPort}/`);
  for (const address of localIpv4Addresses()) console.log(`スマートフォン: http://${address}:${publicPort}/`);
  console.log("停止: この画面で Ctrl+C\n");
} catch (error) {
  console.error(error instanceof Error ? error.message : "起動できませんでした。");
  await stop(1);
}

child.once("exit", (code) => stop(code ?? 0));
process.once("SIGINT", () => stop(0));
process.once("SIGTERM", () => stop(0));
