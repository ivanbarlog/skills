import { describe, expect, it } from "bun:test";

import { extractBalanced, scanSources } from "./scan-dynamodb-usage.ts";

const sdkImport = `import { UpdateCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";`;

describe("scanSources", () => {
  it("ignores files that do not touch DynamoDB", () => {
    const report = scanSources({ files: [{ path: "a.ts", text: "const x = 1;" }] });
    expect(report.dynamoFiles).toEqual([]);
    expect(report.calls).toEqual([]);
  });

  it("classifies a counter update with an exists guard", () => {
    const text = `${sdkImport}
await client.send(new UpdateCommand({
  TableName: table,
  Key: { id: "g1", entity: "group" },
  ConditionExpression: "attribute_exists(#id)",
  UpdateExpression: "ADD #count :n",
}));`;
    const [call] = scanSources({ files: [{ path: "a.ts", text }] }).calls;
    expect(call?.operation).toBe("Update");
    expect(call?.keyAttributes).toEqual(["id", "entity"]);
    expect(call?.flags).toContain("condition:exists");
    expect(call?.flags).toContain("update:ADD");
    expect(call?.patterns).toContain("P07");
  });

  it("counts transaction items and reads nested expressions", () => {
    const text = `${sdkImport}
await client.send(new TransactWriteCommand({
  TransactItems: [
    { Put: { TableName: t, Item: a, ConditionExpression: "attribute_not_exists(id)" } },
    { Update: { TableName: t, Key: k, UpdateExpression: "SET #n = #n + :one" } },
    { ConditionCheck: { TableName: t, Key: k2, ConditionExpression: "attribute_exists(id)" } },
  ],
}));`;
    const [call] = scanSources({ files: [{ path: "a.ts", text }] }).calls;
    expect(call?.transactItems).toBe(3);
    expect(call?.flags).toContain("condition:not-exists");
    expect(call?.flags).toContain("update:arithmetic");
    expect(call?.flags).toContain("transaction:condition-check");
  });

  it("detects document client method style only when TableName is present", () => {
    const text = `import AWS from "aws-sdk";
db.get({ TableName: "t", Key: { pk: "1" } });
map.get("key");`;
    const report = scanSources({ files: [{ path: "a.js", text }] });
    expect(report.calls).toHaveLength(1);
    expect(report.calls[0]?.style).toBe("method");
  });

  it("reports composite keys and sets", () => {
    const text = `${sdkImport}
const entity = \`user#\${id}\`;
const members = new Set(ids);`;
    const ids = scanSources({ files: [{ path: "a.ts", text }] }).signals.map((signal) => signal.id);
    expect(ids).toContain("composite-key");
    expect(ids).toContain("sets");
  });
});

describe("extractBalanced", () => {
  it("skips parentheses inside strings", () => {
    const text = `f({ a: ")" , b: 1 }) + g()`;
    expect(extractBalanced({ text, openIndex: 1 })).toBe(`{ a: ")" , b: 1 }`);
  });
});
