// The source-hash sidecar: what each translation was translated from, and the
// fail-closed rules for reading, classifying and writing it back.
//
// Model (the one Weblate, Crowdin and Pontoon use inside their databases, kept
// here in a file beside the catalogs): alongside each translation, store a
// short fingerprint of (a) the source-language value it was translated against
// and (b) the translation value itself. On every run, recompute both
// fingerprints and classify the entry - see classifyHashPair for the state
// machine. A translation is STALE when the source moved but the translation did
// not. Stale is not broken: the translation still reads, and the signal is "a
// human should re-check this."
//
// Every reader of the sidecar fails closed: a malformed leaf or a malformed
// container throws rather than silently taking a branch that clears a stale
// flag. The sidecar is written by a program and edited by hand only to affirm a
// translation, so a malformed value almost always means an editing mistake,
// and the one wrong answer is a quiet "fresh".

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

// SHA-256 first 8 hex chars. Collisions are irrelevant here - this answers "did
// the value change?", not a security question - and a short prefix keeps the
// sidecar readable in a diff.
const HASH_PREFIX_LEN = 8;

// Compact "<src_hash>:<tgt_hash>" value form keeps the sidecar small (one short
// string per entry instead of a nested object); the colon is unambiguous because
// hashes are hex.
const SEPARATOR = ":";

// Reviewer-affirmed-unchanged sentinel. When a translator confirms a translation
// is still correct after a source reword (without editing the translation text),
// they replace the sidecar value with this string and run the tracker again;
// classifyHashPair then recaptures the source and translation hashes at current
// values, the same as the bootstrap path. Chosen to be obviously non-hex so a
// reviewer skimming the diff sees "refresh" instead of a fingerprint and knows
// which entries were affirmed by hand.
export const REFRESH_SENTINEL = "refresh";

// Stored hash-pair format: source and translation HASH_PREFIX_LEN hex tokens
// separated by SEPARATOR. classifyHashPair validates every non-sentinel entry
// against this shape and throws on a mismatch - a typo of REFRESH_SENTINEL
// ("refesh"), a single hash with no colon, a merge-conflict marker, or any other
// shape should not silently take any branch.
const STORED_PAIR_RE = new RegExp(
  `^[0-9a-f]{${HASH_PREFIX_LEN}}${SEPARATOR}[0-9a-f]{${HASH_PREFIX_LEN}}$`,
);

// Shape: { "<group>": { "<entry>": "<src_hash>:<tgt_hash>" } }. A caller maps
// its own axes onto (group, entry): (locale, message key) for a message
// catalog, or (platform, "<locale>/<field>") for per-field text files.
export type SourceHashes = Record<string, Record<string, string>>;

export function hashValue(value: string): string {
  return createHash("sha256")
    .update(value)
    .digest("hex")
    .slice(0, HASH_PREFIX_LEN);
}

export interface HashPairOutcome {
  // The sidecar value to store for this entry after the current run.
  value: string;
  // True when the source moved under a still-original translation.
  stale: boolean;
  // Set only when stale: the source fingerprint the translation was authored
  // against, so a caller can name the exact source transition an entry sits on.
  staleFrom?: string;
}

// The per-entry state machine. `prev` is the stored sidecar value (undefined
// when the entry is unseen); `curSrc`/`curTgt` are today's fingerprints of the
// source and translation. `locator` (e.g. "es.welcomeTitle" or
// "web fr/tagline") and `fileLabel` (the sidecar filename) only shape the
// fail-closed error message.
//
//   - no entry yet / REFRESH_SENTINEL  -> bootstrap or reviewer-affirmed:
//                                         capture source and translation at current values, fresh
//   - tgt fingerprint moved            -> translator updated the translation in
//                                         place; the edit is the freshness signal
//   - tgt unchanged, src moved         -> source reworded under a still-original
//                                         translation: STALE (preserve the stored
//                                         value so every run keeps flagging it
//                                         until a human re-touches the translation)
//   - source and translation unchanged -> fresh
//   - any other shape                  -> throw (fail-closed)
export function classifyHashPair(
  prev: string | undefined,
  curSrc: string,
  curTgt: string,
  locator: string,
  fileLabel: string,
): HashPairOutcome {
  const cur = `${curSrc}${SEPARATOR}${curTgt}`;
  if (prev === undefined || prev === REFRESH_SENTINEL) {
    return { value: cur, stale: false };
  }
  if (!STORED_PAIR_RE.test(prev)) {
    throw new Error(
      `Malformed ${fileLabel} entry for ${locator}: ${JSON.stringify(prev)}. ` +
        `Expected hash pair "<${HASH_PREFIX_LEN} hex>${SEPARATOR}<${HASH_PREFIX_LEN} hex>" or sentinel "${REFRESH_SENTINEL}".`,
    );
  }
  // STORED_PAIR_RE admitted a hex source token and a hex translation token
  // joined by the separator.
  const separatorAt = prev.indexOf(SEPARATOR);
  const prevSrc = prev.slice(0, separatorAt);
  const prevTgt = prev.slice(separatorAt + SEPARATOR.length);
  if (prevTgt !== curTgt) {
    return { value: cur, stale: false };
  }
  if (prevSrc !== curSrc) {
    return { value: prev, stale: true, staleFrom: prevSrc };
  }
  return { value: prev, stale: false };
}

// Container-shape validator. Asserts the runtime value matches the SourceHashes
// type contract layer by layer. JSON.parse + a TypeScript cast is not enough -
// the cast is a lie at runtime, and a hand-edited sidecar can take many wrong
// shapes (top-level primitive/array/null, group value primitive/array/null, leaf
// non-string). A `{ "es": "refresh" }` (string at the group level instead of
// nested) would otherwise make `existing[group][entry]` undefined for every
// entry, silently bootstrap-clearing every stale flag in the group. Reject the
// whole class before reading a single value. loadSourceHashes runs it on every
// file it reads; it is exported for a caller holding a value from elsewhere.
export function validateContainerShape(
  existing: unknown,
  fileLabel: string,
): asserts existing is SourceHashes {
  if (!isPlainObject(existing)) {
    throw new Error(
      `Malformed ${fileLabel}: top-level must be an object mapping group keys ` +
        `to per-entry hash maps, got ${describeType(existing)}.`,
    );
  }
  for (const [group, value] of Object.entries(existing)) {
    if (!isPlainObject(value)) {
      throw new Error(
        `Malformed ${fileLabel}: group "${group}" must be an object mapping ` +
          `entry keys to "<src_hash>${SEPARATOR}<tgt_hash>" or "${REFRESH_SENTINEL}", ` +
          `got ${describeType(value)}.`,
      );
    }
    for (const [entry, leaf] of Object.entries(value)) {
      if (typeof leaf !== "string") {
        throw new Error(
          `Malformed ${fileLabel}: leaf at ${group}.${entry} must be a string, ` +
            `got ${describeType(leaf)}.`,
        );
      }
    }
  }
}

// Reads and validates a sidecar. Its errors name the file by its basename, the
// label a reader looks for in the tree.
export async function loadSourceHashes(
  filePath: string,
): Promise<SourceHashes> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (e) {
    // First adoption of staleness tracking: no file yet. The caller's pass
    // bootstraps an entry for every translation, and renderSourceHashes gives
    // the file to write.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
  const parsed: unknown = JSON.parse(raw);
  validateContainerShape(parsed, basename(filePath));
  return parsed;
}

export function renderSourceHashes(hashes: SourceHashes): string {
  // Deterministic JSON: groups sorted, entries within each group sorted, so a
  // run that changes nothing rewrites the same bytes and a diff shows only real
  // movement. Two-space indent and a trailing newline are what prettier writes,
  // so a formatter check over the tree stays clean without a post step. The
  // explicit comparator is the default string sort's UTF-16 code-unit order,
  // independent of locale.
  const ordered: SourceHashes = {};
  for (const [group, groupHashes] of Object.entries(hashes).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const inner: Record<string, string> = {};
    for (const [entry, hash] of Object.entries(groupHashes).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      inner[entry] = hash;
    }
    ordered[group] = inner;
  }
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  // JSON.parse produces only plain objects, arrays, primitives, and null, but a
  // value built in code can be anything. A Map or class instance has no own
  // enumerable entries, so it would pass every per-entry check and read as
  // "no entry yet" for each string under it; only an object whose prototype is
  // Object.prototype (or none) holds its entries as properties.
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object" && !isPlainObject(value)) {
    // "[object Map]" -> "Map": "got object" would not say what was wrong.
    return Object.prototype.toString.call(value).slice(8, -1);
  }
  return typeof value;
}
