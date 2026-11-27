import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  classifyHashPair,
  hashValue,
  loadSourceHashes,
  REFRESH_SENTINEL,
  renderSourceHashes,
  type SourceHashes,
  updateSourceHashes,
} from "../src/source-hashes.ts";

const LABEL = "translation-hashes.json";

// Every shape a hand edit can leave the container in. Each one would otherwise
// read as "no entry yet" for every entry under it and clear its stale flags.
const MALFORMED_CONTAINERS: readonly unknown[] = [
  "refresh",
  null,
  12345,
  true,
  [],
  { es: "refresh" },
  { es: ["a", "b"] },
  { es: 12345 },
  { es: null },
  { es: { a: 12345 } },
  { es: { a: null } },
];

describe("classifyHashPair", () => {
  it("bootstraps (prev undefined) by capturing the source and target hashes, not stale", () => {
    const out = classifyHashPair(
      undefined,
      "aaaaaaaa",
      "bbbbbbbb",
      "es.a",
      LABEL,
    );
    assert.deepEqual(out, { value: "aaaaaaaa:bbbbbbbb", stale: false });
  });

  it("treats REFRESH_SENTINEL like bootstrap: recapture current, not stale", () => {
    // Reviewer affirmed the translation is still correct after a source reword;
    // recapture the source and translation fingerprints so the stale flag
    // clears without editing text.
    const out = classifyHashPair(
      REFRESH_SENTINEL,
      "cccccccc",
      "dddddddd",
      "es.a",
      LABEL,
    );
    assert.deepEqual(out, { value: "cccccccc:dddddddd", stale: false });
  });

  it("flags STALE when src moved but tgt is unchanged, preserving the stored value", () => {
    // The stale entry must keep the OLD stored pair so every run keeps flagging
    // it until a human re-touches the translation. staleFrom names the source
    // the translation was authored against, which a caller can bind a review
    // verdict to.
    const prev = "aaaaaaaa:bbbbbbbb";
    const out = classifyHashPair(prev, "cccccccc", "bbbbbbbb", "es.a", LABEL);
    assert.deepEqual(out, { value: prev, stale: true, staleFrom: "aaaaaaaa" });
  });

  it("clears (not stale) when tgt moved: the translator edit is the freshness signal", () => {
    const out = classifyHashPair(
      "aaaaaaaa:11111111",
      "aaaaaaaa",
      "22222222",
      "es.a",
      LABEL,
    );
    assert.deepEqual(out, { value: "aaaaaaaa:22222222", stale: false });
  });

  it("leaves the value untouched when the source and target hashes match", () => {
    const prev = "5555aaaa:6666bbbb";
    const out = classifyHashPair(prev, "5555aaaa", "6666bbbb", "es.a", LABEL);
    assert.deepEqual(out, { value: prev, stale: false });
  });

  it("throws fail-closed on a malformed non-sentinel value, naming the locator", () => {
    // A typo of "refresh", a single hash, uppercase hex, or a merge marker would
    // otherwise slip through a split on the separator and be misread as a
    // tgt-hash change, silently clearing stale.
    for (const bad of [
      "refesh",
      "deadbeef",
      "deadbeef:cafebab",
      "DEADBEEF:CAFEBABE",
      "deadbeef:cafebabe:extra",
      "",
      ":",
      "<<<<<<< HEAD",
    ]) {
      assert.throws(
        () => classifyHashPair(bad, "aaaaaaaa", "bbbbbbbb", "es.a", LABEL),
        /translation-hashes\.json entry for es\.a/,
      );
    }
  });

  it("threads fileLabel and locator into the error so each sidecar reads its own message", () => {
    assert.throws(
      () =>
        classifyHashPair(
          "bad",
          "aaaaaaaa",
          "bbbbbbbb",
          "web fr/tagline",
          "page-copy-hashes.json",
        ),
      /page-copy-hashes\.json entry for web fr\/tagline/,
    );
  });
});

describe("updateSourceHashes: the sidecar it is handed", () => {
  const pairs = [
    { group: "es", entry: "a", source: "Hello", translation: "Hola" },
  ];

  it("throws on every malformed container shape, prefixed with the fileLabel", () => {
    for (const bad of MALFORMED_CONTAINERS) {
      assert.throws(
        () => updateSourceHashes(bad as SourceHashes, pairs, LABEL),
        /Malformed translation-hashes\.json/,
      );
    }
  });

  it("checks the whole container, not only the groups the pairs name", () => {
    // A damaged group for a locale the catalogs no longer carry would be
    // dropped on write; throwing instead says the file was edited wrongly.
    assert.throws(
      () =>
        updateSourceHashes(
          { es: {}, de: "refresh" } as unknown as SourceHashes,
          pairs,
          LABEL,
        ),
      /group "de" must be an object/,
    );
  });

  it("refuses a container that is an object without holding its entries as properties", () => {
    // A Map or class instance has no own enumerable entries, so it would pass
    // every per-entry check and read as "no entry yet" for each string, which
    // clears every stale flag under it.
    class Hashes {
      fr = { greeting: "deadbeef:cafebabe" };
    }
    for (const [bad, message] of [
      [new Map([["fr", {}]]), /top-level must be an object .* got Map\./],
      [new Hashes(), /top-level must be an object .* got Object\./],
      [
        { fr: new Map([["greeting", 123]]) },
        /group "fr" must be an object .* got Map\./,
      ],
      [{ fr: new Date(0) }, /group "fr" must be an object .* got Date\./],
    ] as const) {
      assert.throws(
        () => updateSourceHashes(bad as unknown as SourceHashes, pairs, LABEL),
        message,
      );
    }
  });

  it("accepts an object with no prototype", () => {
    const hashes = Object.create(null) as SourceHashes;
    hashes["es"] = { a: "deadbeef:cafebabe" };
    assert.doesNotThrow(() => updateSourceHashes(hashes, pairs, LABEL));
  });

  it("throws on a malformed stored value, naming the file and group.entry", () => {
    assert.throws(
      () => updateSourceHashes({ es: { a: "refesh" } }, pairs, LABEL),
      /^Error: Malformed translation-hashes\.json entry for es\.a: "refesh"/,
    );
  });
});

describe("renderSourceHashes", () => {
  it("emits deterministically sorted JSON with a trailing newline", () => {
    const hashes: SourceHashes = {
      es: { b: "11111111:22222222", a: "33333333:44444444" },
      de: { a: "55555555:66666666" },
    };
    assert.equal(
      renderSourceHashes(hashes),
      [
        "{",
        '  "de": {',
        '    "a": "55555555:66666666"',
        "  },",
        '  "es": {',
        '    "a": "33333333:44444444",',
        '    "b": "11111111:22222222"',
        "  }",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("orders keys by code unit, not by locale collation", () => {
    // A locale-aware sort would put "b" before "C"; the sidecar's bytes must
    // not depend on the machine that wrote them.
    const out = renderSourceHashes({
      x: { b: "11111111:22222222", C: "33333333:44444444" },
    });
    assert.ok(out.indexOf('"C"') < out.indexOf('"b"'));
  });
});

describe("loadSourceHashes", () => {
  it("returns {} when the sidecar does not exist (first adoption)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stale-translations-"));
    assert.deepEqual(await loadSourceHashes(join(dir, "missing.json")), {});
  });

  it("reads back what renderSourceHashes wrote", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stale-translations-"));
    const path = join(dir, LABEL);
    const payload: SourceHashes = { es: { a: "deadbeef:cafebabe" } };
    await writeFile(path, renderSourceHashes(payload), "utf-8");
    assert.deepEqual(await loadSourceHashes(path), payload);
  });

  it("refuses every malformed container, naming the file by its basename", async () => {
    // Loading is where a caller first holds the value, so a loader that only
    // cast it would leave the fail-closed check to each caller remembering it.
    const dir = await mkdtemp(join(tmpdir(), "stale-translations-"));
    const path = join(dir, LABEL);
    for (const bad of MALFORMED_CONTAINERS) {
      await writeFile(path, JSON.stringify(bad), "utf-8");
      await assert.rejects(
        loadSourceHashes(path),
        /^Error: Malformed translation-hashes\.json: /,
      );
    }
  });

  it("refuses a file that is not JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stale-translations-"));
    const path = join(dir, LABEL);
    await writeFile(path, "<<<<<<< HEAD\n{}\n", "utf-8");
    await assert.rejects(loadSourceHashes(path), SyntaxError);
  });

  it("treats only a missing file as first adoption", async () => {
    // Any other read failure returning {} would bootstrap every entry and clear
    // every stale flag on the next write.
    const dir = await mkdtemp(join(tmpdir(), "stale-translations-"));
    const path = join(dir, LABEL);
    await mkdir(path);
    await assert.rejects(loadSourceHashes(path), { code: "EISDIR" });
  });
});

describe("hashValue", () => {
  it("is the first 8 lowercase hex characters of SHA-256 over UTF-8", () => {
    // Fixed values, so a change of algorithm, prefix or encoding is caught
    // here rather than as every entry in a sidecar going stale at once.
    assert.equal(hashValue("hello"), "2cf24dba");
    assert.equal(hashValue("caf\u00e9"), "850f7dc4");
    assert.notEqual(hashValue("hello "), hashValue("hello"));
  });
});

describe("updateSourceHashes: a run over a tracker's pairs", () => {
  // Pairs built from a source catalog and per-locale translations, the way the
  // README's tracker builds them.
  function pairsOf(
    source: Record<string, string>,
    translations: Record<string, Record<string, string>>,
  ): { group: string; entry: string; source: string; translation: string }[] {
    return Object.entries(translations).flatMap(([group, messages]) =>
      Object.entries(messages).map(([entry, translation]) => ({
        group,
        entry,
        source: source[entry] ?? "",
        translation,
      })),
    );
  }

  const fr = { fr: { greeting: "Bonjour", farewell: "Au revoir" } };
  const original = { greeting: "Hello", farewell: "Goodbye" };
  const reworded = { greeting: "Hi there", farewell: "Goodbye" };
  const first = updateSourceHashes({}, pairsOf(original, fr), LABEL);

  it("records a first sighting as fresh, with both hashes", () => {
    assert.deepEqual(first.stale, []);
    assert.deepEqual(
      { ...first.updated["fr"] },
      {
        greeting: `${hashValue("Hello")}:${hashValue("Bonjour")}`,
        farewell: `${hashValue("Goodbye")}:${hashValue("Au revoir")}`,
      },
    );
  });

  it("rewrites an unchanged sidecar to the same value", () => {
    const again = updateSourceHashes(
      first.updated,
      pairsOf(original, fr),
      LABEL,
    );
    assert.equal(
      renderSourceHashes(again.updated),
      renderSourceHashes(first.updated),
    );
  });

  it("flags a reword with the source it was translated from, and keeps flagging it", () => {
    // The stored pair must survive the stale run unchanged, or the next run
    // would read the reword as already seen and clear the flag.
    const second = updateSourceHashes(
      first.updated,
      pairsOf(reworded, fr),
      LABEL,
    );
    assert.deepEqual(second.stale, [
      {
        group: "fr",
        entry: "greeting",
        source: "Hi there",
        translation: "Bonjour",
        staleFrom: hashValue("Hello"),
        sourceHash: hashValue("Hi there"),
      },
    ]);
    assert.deepEqual(second.updated, first.updated);
    const third = updateSourceHashes(
      second.updated,
      pairsOf(reworded, fr),
      LABEL,
    );
    assert.deepEqual(
      third.stale.map((s) => s.entry),
      ["greeting"],
    );
  });

  it("clears the flag when the translation is edited", () => {
    const edited = { fr: { greeting: "Salut", farewell: "Au revoir" } };
    const out = updateSourceHashes(
      first.updated,
      pairsOf(reworded, edited),
      LABEL,
    );
    assert.deepEqual(out.stale, []);
    assert.equal(
      out.updated["fr"]?.["greeting"],
      `${hashValue("Hi there")}:${hashValue("Salut")}`,
    );
  });

  it("clears the flag when a reviewer writes the refresh sentinel", () => {
    const affirmed: SourceHashes = {
      fr: { ...first.updated["fr"], greeting: REFRESH_SENTINEL },
    };
    const out = updateSourceHashes(affirmed, pairsOf(reworded, fr), LABEL);
    assert.deepEqual(out.stale, []);
    assert.equal(
      out.updated["fr"]?.["greeting"],
      `${hashValue("Hi there")}:${hashValue("Bonjour")}`,
    );
  });

  it("drops a group and an entry the pairs no longer name", () => {
    // A removed locale or key must leave the file, or its fingerprint would
    // outlive the string and greet a re-added one with a stale verdict.
    const existing: SourceHashes = {
      ...first.updated,
      de: { greeting: "deadbeef:cafebabe" },
    };
    const out = updateSourceHashes(
      existing,
      pairsOf(original, { fr: { greeting: "Bonjour" } }),
      LABEL,
    );
    assert.deepEqual(Object.keys(out.updated), ["fr"]);
    assert.deepEqual(Object.keys(out.updated["fr"] ?? {}), ["greeting"]);
  });

  it("writes no group for a run with no pairs", () => {
    assert.equal(
      renderSourceHashes(updateSourceHashes(first.updated, [], LABEL).updated),
      "{}\n",
    );
  });

  it("returns the caller's own fields on a stale pair", () => {
    // A tracker whose entry key encodes its own axes reads them back from the
    // pair it built instead of parsing `entry`.
    const pair = {
      group: "ios",
      entry: "fr/subtitle",
      source: "Hi there",
      translation: "Bonjour",
      locale: "fr",
      field: "subtitle",
    };
    const stored = {
      ios: { "fr/subtitle": `${hashValue("Hello")}:${hashValue("Bonjour")}` },
    };
    const { stale } = updateSourceHashes(stored, [pair], LABEL);
    assert.deepEqual(
      stale.map((s) => [s.locale, s.field]),
      [["fr", "subtitle"]],
    );
  });

  it("throws when a pair is named twice", () => {
    // Only one outcome can be stored; keeping either would hide the other.
    const pair = {
      group: "fr",
      entry: "greeting",
      source: "a",
      translation: "b",
    };
    assert.throws(
      () =>
        updateSourceHashes({}, [pair, { ...pair, translation: "c" }], LABEL),
      /^Error: Duplicate translation-hashes\.json entry for fr\.greeting/,
    );
  });

  it("reads a group or entry named like an inherited member as unseen, not as damage", () => {
    // Without own-key lookups, "constructor" resolves to Object's own
    // constructor, which is neither undefined nor a hash pair, and the run
    // throws on a sidecar that is fine.
    const names: [string, string][] = [
      ["fr", "constructor"],
      ["constructor", "greeting"],
      ["toString", "valueOf"],
    ];
    for (const [group, entry] of names) {
      const out = updateSourceHashes(
        { fr: {} },
        [{ group, entry, source: "Build", translation: "Construire" }],
        LABEL,
      );
      assert.deepEqual(out.stale, []);
      const written = Object.hasOwn(out.updated, group)
        ? out.updated[group]
        : undefined;
      assert.ok(written !== undefined && Object.hasOwn(written, entry));
      assert.match(written[entry] ?? "", /^[0-9a-f]{8}:[0-9a-f]{8}$/);
    }
  });

  it("keeps a group and an entry named __proto__ through a write and a reword", async () => {
    // JSON.parse stores "__proto__" as an own key, but assigning it into an
    // ordinary object sets the prototype instead, so its fingerprint would be
    // lost on write and the next reword would read as a first sighting.
    const pair = (source: string) => ({
      group: "__proto__",
      entry: "__proto__",
      source,
      translation: "Bonjour",
    });
    const written = updateSourceHashes({}, [pair("Hello")], LABEL);

    const dir = await mkdtemp(join(tmpdir(), "stale-translations-"));
    const path = join(dir, LABEL);
    await writeFile(path, renderSourceHashes(written.updated), "utf-8");
    const stored = await loadSourceHashes(path);
    assert.match(
      JSON.stringify(stored),
      /^\{"__proto__":\{"__proto__":"[0-9a-f]{8}:[0-9a-f]{8}"\}\}$/,
    );

    const reworded = updateSourceHashes(stored, [pair("Hi there")], LABEL);
    assert.deepEqual(
      reworded.stale.map((s) => `${s.group}.${s.entry}`),
      ["__proto__.__proto__"],
    );
  });
});
