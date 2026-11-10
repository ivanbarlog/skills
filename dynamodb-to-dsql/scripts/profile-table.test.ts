import { describe, expect, it } from "bun:test";

import { parseItemsFile, profileItems, shapeOf } from "./profile-table.ts";

describe("shapeOf", () => {
  it("masks id-like segments and keeps literal prefixes", () => {
    const item = { entity: "member|user|a1B2c3D4e5F6g7H8i9" };
    expect(shapeOf({ item, classify: ["entity"] })).toBe("entity=member|user|*");
  });

  it("describes non-string classifier values", () => {
    expect(shapeOf({ item: {}, classify: ["entity"] })).toBe("entity=<null>");
  });
});

describe("profileItems", () => {
  const items = [
    { id: "u1", entity: "user", name: "A", tags: new Set(["x", "y"]), count: 2 },
    { id: "u2", entity: "user", name: "B", count: 3.5 },
    { id: "g1", entity: "group", name: "G" },
  ];

  it("groups by shape and reports presence, types and set sizes", () => {
    const [user, group] = profileItems({ items, classify: ["entity"] });
    expect(user?.shape).toBe("entity=user");
    expect(user?.count).toBe(2);
    expect(group?.count).toBe(1);
    const tags = user?.attributes.find((attribute) => attribute.name === "tags");
    expect(tags?.presentIn).toBe(1);
    expect(tags?.types).toEqual({ "set<string>": 1 });
    expect(tags?.maxSize).toBe(2);
    const count = user?.attributes.find((attribute) => attribute.name === "count");
    expect(count?.allIntegers).toBe(false);
  });

  it("does not expose values unless asked", () => {
    const [user] = profileItems({ items, classify: ["entity"] });
    expect(user?.attributes.every((attribute) => attribute.values == null)).toBe(true);
  });
});

describe("parseItemsFile", () => {
  it("reads aws dynamodb scan output", () => {
    const text = JSON.stringify({
      Items: [{ id: { S: "1" }, n: { N: "5" }, s: { SS: ["a"] }, m: { M: { k: { BOOL: true } } } }],
    });
    const [item] = parseItemsFile(text);
    expect(item).toEqual({ id: "1", n: 5, s: new Set(["a"]), m: { k: true } });
  });
});
