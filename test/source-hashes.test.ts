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
  validateContainerShape,
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

describe("validateContainerShape", () => {
  it("throws on every malformed container shape, prefixed with the fileLabel", () => {
    for (const bad of MALFORMED_CONTAINERS) {
      assert.throws(
        () => validateContainerShape(bad, LABEL),
        /Malformed translation-hashes\.json/,
      );
    }
  });

  it("accepts a well-formed two-level container", () => {
    assert.doesNotThrow(() =>
      validateContainerShape({ es: { a: "deadbeef:cafebabe" } }, LABEL),
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

// The loop the README shows, run end to end: a reword flags the translation,
// and both ways of clearing the flag clear it.
describe("a tracker over one message catalog", () => {
  function track(
    source: Record<string, string>,
    translations: Record<string, Record<string, string>>,
    existing: SourceHashes,
  ): { stale: string[]; updated: SourceHashes } {
    const stale: string[] = [];
    const updated: SourceHashes = {};
    for (const [locale, messages] of Object.entries(translations)) {
      const group: Record<string, string> = {};
      for (const [key, text] of Object.entries(messages)) {
        const sourceText = source[key];
        if (sourceText === undefined) continue;
        const outcome = classifyHashPair(
          existing[locale]?.[key],
          hashValue(sourceText),
          hashValue(text),
          `${locale}.${key}`,
          LABEL,
        );
        group[key] = outcome.value;
        if (outcome.stale) stale.push(`${locale}.${key}`);
      }
      updated[locale] = group;
    }
    return { stale, updated };
  }

  it("flags a reword, then clears it by an edit or by refresh", () => {
    const fr = { fr: { greeting: "Bonjour", farewell: "Au revoir" } };
    const first = track({ greeting: "Hello", farewell: "Goodbye" }, fr, {});
    assert.deepEqual(first.stale, []);

    const reworded = { greeting: "Hi there", farewell: "Goodbye" };
    const second = track(reworded, fr, first.updated);
    assert.deepEqual(second.stale, ["fr.greeting"]);
    // Still stale on the next run: nothing has touched the translation.
    assert.deepEqual(track(reworded, fr, second.updated).stale, [
      "fr.greeting",
    ]);

    const edited = { fr: { greeting: "Salut", farewell: "Au revoir" } };
    assert.deepEqual(track(reworded, edited, second.updated).stale, []);

    const affirmed: SourceHashes = {
      fr: { ...second.updated["fr"], greeting: REFRESH_SENTINEL },
    };
    assert.deepEqual(track(reworded, fr, affirmed).stale, []);
  });
});
