import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createDevelopmentAuthAccounts } from "../db/auth-dev-accounts.mjs";
import { hashOpaqueValue } from "../lib/server/auth/security.mjs";
import { createGateway } from "../server/gateway.mjs";
import { createProxyTrust, InvalidRequestContext, publicRequestHeaders, resolveRequestContext } from "../server/request-context.mjs";
import { resolveGatewayPorts } from "../server/runtime-config.mjs";

function incoming(headers = {}, { peer = "127.0.0.1", encrypted = false, url = "/api/auth/session" } = {}) {
  const entries = Object.entries({ host: "local.example:3000", ...headers });
  return { headers: Object.fromEntries(entries), rawHeaders: entries.flat(), socket: { remoteAddress: peer, encrypted }, url };
}

const trustLoopback = createProxyTrust({ enabled: "true", trustedCidrs: "127.0.0.1/32, ::1/128" });
const forwarded = { "x-forwarded-proto": "https", "x-forwarded-host": "stage.example", "x-forwarded-for": "203.0.113.10" };
const trustedContext = (request) => resolveRequestContext(request, { publicPort: 3000, isTrustedProxy: trustLoopback });

test("keeps direct HTTP and HTTPS origins and ignores untrusted forwarded headers", () => {
  for (const options of [{}, { isTrustedProxy: createProxyTrust() }]) {
    const request = incoming({ ...forwarded, forwarded: "host=evil.example;proto=https", "x-real-ip": "198.51.100.20" });
    const context = resolveRequestContext(request, { publicPort: 3000, ...options });
    assert.equal(context.origin, "http://local.example:3000");
    assert.equal(context.clientIp, "127.0.0.1");
    const headers = publicRequestHeaders(request, context);
    assert.equal(headers["x-forwarded-host"], "local.example:3000");
    assert.equal(headers["x-forwarded-proto"], "http");
    assert.equal(headers.forwarded, undefined);
    assert.equal(headers["x-real-ip"], undefined);
  }
  assert.equal(trustedContext(incoming({}, { encrypted: true })).origin, "https://local.example:3000");
});

test("requires explicit valid proxy trust and a matching TCP peer", () => {
  for (const config of [{ enabled: "yes" }, { enabled: "true" }, { enabled: "true", trustedCidrs: "*" },
    { enabled: "true", trustedCidrs: "0.0.0.0/0" }, { enabled: "true", trustedCidrs: "::/0" },
    { enabled: "true", trustedCidrs: "127.0.0.1/33" }, { enabled: "true", trustedCidrs: "127.0.0.1," }]) {
    assert.throws(() => createProxyTrust(config));
  }
  assert.equal(trustedContext(incoming(forwarded, { peer: "192.0.2.10" })).origin, "http://local.example:3000");
  assert.equal(trustedContext(incoming(forwarded, { peer: "::ffff:7f00:1" })).origin, "https://stage.example");
});

test("builds one validated public origin for a trusted HTTPS ingress", () => {
  const context = trustedContext(incoming(forwarded));
  assert.deepEqual(context, {
    origin: "https://stage.example", host: "stage.example", protocol: "https",
    clientIp: "203.0.113.10", url: "https://stage.example/api/auth/session",
  });
  for (const host of ["localhost", "stage.example:443", "stage.example:8443", "127.0.0.1:3000", "[::1]:8443", "xn--eckwd4c7c.example"]) {
    assert.equal(trustedContext(incoming({ ...forwarded, "x-forwarded-host": host })).origin, new URL(`https://${host}`).origin);
  }
});

test("rejects malformed protocols hosts duplicate fields and ambiguous origin chains", () => {
  for (const proto of ["ftp", "javascript", "HTTPS", "", "https,http", "https, https", "https\r\nInjected: yes"]) {
    assert.throws(() => trustedContext(incoming({ ...forwarded, "x-forwarded-proto": proto })), InvalidRequestContext);
  }
  for (const host of ["", "stage.example/path", "stage.example?x=1", "stage.example#x", "user@stage.example", "stage.example\\evil",
    "stage.example:0", "stage.example:65536", "stage.example,evil.example", "bad host", "stage.example\r\nHost: evil.example",
    "stage%2eexample", "-bad.example", "bad..example", "[::1", "127.1", "0x7f000001"]) {
    assert.throws(() => trustedContext(incoming({ ...forwarded, "x-forwarded-host": host })), InvalidRequestContext);
  }
  for (const headers of [{ "x-forwarded-proto": "https" }, { "x-forwarded-host": "stage.example" }]) {
    assert.throws(() => trustedContext(incoming(headers)), InvalidRequestContext);
  }
  for (const name of ["host", "x-forwarded-proto", "x-forwarded-host"]) {
    const request = incoming(forwarded);
    request.rawHeaders.push(name, request.headers[name]);
    assert.throws(() => trustedContext(request), InvalidRequestContext);
  }
});

test("ignores malformed proxy values entirely when the peer is not trusted", () => {
  const context = trustedContext(incoming({ "x-forwarded-proto": "javascript", "x-forwarded-host": "evil/path" }, { peer: "192.0.2.1" }));
  assert.equal(context.origin, "http://local.example:3000");
});

test("takes the first untrusted IP from the right and ignores client-supplied leftmost IPs", () => {
  const isTrustedProxy = createProxyTrust({ enabled: "true", trustedCidrs: "127.0.0.1,10.0.0.0/24,2001:db8:1::/64" });
  const context = resolveRequestContext(incoming({ ...forwarded, "x-forwarded-for": "198.51.100.99, 203.0.113.10, 10.0.0.3" }), { publicPort: 3000, isTrustedProxy });
  assert.equal(context.clientIp, "203.0.113.10");
  assert.equal(isTrustedProxy("2001:db8:1::a"), true);
  assert.equal(isTrustedProxy("2001:db8:2::a"), false);
  assert.equal(trustedContext(incoming({ ...forwarded, "x-forwarded-for": "2001:0db8::10" })).clientIp, "2001:db8::10");
  for (const ip of ["unknown", "203.0.113.10:8080", "[::1]", "fe80::1%eth0", "203.0.113.1,", "203.0.113.1\n", Array(33).fill("127.0.0.1").join(",")]) {
    assert.throws(() => trustedContext(incoming({ ...forwarded, "x-forwarded-for": ip })), InvalidRequestContext);
  }
});

test("rejects request targets that could override the public origin", () => {
  for (const url of ["https://evil.example/api", "//evil.example/api", "/\\evil.example/api", "/api\r\nheader"]) {
    assert.throws(() => trustedContext(incoming(forwarded, { url })), InvalidRequestContext);
  }
  assert.equal(trustedContext(incoming(forwarded, { url: "/api/auth/session?next=%2Fadmin" })).url, "https://stage.example/api/auth/session?next=%2Fadmin");
});

test("resolves local and platform ports deterministically and rejects invalid or equal ports", () => {
  assert.deepEqual(resolveGatewayPorts({}), { publicPort: 3000, internalPort: 3100 });
  assert.deepEqual(resolveGatewayPorts({ PORT: "9000" }), { publicPort: 9000, internalPort: 3100 });
  assert.deepEqual(resolveGatewayPorts({ PORT: "9000", NURSERY_PORT: "9001", NURSERY_INTERNAL_PORT: "9002" }), { publicPort: 9001, internalPort: 9002 });
  for (const value of ["0", "65536", "-1", "3000junk", "1e3", " 3000", "1.5"]) {
    assert.throws(() => resolveGatewayPorts({ PORT: value }));
    assert.throws(() => resolveGatewayPorts({ NURSERY_INTERNAL_PORT: value }));
  }
  assert.throws(() => resolveGatewayPorts({ PORT: "3100" }));
});

test("pins the same Node 22 release in the standard runtime manifests", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  const version = (await readFile(new URL("../.node-version", import.meta.url), "utf8")).trim();
  assert.match(version, /^22\.\d+\.\d+$/);
  assert.equal(pkg.engines.node, version);
  assert.equal(lock.packages[""].engines.node, version);
});

async function withGateway(proxyEnabled, run) {
  const directory = await mkdtemp(resolve(tmpdir(), "nursery-gateway-proxy-"));
  const secret = randomBytes(32).toString("base64url");
  const received = [];
  const renderer = http.createServer((request, response) => {
    received.push(request.headers);
    response.end("authenticated renderer");
  });
  renderer.on("upgrade", (request, socket) => {
    received.push(request.headers);
    socket.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
  });
  await new Promise((done) => renderer.listen(0, "127.0.0.1", done));
  let gateway;
  try {
    gateway = await createGateway({ databasePath: resolve(directory, "only-test.sqlite"), verificationMode: false,
      publicPort: 0, hostname: "127.0.0.1", internalPort: renderer.address().port, gatewaySecret: secret,
      isTrustedProxy: proxyEnabled ? trustLoopback : createProxyTrust(), runtimeSecureCookies: proxyEnabled });
    const accounts = await createDevelopmentAuthAccounts(gateway.database);
    await run({ gateway, accounts, received, secret, base: `http://127.0.0.1:${gateway.server.address().port}` });
  } finally {
    if (gateway) await gateway.close();
    await new Promise((done) => renderer.close(done));
    await rm(directory, { recursive: true, force: true });
  }
}

for (const proxyEnabled of [false, true]) {
  test(`authenticates, authorizes, updates with CSRF and logs out over ${proxyEnabled ? "trusted HTTPS proxy headers" : "direct HTTP"}`, async () => {
    await withGateway(proxyEnabled, async ({ gateway, accounts, base, received, secret }) => {
      const origin = proxyEnabled ? "https://stage.example" : base;
      const transport = { ...forwarded, forwarded: "host=evil.example;proto=ftp", "x-real-ip": "198.51.100.99", "x-forwarded-port": "9999", "x-nursery-gateway-secret": "forged" };
      const request = (path, { method = "GET", body, headers = {} } = {}) => fetch(`${base}${path}`, {
        method, headers: { ...transport, origin, "content-type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual",
      });
      const blockedPage = await request("/admin/schedules");
      assert.equal(blockedPage.status, 303);
      assert.equal(blockedPage.headers.get("location"), `${origin}/auth/admin`);
      for (const type of ["master", "family"]) {
        const account = accounts.find((entry) => entry.type === type);
        const loginPath = `/api/auth/login/${type === "family" ? "family" : "admin"}`;
        const wrongOrigin = await request(loginPath, { method: "POST", body: { loginId: account.loginId, password: account.temporaryPassword }, headers: { origin: "https://other.example" } });
        assert.equal(wrongOrigin.status, 403);
        assert.equal((await wrongOrigin.json()).code, "ORIGIN_MISMATCH");
        const login = await request(loginPath, { method: "POST", body: { loginId: account.loginId, password: account.temporaryPassword } });
        assert.equal(login.status, 200);
        const cookies = login.headers.getSetCookie();
        assert.equal(cookies.length, 2);
        for (const cookie of cookies) {
          assert.match(cookie, /SameSite=Lax/);
          assert.equal(cookie.includes("Secure"), proxyEnabled);
        }
        assert.match(cookies.find((value) => value.startsWith("nursery_session=")), /HttpOnly/);
        assert.doesNotMatch(cookies.find((value) => value.startsWith("nursery_csrf=")), /HttpOnly/);
        const cookie = cookies.map((value) => value.split(";")[0]).join("; ");
        const csrf = decodeURIComponent(cookies.find((value) => value.startsWith("nursery_csrf=")).split(";")[0].slice("nursery_csrf=".length));
        const authenticated = { cookie, "x-csrf-token": csrf };
        assert.equal((await request("/api/auth/session", { headers: authenticated })).status, 200);
        const page = await request(type === "family" ? "/parent/schedule" : "/admin/schedules", { headers: authenticated });
        assert.equal(page.status, 200);
        assert.equal(await page.text(), "authenticated renderer");
        assert.equal(received.at(-1)["x-forwarded-host"], new URL(origin).host);
        assert.equal(received.at(-1)["x-forwarded-proto"], proxyEnabled ? "https" : "http");
        assert.equal(received.at(-1)["x-nursery-gateway-secret"], secret);
        assert.equal(received.at(-1).forwarded, undefined);
        assert.equal(received.at(-1)["x-forwarded-port"], undefined);
        if (type === "master") {
          const update = { method: "PATCH", body: { settings: { loginWindowMinutes: 20 }, currentPassword: account.temporaryPassword } };
          const missingCsrf = await request("/api/admin/auth-settings", { ...update, headers: { cookie } });
          assert.equal(missingCsrf.status, 403);
          assert.equal((await missingCsrf.json()).code, "CSRF_INVALID");
          const wrong = await request("/api/admin/auth-settings", { ...update, headers: { ...authenticated, origin: "https://other.example" } });
          assert.equal((await wrong.json()).code, "ORIGIN_MISMATCH");
          const changed = await request("/api/admin/auth-settings", { ...update, headers: authenticated });
          assert.equal(changed.status, 200);
          assert.equal(gateway.service.getSettings().loginWindowMinutes, 20);
          const row = gateway.database.prepare("SELECT password_hash FROM administrators WHERE login_id = ?").get(account.loginId);
          assert.match(row.password_hash, /^scrypt\$/);
        } else {
          assert.equal((await request("/api/family/me", { headers: authenticated })).status, 200);
          assert.equal((await request("/api/admin/accounts", { headers: authenticated })).status, 403);
          assert.equal((await request("/admin/schedules", { headers: authenticated })).status, 403);
        }
        const logout = await request("/api/auth/logout", { method: "POST", headers: authenticated });
        assert.equal(logout.status, 200);
        assert.ok(logout.headers.getSetCookie().every((value) => value.includes("Max-Age=0") && value.includes("SameSite=Lax") && value.includes("Secure") === proxyEnabled));
        assert.equal((await request("/api/auth/session", { headers: authenticated })).status, 401);
      }
      const sources = gateway.database.prepare("SELECT DISTINCT source_hash FROM auth_login_attempts").all();
      assert.deepEqual(sources.map((row) => row.source_hash), [hashOpaqueValue(proxyEnabled ? "203.0.113.10" : "127.0.0.1")]);
      const malformed = await request("/api/auth/login/admin", { method: "POST", body: {}, headers: { "x-forwarded-host": "bad.example/path" } });
      assert.equal(malformed.status, proxyEnabled ? 400 : 401);
    });
  });
}

test("sanitizes websocket forwarding through the same trusted request context", async () => {
  await withGateway(true, async ({ base, received, secret }) => {
    const response = await new Promise((done, reject) => {
      const socket = net.connect(Number(new URL(base).port), "127.0.0.1");
      let text = "";
      socket.on("connect", () => socket.write("GET /ws HTTP/1.1\r\nHost: stage.example\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nX-Forwarded-Proto: https\r\nX-Forwarded-Host: stage.example\r\nForwarded: host=evil.example\r\nX-Nursery-Gateway-Secret: forged\r\n\r\n"));
      socket.on("data", (chunk) => { text += chunk; });
      socket.on("end", () => { socket.destroy(); done(text); });
      socket.on("error", reject);
    });
    assert.match(response, /^HTTP\/1.1 101/);
    assert.equal(received.at(-1).forwarded, undefined);
    assert.equal(received.at(-1)["x-forwarded-proto"], "https");
    assert.equal(received.at(-1)["x-nursery-gateway-secret"], secret);
  });
});
