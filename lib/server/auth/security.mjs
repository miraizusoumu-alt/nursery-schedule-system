import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;
export const SCRYPT_PARAMETERS = Object.freeze({ cost: 32768, blockSize: 8, parallelization: 1, keyLength: 64 });
export const FAMILY_PASSWORD_LENGTH = 8;
export const FAMILY_PASSWORD_CHARACTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function normalizeLoginId(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function validateNewPassword(password, minimumLength = PASSWORD_MIN_LENGTH) {
  if (typeof password !== "string") return { ok: false, message: "新しいパスワードを入力してください。" };
  if (password.length < minimumLength) return { ok: false, message: `${minimumLength}文字以上で入力してください。` };
  if (password.length > PASSWORD_MAX_LENGTH) return { ok: false, message: `${PASSWORD_MAX_LENGTH}文字以内で入力してください。` };
  return { ok: true };
}

export function generateTemporaryPassword() {
  return randomBytes(24).toString("base64url");
}

export function generateFamilyPassword() {
  const bytes = randomBytes(FAMILY_PASSWORD_LENGTH);
  return Array.from(bytes, (value) => FAMILY_PASSWORD_CHARACTERS[value % FAMILY_PASSWORD_CHARACTERS.length]).join("");
}

export function generateLoginId(prefix) {
  return `${prefix}-${randomBytes(6).toString("hex")}`;
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const { cost, blockSize, parallelization, keyLength } = SCRYPT_PARAMETERS;
  const derivedKey = await scrypt(password, salt, keyLength, {
    N: cost,
    r: blockSize,
    p: parallelization,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$${cost}$${blockSize}$${parallelization}$${salt.toString("base64url")}$${Buffer.from(derivedKey).toString("base64url")}`;
}

let dummyPasswordHashPromise;

function getDummyPasswordHash() {
  dummyPasswordHashPromise ??= hashPassword(randomBytes(32).toString("base64url"));
  return dummyPasswordHashPromise;
}

export async function verifyPassword(password, encodedHash) {
  const safeHash = typeof encodedHash === "string" && encodedHash.startsWith("scrypt$")
    ? encodedHash
    : await getDummyPasswordHash();
  const parts = safeHash.split("$");
  if (parts.length !== 6) {
    await verifyPassword(password, await getDummyPasswordHash());
    return false;
  }

  const [, costText, blockSizeText, parallelizationText, saltText, expectedText] = parts;
  const cost = Number(costText);
  const blockSize = Number(blockSizeText);
  const parallelization = Number(parallelizationText);
  const salt = Buffer.from(saltText, "base64url");
  const expected = Buffer.from(expectedText, "base64url");
  if (!Number.isInteger(cost) || !Number.isInteger(blockSize) || !Number.isInteger(parallelization) || expected.length === 0) {
    await verifyPassword(password, await getDummyPasswordHash());
    return false;
  }

  try {
    const actual = Buffer.from(await scrypt(String(password ?? ""), salt, expected.length, {
      N: cost,
      r: blockSize,
      p: parallelization,
      maxmem: 64 * 1024 * 1024,
    }));
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    const dummy = await getDummyPasswordHash();
    if (dummy !== safeHash) await verifyPassword(password, dummy);
    return false;
  }
}

export function hashOpaqueValue(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

export function generateSessionSecrets() {
  const token = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(32).toString("base64url");
  return {
    token,
    tokenHash: hashOpaqueValue(token),
    csrfToken,
    csrfTokenHash: hashOpaqueValue(csrfToken),
  };
}

export function constantTimeHashMatch(value, expectedHash) {
  const actual = Buffer.from(hashOpaqueValue(value), "hex");
  const expected = Buffer.from(String(expectedHash ?? ""), "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
