import { BlockList, isIP, SocketAddress } from "node:net";

export class InvalidRequestContext extends Error {
  constructor() {
    super("Invalid public request context");
  }
}

function invalid() {
  throw new InvalidRequestContext();
}

function normalizedIp(value) {
  if (typeof value !== "string" || value.includes("%") || !isIP(value)) return invalid();
  const address = new SocketAddress({ address: value, family: isIP(value) === 4 ? "ipv4" : "ipv6" }).address;
  return address.startsWith("::ffff:") && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
}

export function createProxyTrust({ enabled = "false", trustedCidrs = "" } = {}) {
  if (!["true", "false"].includes(enabled)) throw new Error("NURSERY_TRUST_PROXY must be true or false.");
  if (enabled === "false") return () => false;
  const entries = trustedCidrs.split(",").map((entry) => entry.trim());
  if (entries.some((entry) => !entry)) throw new Error("NURSERY_TRUSTED_PROXY_CIDRS is required when proxy trust is enabled.");
  const allowed = new BlockList();
  for (const entry of entries) {
    const [address, prefix, extra] = entry.split("/");
    const version = isIP(address);
    if (!version || address.includes("%") || extra !== undefined) throw new Error("Invalid trusted proxy IP/CIDR.");
    const family = version === 4 ? "ipv4" : "ipv6";
    if (prefix === undefined) allowed.addAddress(address, family);
    else {
      // Do not permit an accidental trust-all network.
      if (!/^\d+$/.test(prefix) || Number(prefix) < 1 || Number(prefix) > (version === 4 ? 32 : 128)) {
        throw new Error("Invalid trusted proxy CIDR prefix.");
      }
      allowed.addSubnet(address, Number(prefix), family);
    }
  }
  return (address) => {
    const version = isIP(address ?? "");
    return Boolean(version) && !address.includes("%") && allowed.check(address, version === 4 ? "ipv4" : "ipv6");
  };
}

function headerValues(request, name) {
  const values = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === name) values.push(request.rawHeaders[index + 1]);
  }
  return values;
}

function singleHeader(request, name) {
  const values = headerValues(request, name);
  if (!values.length) return undefined;
  // Host/protocol chains have no consistent append convention. Require the
  // trusted ingress to overwrite each with exactly one authoritative value.
  if (values.length !== 1 || !/^[\x21-\x7e]+$/.test(values[0]) || values[0].includes(",")) return invalid();
  return values[0];
}

function validHost(value) {
  if (!value || value.length > 260) return invalid();
  const match = /^(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9.-]+)(?::([0-9]+))?$/.exec(value);
  if (!match) return invalid();
  const [, hostname, port] = match;
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) return invalid();
  if (hostname.startsWith("[")) {
    if (isIP(hostname.slice(1, -1)) !== 6) return invalid();
  } else {
    const domain = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
    if (domain.length > 253 || domain.split(".").some((label) => !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label))) return invalid();
    // Reject noncanonical IPv4 forms that WHATWG URL would silently rewrite.
    if (new URL(`http://${hostname}`).hostname.toLowerCase() !== hostname.toLowerCase()) return invalid();
  }
  return value.toLowerCase();
}

function forwardedClientIp(request, peer, isTrustedProxy) {
  const values = headerValues(request, "x-forwarded-for");
  if (!values.length) return peer;
  const parts = values.join(",").split(",");
  if (parts.length > 32 || parts.some((part) => /[^\x20-\x7e]/.test(part))) return invalid();
  const chain = parts.map((part) => normalizedIp(part.trim()));
  let address = peer;
  for (let index = chain.length - 1; index >= 0 && isTrustedProxy(address); index -= 1) address = chain[index];
  return address;
}

export function resolveRequestContext(request, { publicPort, isTrustedProxy = () => false }) {
  try {
    let host = validHost(singleHeader(request, "host") ?? `localhost:${publicPort}`);
    let protocol = request.socket.encrypted ? "https" : "http";
    let clientIp = request.socket.remoteAddress ? normalizedIp(request.socket.remoteAddress) : "unknown";
    if (isTrustedProxy(clientIp)) {
      const forwardedProto = singleHeader(request, "x-forwarded-proto");
      const forwardedHost = singleHeader(request, "x-forwarded-host");
      if (forwardedProto !== undefined || forwardedHost !== undefined) {
        if (!["http", "https"].includes(forwardedProto) || forwardedHost === undefined) return invalid();
        protocol = forwardedProto;
        host = validHost(forwardedHost);
      }
      clientIp = forwardedClientIp(request, clientIp, isTrustedProxy);
    }
    const target = request.url || "/";
    if (!target.startsWith("/") || target.startsWith("//") || /[\\\x00-\x20\x7f]/.test(target)) return invalid();
    const origin = new URL(`${protocol}://${host}`).origin;
    return { origin, protocol, host: new URL(origin).host, clientIp, url: new URL(`${origin}${target}`).href };
  } catch (error) {
    if (error instanceof InvalidRequestContext) throw error;
    return invalid();
  }
}

export function publicRequestHeaders(request, context) {
  const headers = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (name === "forwarded" || name === "x-real-ip" || name.startsWith("x-forwarded-") || name === "x-nursery-gateway-secret") continue;
    headers[name] = value;
  }
  return {
    ...headers,
    host: context.host,
    "x-forwarded-host": context.host,
    "x-forwarded-proto": context.protocol,
    "x-forwarded-for": context.clientIp,
  };
}
