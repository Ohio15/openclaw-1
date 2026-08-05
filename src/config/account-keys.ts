import { z } from "zod";
import { normalizeAccountId } from "../routing/session-key.js";

/**
 * Shared `channels.<channel>.accounts` key validation.
 *
 * Every multi-account channel whose resolver normalizes the requested id
 * (`normalizeAccountId`) and then does an EXACT `accounts[normalized]` lookup
 * shares one defect class: a config key that is not a normalization fixed point,
 * or that a plain object cannot retrieve at all, validates GREEN as a complete
 * per-account identity and is then unreachable at runtime. The requested id
 * never matches it, so the account silently falls back to the CHANNEL-level
 * credential — the wrong identity (wrong client certificate for Signal, wrong
 * bot token / API key for the others) — while the config loads clean and the
 * next config write erases the block.
 *
 * The Signal instance of this class (mTLS, the security edge that motivated the
 * fix) is closed here for every channel that shares the pattern, from ONE
 * implementation, against the REAL `normalizeAccountId` — a copy of the
 * normalizer is one more place for the schema and the resolver to drift apart.
 */

/**
 * Can `key` exist as a plain own data property — i.e. can
 * `accounts[normalizeAccountId(id)]` ever retrieve the entry the operator wrote?
 *
 * `__proto__` is the one string that answers no, and it is a `normalizeAccountId`
 * fixed point, so a fixed-point check alone waves it through. Assigning it on a
 * plain object invokes the `Object.prototype` setter instead of creating an own
 * property; zod's record parse knows this and skips the key outright
 * (`if (key === "__proto__") continue` in `_parseRecord`), so the entry is gone
 * from the parsed value before any refinement of that value can see it. The
 * config then loads green, every send for that id silently presents the
 * CHANNEL-level credential, and the next `writeConfigFile` persists the config
 * with the account block erased.
 *
 * Probing the assignment rather than hard-coding the known key keeps this tied to
 * the mechanism instead of to zod's current implementation detail. `constructor`
 * and `prototype` are ordinary own keys and stay accepted.
 */
export const isRetrievableAccountKey = (key: string): boolean => {
  const probe: Record<string, unknown> = {};
  const marker = Symbol("account-key-probe");
  try {
    probe[key] = marker;
  } catch {
    return false;
  }
  return Object.hasOwn(probe, key) && probe[key] === marker;
};

/**
 * Judge the `accounts` keys on the RAW object, before the record parse: a key the
 * parse drops (see {@link isRetrievableAccountKey}) is not present in the value a
 * `superRefine` receives, so a guard that runs later cannot fail a config it can
 * no longer see. Issues are reported at `[accountId]` — relative to the accounts
 * record — so the caller's schema position supplies the `channels.<channel>.accounts`
 * prefix.
 */
export const validateAccountKeys = (
  raw: unknown,
  ctx: z.RefinementCtx,
  channelLabel: string,
): void => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    // Wrong shape entirely — the record schema reports that.
    return;
  }
  for (const accountId of Object.getOwnPropertyNames(raw)) {
    if (!isRetrievableAccountKey(accountId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [accountId],
        message: `channels.${channelLabel}.accounts cannot use "${accountId}" as an account key: it is not a plain object key, so the entry is dropped while the config is parsed and the runtime lookup can never match it. The account would silently fall back to the channel-level credentials, and saving the config would erase this block. Rename it to a normalized account id (lowercase, only a-z 0-9 _ -, at most 64 characters).`,
      });
      continue;
    }
    // The resolver normalizes the requested id (`normalizeAccountId`) and then
    // indexes `accounts` with the normalized string, so a config key that is not
    // already in normalized form — "Alerts", "ops.eu", "DEFAULT", anything over
    // 64 characters — is dead config: it is validated as a complete per-account
    // identity, and at runtime the lookup misses and the account silently
    // inherits the channel-level credential. Wrong identity, green config. Reject
    // the key at the boundary instead of loosening the resolver's lookup.
    const normalized = normalizeAccountId(accountId);
    if (accountId === normalized) {
      continue;
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [accountId],
      message: `channels.${channelLabel}.accounts keys must already be in normalized account-id form (lowercase, only a-z 0-9 _ -, at most 64 characters); this key is never matched at runtime and its settings — including any credentials — would be silently ignored. Rename it to "${normalized}".`,
    });
  }
};

/**
 * Wrap a per-account value schema in the shared account-key guard. The guard
 * runs on the RAW object (a `z.preprocess`) so it can see keys the record parse
 * would otherwise drop before any refinement fires.
 */
export const accountsRecord = <ValueSchema extends z.ZodTypeAny>(
  valueSchema: ValueSchema,
  channelLabel: string,
) =>
  z.preprocess(
    (raw, ctx) => {
      validateAccountKeys(raw, ctx, channelLabel);
      return raw;
    },
    z.record(z.string(), valueSchema),
  );
