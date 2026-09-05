import http from "node:http";
import net from "node:net";
import { applyMigrations, openDatabase, resolveRuntimeDatabasePath } from "../db/sqlite.mjs";
import { createAuthService } from "../lib/server/auth/service.mjs";
import { createFamilyScheduleService } from "../lib/server/family-schedule/service.mjs";
import { createStaffManagementService } from "../lib/server/staff-management/service.mjs";
import { createStaffPreferenceService } from "../lib/server/staff-preference/service.mjs";
import { createStaffScheduleService } from "../lib/server/staff-schedule/service.mjs";
import { authorizeProtectedPage, handleAuthApiRequest } from "./auth-http.mjs";
import { handleAdminScheduleApiRequest } from "./admin-schedule-http.mjs";
import { handleFamilyScheduleApiRequest } from "./family-schedule-http.mjs";
import { handleStaffManagementApiRequest } from "./staff-management-http.mjs";
import { handleStaffPreferenceApiRequest } from "./staff-preference-http.mjs";
import { handleStaffScheduleApiRequest } from "./staff-schedule-http.mjs";
import { createProxyTrust, InvalidRequestContext, publicRequestHeaders, resolveRequestContext } from "./request-context.mjs";

const MAX_AUTH_BODY_BYTES = 1024 * 1024;
const GATEWAY_SECRET_HEADER = "x-nursery-gateway-secret";

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

async function toFetchRequest(request, context, includeBody) {
  const body = includeBody && request.method !== "GET" && request.method !== "HEAD" ? await readBody(request) : undefined;
  return new Request(context.url, {
    method: request.method,
    headers: publicRequestHeaders(request, context),
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

function proxyHttp(incoming, outgoing, internalPort, gatewaySecret, context) {
  const headers = publicRequestHeaders(incoming, context);
  headers.host = `127.0.0.1:${internalPort}`;
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

function proxyUpgrade(request, socket, head, internalPort, gatewaySecret, context) {
  const upstream = net.connect(internalPort, "127.0.0.1", () => {
    const lines = [`${request.method} ${request.url} HTTP/${request.httpVersion}`];
    const headers = publicRequestHeaders(request, context);
    headers.host = `127.0.0.1:${internalPort}`;
    for (const [key, value] of Object.entries(headers)) {
      for (const item of Array.isArray(value) ? value : [value]) lines.push(`${key}: ${item}`);
    }
    lines.push(`${GATEWAY_SECRET_HEADER}: ${gatewaySecret}`);
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  socket.on("error", () => upstream.destroy());
  upstream.on("error", () => socket.destroy());
}

export async function createGateway({
  databasePath,
  publicPort = 3000,
  internalPort = 3100,
  hostname = "0.0.0.0",
  gatewaySecret,
  verificationMode = process.env.NURSERY_VERIFICATION_MODE === "true",
  runtimeSecureCookies = process.env.NURSERY_SECURE_COOKIES === "true",
  isTrustedProxy = createProxyTrust({ enabled: process.env.NURSERY_TRUST_PROXY, trustedCidrs: process.env.NURSERY_TRUSTED_PROXY_CIDRS }),
} = {}) {
  if (typeof gatewaySecret !== "string" || gatewaySecret.length < 32) {
    throw new Error("認証ゲートウェイの内部接続情報が正しくありません。");
  }
  const resolvedDatabasePath = resolveRuntimeDatabasePath(databasePath, { verificationMode });
  const database = openDatabase(resolvedDatabasePath);
  await applyMigrations(database);
  const service = createAuthService({ database });
  const familyScheduleService = createFamilyScheduleService({ database });
  const staffManagementService = createStaffManagementService({ database });
  const staffPreferenceService = createStaffPreferenceService({ database });
  const staffScheduleService = createStaffScheduleService({
    database,
    automaticRequirementSlotsProvider: (actor, input) => {
      return familyScheduleService.administratorQuarterHourStaffingRequirements(actor, input);
    },
  });

  const server = http.createServer(async (incoming, outgoing) => {
    try {
      const context = resolveRequestContext(incoming, { publicPort, isTrustedProxy });
      const isApi = incoming.url?.startsWith("/api/") === true;
      if (isApi) {
        const request = await toFetchRequest(incoming, context, true);
        const adminScheduleResponse = await handleAdminScheduleApiRequest(request, { service: familyScheduleService, authService: service });
        if (adminScheduleResponse) return await sendFetchResponse(adminScheduleResponse, outgoing);
        const staffScheduleResponse = await handleStaffScheduleApiRequest(request, { service: staffScheduleService, authService: service });
        if (staffScheduleResponse) return await sendFetchResponse(staffScheduleResponse, outgoing);
        const staffPreferenceResponse = await handleStaffPreferenceApiRequest(request, { service: staffPreferenceService, authService: service });
        if (staffPreferenceResponse) return await sendFetchResponse(staffPreferenceResponse, outgoing);
        const staffManagementResponse = await handleStaffManagementApiRequest(request, { service: staffManagementService, authService: service });
        if (staffManagementResponse) return await sendFetchResponse(staffManagementResponse, outgoing);
        const familyScheduleResponse = await handleFamilyScheduleApiRequest(request, { service: familyScheduleService, authService: service });
        if (familyScheduleResponse) return await sendFetchResponse(familyScheduleResponse, outgoing);
        const response = await handleAuthApiRequest(request, { service, runtimeSecureCookies });
        if (response) return await sendFetchResponse(response, outgoing);
      } else if (incoming.method === "GET" || incoming.method === "HEAD") {
        const request = await toFetchRequest(incoming, context, false);
        const response = authorizeProtectedPage(request, service);
        if (response) return await sendFetchResponse(response, outgoing);
      }
      proxyHttp(incoming, outgoing, internalPort, gatewaySecret, context);
    } catch (error) {
      const status = error instanceof InvalidRequestContext ? 400 : error instanceof Error && error.message === "BODY_TOO_LARGE" ? 413 : 500;
      outgoing.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      outgoing.end(JSON.stringify({ ok: false, message: status === 400 ? "リクエストの接続情報が正しくありません。" : status === 413 ? "送信内容が大きすぎます。" : "処理を完了できませんでした。" }));
    }
  });
  server.on("upgrade", (request, socket, head) => {
    try {
      const context = resolveRequestContext(request, { publicPort, isTrustedProxy });
      proxyUpgrade(request, socket, head, internalPort, gatewaySecret, context);
    } catch {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(publicPort, hostname, resolve);
  });
  return {
    database,
    databasePath: resolvedDatabasePath,
    server,
    service,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      database.close();
    },
  };
}
