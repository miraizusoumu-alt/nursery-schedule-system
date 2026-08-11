import http from "node:http";
import net from "node:net";
import { applyMigrations, openDatabase } from "../db/sqlite.mjs";
import { createAuthService } from "../lib/server/auth/service.mjs";
import { authorizeProtectedPage, handleAuthApiRequest } from "./auth-http.mjs";

const MAX_AUTH_BODY_BYTES = 1024 * 1024;
const GATEWAY_SECRET_HEADER = "x-nursery-gateway-secret";

function incomingUrl(request, publicPort) {
  const host = request.headers.host || `localhost:${publicPort}`;
  const protocol = request.socket.encrypted ? "https" : "http";
  return `${protocol}://${host}${request.url || "/"}`;
}

function requestHeaders(request) {
  const headers = new Headers();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const key = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    if (key && value !== undefined) headers.append(key, value);
  }
  headers.set("x-forwarded-for", request.socket.remoteAddress || "unknown");
  return headers;
}

async function readBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_AUTH_BODY_BYTES) throw new Error("BODY_TOO_LARGE");
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

async function toFetchRequest(request, publicPort, includeBody) {
  const body = includeBody && request.method !== "GET" && request.method !== "HEAD" ? await readBody(request) : undefined;
  return new Request(incomingUrl(request, publicPort), {
    method: request.method,
    headers: requestHeaders(request),
    body,
  });
}

async function sendFetchResponse(response, outgoing) {
  outgoing.statusCode = response.status;
  const setCookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  for (const [key, value] of response.headers) {
    if (key.toLowerCase() !== "set-cookie") outgoing.setHeader(key, value);
  }
  if (setCookies.length) outgoing.setHeader("set-cookie", setCookies);
  const body = Buffer.from(await response.arrayBuffer());
  outgoing.end(body);
}

function proxyHttp(incoming, outgoing, internalPort, gatewaySecret) {
  const headers = { ...incoming.headers };
  headers.host = `127.0.0.1:${internalPort}`;
  headers["x-forwarded-host"] = incoming.headers.host;
  headers["x-forwarded-proto"] = incoming.socket.encrypted ? "https" : "http";
  headers["x-forwarded-for"] = incoming.socket.remoteAddress || "unknown";
  headers[GATEWAY_SECRET_HEADER] = gatewaySecret;
  const proxy = http.request({
    hostname: "127.0.0.1",
    port: internalPort,
    method: incoming.method,
    path: incoming.url,
    headers,
  }, (response) => {
    outgoing.writeHead(response.statusCode || 502, response.headers);
    response.pipe(outgoing);
  });
  proxy.on("error", () => {
    if (!outgoing.headersSent) outgoing.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    outgoing.end("画面サーバーを準備しています。少し待ってから再読み込みしてください。");
  });
  incoming.pipe(proxy);
}

function proxyUpgrade(request, socket, head, internalPort, gatewaySecret) {
  const upstream = net.connect(internalPort, "127.0.0.1", () => {
    const lines = [`${request.method} ${request.url} HTTP/${request.httpVersion}`];
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      const key = request.rawHeaders[index];
      if (key.toLowerCase() === GATEWAY_SECRET_HEADER) continue;
      const value = key.toLowerCase() === "host" ? `127.0.0.1:${internalPort}` : request.rawHeaders[index + 1];
      lines.push(`${key}: ${value}`);
    }
    lines.push(`${GATEWAY_SECRET_HEADER}: ${gatewaySecret}`);
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
}

export async function createGateway({
  databasePath,
  publicPort = 3000,
  internalPort = 3100,
  hostname = "0.0.0.0",
  gatewaySecret,
  runtimeSecureCookies = process.env.NURSERY_SECURE_COOKIES === "true",
} = {}) {
  if (typeof gatewaySecret !== "string" || gatewaySecret.length < 32) {
    throw new Error("認証ゲートウェイの内部接続情報が正しくありません。");
  }
  const database = openDatabase(databasePath);
  await applyMigrations(database);
  const service = createAuthService({ database });

  const server = http.createServer(async (incoming, outgoing) => {
    try {
      const isApi = incoming.url?.startsWith("/api/") === true;
      if (isApi) {
        const request = await toFetchRequest(incoming, publicPort, true);
        const response = await handleAuthApiRequest(request, { service, runtimeSecureCookies });
        if (response) return await sendFetchResponse(response, outgoing);
      } else if (incoming.method === "GET" || incoming.method === "HEAD") {
        const request = await toFetchRequest(incoming, publicPort, false);
        const response = authorizeProtectedPage(request, service);
        if (response) return await sendFetchResponse(response, outgoing);
      }
      proxyHttp(incoming, outgoing, internalPort, gatewaySecret);
    } catch (error) {
      const status = error instanceof Error && error.message === "BODY_TOO_LARGE" ? 413 : 500;
      outgoing.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      outgoing.end(JSON.stringify({ ok: false, message: status === 413 ? "送信内容が大きすぎます。" : "処理を完了できませんでした。" }));
    }
  });
  server.on("upgrade", (request, socket, head) => proxyUpgrade(request, socket, head, internalPort, gatewaySecret));

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(publicPort, hostname, resolve);
  });
  return {
    database,
    server,
    service,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      database.close();
    },
  };
}
