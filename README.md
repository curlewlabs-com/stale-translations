# stale-translations

Find the translations that still say what the source text used to say. A small
JSON sidecar beside your catalogs records, for every translated string, a
fingerprint of the source text it was translated from and of the translation
itself. When the source is reworded and the translation is not, the entry is
stale until someone retranslates it or confirms it is still right.

## What it is

A TypeScript library with no runtime dependencies, one module. It is the part
of a staleness tracker that does not depend on your catalog format:

- `hashValue(text)` - the fingerprint: the first 8 hex characters of SHA-256
  over the text's UTF-8 bytes.
- `classifyHashPair(stored, sourceHash, translationHash, locator, fileLabel)` -
  the per-string decision: fresh, stale, or a sidecar value it refuses to read.
- `loadSourceHashes(path)` and `renderSourceHashes(hashes)` - read and write
  the sidecar. Reading validates the whole file before returning it; writing
  sorts it so an unchanged run rewrites the same bytes.
- `REFRESH_SENTINEL` - the value a reviewer writes to affirm a translation.

You write the loop that walks your own catalogs: which strings are
translations, which source string each one came from, and what to do with the
stale list. That loop is a few lines, shown below.

## Why it exists

A reworded source string leaves its translations quietly wrong. Nothing fails:
the key still exists in every locale, the app still builds, and the
translation still reads well. It just says what the source used to say.

Translation platforms such as Weblate and Crowdin track this inside their own
databases, and some formats carry it in the file: gettext's `msgmerge` marks a
PO entry fuzzy, and Xcode String Catalogs have a needs-review state. If your
translations live as ARB, flat JSON or plain text files edited in a pull
request, none of that applies, and a missing-key check cannot see the problem
because no key is missing.

This keeps the same signal in the repository, as a file a reviewer can read in
a diff:

- **The translation is fingerprinted too**, so editing a translation clears its
  flag with no status field to update.
- **A reviewer can affirm a translation without changing it** by replacing its
  sidecar value with `"refresh"`. The diff shows which entries were affirmed by
  hand.
- **It fails closed.** A hand edit gone wrong (a mistyped `"refresh"`, half a
  hash, a merge conflict marker, a group that is not an object) throws, naming
  the file and the entry. It never reads as "no entry yet", because that would
  clear the flag.
- **A stale result says which source it was translated from** (`staleFrom`), so
  a review verdict can be tied to one exact source change and lapse when the
  source moves again.

## How to use it

This package is not published to the npm registry. Install a release's tarball
from GitHub, which pins it by the integrity hash your lockfile records:

```sh
npm install https://github.com/curlewlabs-com/stale-translations/releases/download/v0.1.0/curlewlabs-com-stale-translations-0.1.0.tgz
```

Each release's notes give its tarball's SHA-512 integrity, and the tarball has a
GitHub build provenance attestation (`gh attestation verify <file> -R
curlewlabs-com/stale-translations`).

A tracker over one source catalog and its translations:

```ts
import { writeFile } from "node:fs/promises";
import {
  classifyHashPair,
  hashValue,
  loadSourceHashes,
  renderSourceHashes,
  type SourceHashes,
} from "@curlewlabs-com/stale-translations";

const SIDECAR = "l10n/translation-hashes.json";

// Your catalogs, loaded however you load them.
const source: Record<string, string> = { greeting: "Hi there" };
const translations: Record<string, Record<string, string>> = {
  fr: { greeting: "Bonjour" },
};

// Own keys only: a message key such as "constructor" must not resolve to a
// member every object inherits.
function own<T>(
  map: Record<string, T> | undefined,
  key: string,
): T | undefined {
  return map !== undefined && Object.hasOwn(map, key) ? map[key] : undefined;
}

const existing = await loadSourceHashes(SIDECAR);
// Null-prototype maps, so a key named `__proto__` is stored like any other.
const updated = Object.create(null) as SourceHashes;
const stale: string[] = [];

for (const [locale, messages] of Object.entries(translations)) {
  const group = Object.create(null) as Record<string, string>;
  for (const [key, text] of Object.entries(messages)) {
    const sourceText = own(source, key);
    if (sourceText === undefined) continue;
    const outcome = classifyHashPair(
      own(own(existing, locale), key),
      hashValue(sourceText),
      hashValue(text),
      `${locale}.${key}`,
      "translation-hashes.json",
    );
    group[key] = outcome.value;
    if (outcome.stale) stale.push(`${locale}.${key}`);
  }
  updated[locale] = group;
}

await writeFile(SIDECAR, renderSourceHashes(updated));
if (stale.length > 0) {
  console.error(`stale: ${stale.join(", ")}`);
  process.exitCode = 1;
}
```

Commit the sidecar with the catalogs, and act on the `stale` list: fail the
build on it, as above, or write it to a report you commit beside the sidecar.
The sidecar alone does not show a reword: a stale entry keeps its stored pair,
so the file a run writes after a reword is byte for byte the one before it.

The first run, with no sidecar, records every translation as fresh: the
tracker can only see rewording that happens after it starts. A string that is
no longer visited (a removed key or locale) is left out of `updated`, so the
sidecar forgets it.

### The sidecar

```json
{
  "fr": {
    "farewell": "8f3c09a1:5d41402a",
    "greeting": "refresh"
  }
}
```

The shape is `{ group: { entry: value } }`, with group and entry chosen by your
loop: locale and message key above, or a platform and a `locale/field` path
for per-field text files. Each value is `"<source hash>:<translation hash>"`,
or `"refresh"`.

### What each entry becomes

| Stored value         | Translation hash | Source hash | Result                                                             |
| -------------------- | ---------------- | ----------- | ------------------------------------------------------------------ |
| none, or `"refresh"` | any              | any         | fresh; both hashes recorded                                        |
| a hash pair          | changed          | any         | fresh; both hashes recorded                                        |
| a hash pair          | unchanged        | changed     | **stale**; the stored pair is kept, so the next run flags it again |
| a hash pair          | unchanged        | unchanged   | fresh                                                              |
| anything else        |                  |             | throws                                                             |

Clearing a stale entry takes one of two things: edit the translation, or
replace its value with `"refresh"` and run the tracker again.

`classifyHashPair` returns `{ value, stale, staleFrom? }`. `value` goes in the
sidecar you write back. `staleFrom`, set only when stale, is the source hash
the translation was made from.

### Errors

`loadSourceHashes` returns `{}` for a missing file and throws for anything else
it cannot read: another read error, a file that is not JSON, or a container of
the wrong shape. The message names the file by its basename.
`classifyHashPair` throws for a value that is neither a hash pair nor
`"refresh"`, naming `fileLabel` and `locator`; pass the sidecar's file name and
whatever lets a reader find the string. `validateContainerShape(value, label)`
is the container check on its own, for a sidecar value you did not read with
`loadSourceHashes`.

## Runtime requirements

`node:crypto`, `node:fs/promises` and `node:path`, which Node.js and Bun both
provide. The tests here run on Node.js 24.

## Versioning

Releases are fixed `vMAJOR.MINOR.PATCH` tags with immutable GitHub Releases.
While the version is 0.x, a minor release may change the API; read the release
notes before moving the pin. A change to the hash, its length, the separator or
the sentinel would make every existing sidecar read as stale, so the format is
held fixed.

## Development

```sh
npm ci
npm run typecheck
npm test
```

## Security

See [SECURITY.md](SECURITY.md) to report a vulnerability privately.

## License

Licensed under either of

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))
- MIT license ([LICENSE-MIT](LICENSE-MIT))

at your option.

### Contribution

By submitting a contribution for inclusion in this project, you agree that it
is dual licensed as above, without any additional terms or conditions.
