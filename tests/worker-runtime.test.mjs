import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { resolveGatewaySecret } from "../worker/gateway-secret.mjs";

const buildTimeSecret = process.env.NURSERY_GATEWAY_SECRET;
const secret = () => randomBytes(32).toString("base64url");
const protectedPaths = ["/account/password", "/admin/accounts", "/admin/schedules", "/parent/account", "/parent/schedule"];

function runtime(t, marker, value) {
  const names = ["NURSERY_NODE_PRODUCTION_RUNTIME", "NURSERY_GATEWAY_SECRET"];
  const previous = names.map((name) => process.env[name]);
  const set = (name, value) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  t.after(() => names.forEach((name, index) => set(name, previous[index])));
  names.forEach((name, index) => set(name, [marker, value][index]));
}

async function builtWorker() {
  return (await import(new URL("../dist/server/index.js", import.meta.url).href)).default;
}

async function requestWorker(worker, path, bindings, header) {
  return worker.fetch(new Request(`http://localhost${path}`, {
    headers: header === undefined ? {} : { "x-nursery-gateway-secret": header },
  }), bindings, { waitUntil(promise) { Promise.resolve(promise).catch(() => {}); }, passThroughOnException() {} });
}

test("uses Worker bindings even when the Node process has a different runtime secret", (t) => {
  const bindingSecret = secret();
  runtime(t, "true", secret());
  assert.ok(resolveGatewaySecret({ NURSERY_GATEWAY_SECRET: bindingSecret }) === bindingSecret);
  for (const bindings of [{}, { NURSERY_GATEWAY_SECRET: undefined }, { NURSERY_GATEWAY_SECRET: "" },
    { NURSERY_GATEWAY_SECRET: "invalid" }, { NURSERY_GATEWAY_SECRET: 123 }, null, [], "invalid",
    Object.create({ NURSERY_GATEWAY_SECRET: bindingSecret })]) {
    assert.equal(resolveGatewaySecret(bindings), null);
  }
});

test("requires undefined bindings and the runner's exact Node production marker", (t) => {
  const value = secret();
  runtime(t, "true", value);
  assert.ok(resolveGatewaySecret(undefined) === value);
  for (const marker of [undefined, "false", "1", "TRUE", " true ", "development"]) {
    if (marker === undefined) delete process.env.NURSERY_NODE_PRODUCTION_RUNTIME;
    else process.env.NURSERY_NODE_PRODUCTION_RUNTIME = marker;
    assert.equal(resolveGatewaySecret(undefined), null);
  }
  // Dev bindings remain usable without a Node production marker.
  assert.ok(resolveGatewaySecret({ NURSERY_GATEWAY_SECRET: value }) === value);
});

test("accepts only the runner's canonical 32-byte base64url secret format", (t) => {
  runtime(t, "true", undefined);
  assert.equal(resolveGatewaySecret(undefined), null);
  for (let index = 0; index < 100; index += 1) {
    const value = secret();
    process.env.NURSERY_GATEWAY_SECRET = value;
    assert.ok(resolveGatewaySecret(undefined) === value);
    assert.ok(resolveGatewaySecret({ NURSERY_GATEWAY_SECRET: value }) === value);
  }
  for (const value of ["", "A".repeat(32), "A".repeat(42), "A".repeat(44), "A".repeat(42) + "B",
    secret() + "=", " " + secret(), secret() + "\n", "+" + "A".repeat(42), "/" + "A".repeat(42)]) {
    process.env.NURSERY_GATEWAY_SECRET = value;
    assert.equal(resolveGatewaySecret(undefined), null);
    assert.equal(resolveGatewaySecret({ NURSERY_GATEWAY_SECRET: value }), null);
  }
});

test("renders every protected built page through Worker bindings and Node runtime paths without leaking secrets", async (t) => {
  const nodeSecret = secret();
  const bindingSecret = secret();
  runtime(t, "true", nodeSecret);
  const logs = ["log", "warn", "error", "debug", "info"].map((method) => t.mock.method(console, method, () => {}));
  const worker = await builtWorker();
  for (const [bindings, value] of [[undefined, nodeSecret], [{ NURSERY_GATEWAY_SECRET: bindingSecret }, bindingSecret]]) {
    for (const path of protectedPaths) {
      const response = await requestWorker(worker, path, bindings, value);
      assert.equal(response.status, 200, path);
      const body = await response.text();
      assert.match(body, /<!DOCTYPE html>/i);
      assert.ok(!body.includes(nodeSecret) && !body.includes(bindingSecret), "Response must not contain runtime secrets");
      assert.ok(!JSON.stringify([...response.headers]).includes(value), "Headers must not contain runtime secrets");
    }
  }
  assert.ok(logs.every((log) => log.mock.callCount() === 0), "Secret lookup and rendering must not log secrets");
});

test("rejects missing and wrong gateway headers on every protected built page", async (t) => {
  const value = secret();
  runtime(t, "true", value);
  const worker = await builtWorker();
  for (const bindings of [undefined, { NURSERY_GATEWAY_SECRET: value }]) {
    for (const path of protectedPaths) {
      for (const header of [undefined, secret(), value + "," + value]) {
        const response = await requestWorker(worker, path, bindings, header);
        assert.equal(response.status, 404, path);
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.equal(await response.text(), "Not Found");
      }
    }
  }
});

test("fails closed in the built Worker when bindings or runtime configuration are invalid", async (t) => {
  const value = secret();
  runtime(t, "true", value);
  const worker = await builtWorker();
  for (const bindings of [{}, { NURSERY_GATEWAY_SECRET: "" }, { NURSERY_GATEWAY_SECRET: "invalid" }, null, []]) {
    const response = await requestWorker(worker, "/admin/schedules", bindings, value);
    assert.equal(response.status, 404);
    await response.text();
  }
  for (const [marker, expected] of [[undefined, value], ["false", value], ["true", undefined], ["true", "invalid"]]) {
    if (marker === undefined) delete process.env.NURSERY_NODE_PRODUCTION_RUNTIME;
    else process.env.NURSERY_NODE_PRODUCTION_RUNTIME = marker;
    if (expected === undefined) delete process.env.NURSERY_GATEWAY_SECRET;
    else process.env.NURSERY_GATEWAY_SECRET = expected;
    const response = await requestWorker(worker, "/parent/schedule", undefined, value);
    assert.equal(response.status, 404);
    await response.text();
  }
});

test("keeps development bindings authoritative with the Node production marker disabled", async (t) => {
  const value = secret();
  runtime(t, "false", secret());
  const worker = await builtWorker();
  const response = await requestWorker(worker, "/admin/schedules", { NURSERY_GATEWAY_SECRET: value }, value);
  assert.equal(response.status, 200);
  await response.text();
  assert.equal((await requestWorker(worker, "/admin/schedules", undefined, value)).status, 404);
});

test("omits runtime secret values from build artifacts and secret code from client assets", async () => {
  async function files(directory) {
    const result = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
      if (entry.isDirectory()) result.push(...await files(url));
      else result.push(url);
    }
    return result;
  }
  const artifacts = await files(new URL("../dist/", import.meta.url));
  const config = JSON.parse(await readFile(new URL("../dist/server/wrangler.json", import.meta.url), "utf8"));
  assert.equal(Object.hasOwn(config.vars ?? {}, "NURSERY_GATEWAY_SECRET"), false);
  assert.equal(Object.hasOwn(config.vars ?? {}, "NURSERY_NODE_PRODUCTION_RUNTIME"), false);
  for (const file of artifacts) {
    const content = await readFile(file);
    if (buildTimeSecret) assert.ok(!content.includes(buildTimeSecret), "Build artifacts must not contain the build-time test secret");
    if (file.pathname.includes("/dist/client/")) {
      assert.ok(!content.includes("NURSERY_GATEWAY_SECRET"), "Worker secret code must not enter client assets");
      assert.ok(!content.includes("NURSERY_NODE_PRODUCTION_RUNTIME"), "Runtime marker must not enter client assets");
    }
  }
});
