import { describe, expect, it } from "bun:test";

import {
  asInt32,
  asStringSet,
  createFindings,
  diffKeys,
  formatFindings,
  loadTables,
  scanAll,
  tableLoad,
  toChunks,
} from "./migration-kit.ts";

describe("toChunks", () => {
  it("splits at the size", () => {
    expect(toChunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(toChunks([], 2)).toEqual([]);
  });
});

describe("parsers", () => {
  it("rejects values outside int32", () => {
    expect(asInt32(2_147_483_648)).toBeUndefined();
    expect(asInt32(1.5)).toBeUndefined();
    expect(asInt32(42)).toBe(42);
  });

  it("reads DynamoDB sets and arrays", () => {
    expect([...asStringSet(new Set(["a", "", "b"]))]).toEqual(["a", "b"]);
    expect([...asStringSet(["a"])]).toEqual(["a"]);
    expect(asStringSet(undefined).size).toBe(0);
  });
});

describe("findings", () => {
  it("groups by code and prints ids only", () => {
    const findings = createFindings();
    findings.add("link.mirror-missing", "imported", "parent=p1 child=c1");
    findings.add("link.mirror-missing", "imported", "parent=p1 child=c2");
    const text = formatFindings(findings.list());
    expect(text).toContain("link.mirror-missing [imported] x2");
    expect(text).toContain("parent=p1 child=c1");
  });
});

describe("loadTables", () => {
  it("loads in order, in chunks, and is repeatable", async () => {
    const stored = new Set<number>();
    const insert = async (_tx: null, chunk: Array<number>) => {
      let inserted = 0;
      for (const row of chunk) if (!stored.has(row)) (stored.add(row), (inserted += 1));
      return inserted;
    };
    const rows = Array.from({ length: 2_500 }, (_, index) => index);
    const run = () =>
      loadTables({
        transact: (fn) => fn(null),
        tables: [tableLoad({ table: "numbers", rows, insert })],
        log: () => {},
      });
    expect((await run())[0]).toEqual({ table: "numbers", planned: 2_500, inserted: 2_500 });
    expect((await run())[0]).toEqual({ table: "numbers", planned: 2_500, inserted: 0 });
  });
});

describe("diffKeys", () => {
  it("reports both directions sorted", () => {
    const diff = diffKeys({ table: "t", expected: new Set(["a", "b"]), actual: new Set(["b", "c"]) });
    expect(diff.missingInTarget).toEqual(["a"]);
    expect(diff.unexpectedInTarget).toEqual(["c"]);
  });
});

describe("scanAll", () => {
  it("follows LastEvaluatedKey", async () => {
    const pages = [
      { Items: [{ id: "1" }], LastEvaluatedKey: { id: "1" } },
      { Items: [{ id: "2" }] },
    ];
    let call = 0;
    const items = await scanAll({ send: async () => pages[call++] ?? {}, tableName: "t" });
    expect(items).toEqual([{ id: "1" }, { id: "2" }]);
  });
});
