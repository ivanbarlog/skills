#!/usr/bin/env bun
// Profile the item shapes stored in a DynamoDB table. Read-only. Prints structure, never values
// (unless --show-values is passed for low-cardinality attributes).
//
//   bun profile-table.ts --table <name> [--region r] [--profile p] [--classify id,entity]
//   bun profile-table.ts --file scan.json [--classify pk,sk]
//
// --file accepts the output of `aws dynamodb scan` (AttributeValue JSON, { "Items": [...] }),
// a JSON array, or JSON lines. --table needs @aws-sdk/lib-dynamodb and @aws-sdk/client-dynamodb
// installed in the directory you run it from.
import { readFileSync } from "node:fs";

export type Item = Record<string, unknown>;

export interface AttributeProfile {
  readonly name: string;
  readonly presentIn: number;
  readonly types: Readonly<Record<string, number>>;
  readonly distinct: number;
  readonly maxLength?: number;
  readonly maxSize?: number;
  readonly min?: number;
  readonly max?: number | undefined;
  readonly allIntegers?: boolean;
  readonly values?: ReadonlyArray<string>;
}

export interface ShapeProfile {
  readonly shape: string;
  readonly count: number;
  readonly attributes: ReadonlyArray<AttributeProfile>;
}

const distinctCap = 1000;
const idLikeSegment = /^[A-Za-z0-9_-]{16,}$|^[0-9a-f]{8}-[0-9a-f]{4}-|^\d{6,}$/;

export function profileItems(props: {
  readonly items: ReadonlyArray<Item>;
  readonly classify: ReadonlyArray<string>;
  readonly showValues?: boolean;
}): Array<ShapeProfile> {
  const groups = new Map<string, Array<Item>>();
  for (const item of props.items) {
    const shape = shapeOf({ item, classify: props.classify });
    const group = groups.get(shape) ?? [];
    group.push(item);
    groups.set(shape, group);
  }
  return [...groups]
    .map(([shape, items]) => ({
      shape,
      count: items.length,
      attributes: profileAttributes({ items, showValues: props.showValues === true }),
    }))
    .sort((left, right) => right.count - left.count);
}

export function shapeOf(props: { readonly item: Item; readonly classify: ReadonlyArray<string> }): string {
  const parts = props.classify.map((attribute) => {
    const value = props.item[attribute];
    if (typeof value !== "string") return `${attribute}=<${typeName(value)}>`;
    return `${attribute}=${maskIds(value)}`;
  });
  return parts.join(" ");
}

function maskIds(value: string): string {
  return value
    .split(/([#|:])/)
    .map((segment) => (idLikeSegment.test(segment) ? "*" : segment))
    .join("");
}

function profileAttributes(props: {
  readonly items: ReadonlyArray<Item>;
  readonly showValues: boolean;
}): Array<AttributeProfile> {
  const names = new Set<string>();
  for (const item of props.items) for (const name of Object.keys(item)) names.add(name);

  return [...names].sort().map((name): AttributeProfile => {
    const types: Record<string, number> = {};
    const distinct = new Set<string>();
    let presentIn = 0;
    let maxLength: number | undefined;
    let maxSize: number | undefined;
    let min: number | undefined;
    let max: number | undefined;
    let allIntegers = true;

    for (const item of props.items) {
      if (!(name in item)) continue;
      presentIn += 1;
      const value = item[name];
      const type = typeName(value);
      types[type] = (types[type] ?? 0) + 1;
      if (distinct.size < distinctCap) distinct.add(stableString(value));
      if (typeof value === "string") maxLength = Math.max(maxLength ?? 0, value.length);
      if (value instanceof Set || Array.isArray(value)) maxSize = Math.max(maxSize ?? 0, sizeOf(value));
      if (typeof value === "number") {
        min = Math.min(min ?? value, value);
        max = Math.max(max ?? value, value);
        if (!Number.isInteger(value)) allIntegers = false;
      }
    }

    const showValues = props.showValues && distinct.size <= 8 && presentIn >= 5;
    return {
      name,
      presentIn,
      types,
      distinct: distinct.size,
      ...(maxLength != null ? { maxLength } : {}),
      ...(maxSize != null ? { maxSize } : {}),
      ...(min != null ? { min, max, allIntegers } : {}),
      ...(showValues ? { values: [...distinct].sort() } : {}),
    };
  });
}

function sizeOf(value: unknown): number {
  if (value instanceof Set) return value.size;
  return Array.isArray(value) ? value.length : 0;
}

function typeName(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (value instanceof Set) {
    const first = [...value][0];
    return `set<${typeof first === "number" ? "number" : "string"}>`;
  }
  if (Array.isArray(value)) return "list";
  if (value instanceof Uint8Array) return "binary";
  return typeof value === "object" ? "map" : typeof value;
}

function stableString(value: unknown): string {
  if (value instanceof Set) return JSON.stringify([...value].sort());
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

export function formatProfile(shapes: ReadonlyArray<ShapeProfile>): string {
  const lines: Array<string> = ["# Table profile", ""];
  const total = shapes.reduce((sum, shape) => sum + shape.count, 0);
  lines.push(`${total} items in ${shapes.length} shape(s).`, "");
  for (const shape of shapes) {
    lines.push(`## ${shape.shape} (${shape.count} items)`, "");
    lines.push("| Attribute | Present | Types | Distinct | Notes |", "|---|---|---|---|---|");
    for (const attribute of shape.attributes) {
      const presence = `${Math.round((attribute.presentIn / shape.count) * 100)}%`;
      const types = Object.entries(attribute.types)
        .map(([type, count]) => `${type}:${count}`)
        .join(" ");
      const notes: Array<string> = [];
      if (attribute.maxLength != null) notes.push(`maxLen ${attribute.maxLength}`);
      if (attribute.maxSize != null) notes.push(`maxSize ${attribute.maxSize}`);
      if (attribute.min != null)
        notes.push(`${attribute.min}..${attribute.max} ${attribute.allIntegers === true ? "int" : "fraction"}`);
      if (attribute.values != null) notes.push(`values ${attribute.values.join(", ")}`);
      const capped = attribute.distinct >= distinctCap ? `${distinctCap}+` : String(attribute.distinct);
      lines.push(`| ${attribute.name} | ${presence} | ${types} | ${capped} | ${notes.join("; ")} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function unmarshallAttributeValue(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const entries = Object.entries(value);
  const [tag, inner] = entries.length === 1 ? (entries[0] ?? []) : [];
  if (tag === "S" || tag === "BOOL") return inner;
  if (tag === "N") return Number(inner);
  if (tag === "NULL") return null;
  if (tag === "B") return new Uint8Array();
  if (tag === "SS") return new Set(inner as Array<string>);
  if (tag === "NS") return new Set((inner as Array<string>).map(Number));
  if (tag === "L") return (inner as Array<unknown>).map(unmarshallAttributeValue);
  if (tag === "M") return unmarshallItem(inner as Record<string, unknown>);
  return value;
}

export function unmarshallItem(item: Record<string, unknown>): Item {
  return Object.fromEntries(
    Object.entries(item).map(([name, value]) => [name, unmarshallAttributeValue(value)]),
  );
}

export function parseItemsFile(text: string): Array<Item> {
  const trimmed = text.trim();
  const rows: Array<Record<string, unknown>> = trimmed.startsWith("[")
    ? JSON.parse(trimmed)
    : trimmed.startsWith("{") && trimmed.includes('"Items"')
      ? JSON.parse(trimmed).Items
      : trimmed.split("\n").map((line) => JSON.parse(line));
  return rows.map(unmarshallItem);
}

async function scanTable(props: {
  readonly table: string;
  readonly region?: string;
  readonly profile?: string;
}): Promise<Array<Item>> {
  const clientModule = "@aws-sdk/client-dynamodb";
  const documentModule = "@aws-sdk/lib-dynamodb";
  const { DynamoDBClient } = await import(clientModule);
  const { DynamoDBDocumentClient, ScanCommand } = await import(documentModule);
  if (props.profile != null) process.env.AWS_PROFILE = props.profile;
  const client = DynamoDBDocumentClient.from(
    new DynamoDBClient(props.region != null ? { region: props.region } : {}),
  );
  const items: Array<Item> = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await client.send(
      new ScanCommand({ TableName: props.table, ConsistentRead: true, ExclusiveStartKey: startKey }),
    );
    items.push(...(page.Items ?? []));
    startKey = page.LastEvaluatedKey;
  } while (startKey != null);
  return items;
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (import.meta.main) {
  const file = option("file");
  const table = option("table");
  if (file == null && table == null) {
    console.error("usage: bun profile-table.ts (--table <name> | --file <path>) [--classify a,b] [--show-values]");
    process.exit(2);
  }
  const items =
    file != null
      ? parseItemsFile(readFileSync(file, "utf8"))
      : await scanTable({
          table: table ?? "",
          ...(option("region") != null ? { region: option("region") as string } : {}),
          ...(option("profile") != null ? { profile: option("profile") as string } : {}),
        });
  const classify = (option("classify") ?? "entity").split(",");
  const shapes = profileItems({ items, classify, showValues: process.argv.includes("--show-values") });
  console.log(formatProfile(shapes));
}
