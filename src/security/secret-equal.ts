import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Constant-time secret comparison that does not leak the length of the
 * expected value.  Both inputs are HMAC'd with a fixed key so the
 * resulting buffers are always the same length (32 bytes), eliminating
 * the timing side-channel from an early-return on mismatched lengths.
 */
export function safeEqualSecret(
  provided: string | undefined | null,
  expected: string | undefined | null,
): boolean {
  if (typeof provided !== "string" || typeof expected !== "string") {
    return false;
  }
  const key = "openclaw-length-normalizer";
  const providedHash = createHmac("sha256", key).update(provided).digest();
  const expectedHash = createHmac("sha256", key).update(expected).digest();
  return timingSafeEqual(providedHash, expectedHash);
}
