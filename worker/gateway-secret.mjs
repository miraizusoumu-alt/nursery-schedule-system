// Canonical, unpadded base64url for the runner's 32 random bytes (256 bits).
const GATEWAY_SECRET_PATTERN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

/**
 * Worker-only runtime lookup. Never import this module from client code.
 * @param {unknown} bindings
 * @returns {string | null}
 */
export function resolveGatewaySecret(bindings) {
  let secret;
  if (bindings !== undefined) {
    // A supplied bindings object is authoritative, including missing values.
    if (bindings === null || typeof bindings !== "object" || Array.isArray(bindings)) return null;
    if (!Object.hasOwn(bindings, "NURSERY_GATEWAY_SECRET")) return null;
    secret = bindings.NURSERY_GATEWAY_SECRET;
  } else {
    if (typeof process === "undefined" || process.env?.NURSERY_NODE_PRODUCTION_RUNTIME !== "true") return null;
    secret = process.env.NURSERY_GATEWAY_SECRET;
  }
  return typeof secret === "string" && secret.length === 43 && GATEWAY_SECRET_PATTERN.test(secret) ? secret : null;
}
