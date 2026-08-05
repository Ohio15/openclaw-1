/**
 * Own-property-only object access.
 *
 * Config documents are operator-controlled: every key in them is attacker- or
 * typo-supplied data, and the walkers that rebuild those documents (includes,
 * env substitution, env-ref preservation, redaction, merge-patch) index objects
 * by those keys. Plain `obj[key]` is not safe for that job, in BOTH directions:
 *
 * - Writing `target[key] = value` for `key === "__proto__"` invokes the
 *   `Object.prototype` setter instead of creating an own property. The entry
 *   silently disappears from the rebuilt document — so the operator's setting is
 *   neither applied nor reported, schema validation never sees the key and
 *   cannot reject it, and the rebuilt object starts inheriting from the assigned
 *   value.
 * - Reading `source[key]` / `key in source` for a key the object does not own
 *   walks the prototype chain: `"__proto__" in {}` is `true` and `({})["__proto__"]`
 *   is `Object.prototype`, so a walker "finds" a value that is not in the
 *   document at all and recurses into the prototype.
 *
 * Both halves are the same defect class, and it has a real security edge: the
 * one that motivated this module let `channels.signal.accounts.__proto__`
 * validate green and then resolve to the CHANNEL-level client certificate — the
 * wrong mTLS identity — while the next config write erased the block.
 *
 * The fix is mechanical and must be applied consistently rather than
 * case-by-case, so it stays greppable: any object rebuilt from document-supplied
 * keys writes through {@link setOwnProperty}, and any dynamic-key read of such an
 * object goes through {@link getOwnProperty} or {@link hasOwnKey}. Nothing here
 * special-cases `__proto__` by name — the semantics are simply "own properties
 * only", which is what a document walker always meant.
 */

/**
 * Define `key` on `target` as an own, enumerable data property.
 *
 * Unlike `target[key] = value` this never invokes an inherited setter, so every
 * key of the source document survives the rebuild as a real own key that
 * `Object.keys`, `Object.entries` and `Object.getOwnPropertyNames` all report —
 * which is what lets schema validation see it and reject it with a real message.
 */
export function setOwnProperty(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/**
 * Read `key` from `source` only if `source` owns it, otherwise `undefined`.
 *
 * `source[key]` alone would return `Object.prototype` for `"__proto__"` (and
 * `Function.prototype.call` for `"constructor"`-adjacent lookups) on objects that
 * do not carry the key.
 */
export function getOwnProperty(source: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(source, key) ? source[key] : undefined;
}

/**
 * Own-property presence test — the `in` operator's prototype-chain-free twin.
 */
export function hasOwnKey(source: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(source, key);
}
