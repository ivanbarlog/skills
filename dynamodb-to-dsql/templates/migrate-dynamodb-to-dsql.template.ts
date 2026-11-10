// TEMPLATE. Copy to scripts/migrate-dynamodb-to-dsql.ts and replace the `todo:` parts.
// The placeholder entities only show the shape of the code; rename them to your own tables and
// derive the real parsers from references/data-migration.md and your profile-table.ts output.
//   root       = an entity with no foreign keys (loaded first)
//   child      = an entity with a foreign key to a root and a set attribute of root ids
//   childLink  = the join table rows produced by unrolling that set attribute
//
//   bun scripts/migrate-dynamodb-to-dsql.ts --dry-run             read + classify + report, no DSQL access
//   bun scripts/migrate-dynamodb-to-dsql.ts --yes                 load (idempotent, re-runnable)
//   bun scripts/migrate-dynamodb-to-dsql.ts --verify [--sample N] compare source and target
//
// Environment: DATA_TABLE_NAME, AWS_REGION, (--yes/--verify) DSQL_ENDPOINT, DSQL_REGION.
// DynamoDB is only read. Only counts and ids are printed, never personal data or free text.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { drizzle } from "@aws/aurora-dsql-drizzle";
import { count } from "drizzle-orm";

import {
  asIsoDate,
  asString,
  asStringSet,
  bad,
  createFindings,
  diffKeys,
  formatFindings,
  formatLoadResults,
  loadTables,
  ok,
  scanAll,
  sortBy,
  tableLoad,
  type Finding,
  type Parsed,
  type SourceItem,
} from "./migration-kit.ts";
// todo: your Drizzle schema
import * as schema from "./db/schema.ts";

const { childLinks, children, roots } = schema;

function toDb(props: { readonly host: string; readonly region: string }) {
  // Local runs connect as `admin` (the local IAM identity is not mapped to an application role).
  return drizzle({
    connection: { host: props.host, region: props.region, user: "admin" },
    schema,
    casing: "snake_case",
  });
}

type Tx = Parameters<Parameters<ReturnType<typeof toDb>["transaction"]>[0]>[0];

type RootRow = typeof roots.$inferInsert;
type ChildRow = typeof children.$inferInsert;
type ChildLinkRow = typeof childLinks.$inferInsert;

export interface Plan {
  readonly roots: Array<RootRow>;
  readonly children: Array<ChildRow>;
  readonly childLinks: Array<ChildLinkRow>;
  readonly findings: ReadonlyArray<Finding>;
  readonly sourceCounts: Record<string, number>;
}

// todo: one parser per item shape from profile-table.ts. Return `bad(reason)` instead of throwing.
function parseRoot(item: SourceItem): Parsed<RootRow> {
  const id = asString(item.id);
  const createdAt = asIsoDate(item.createdAt);
  if (id == null) return bad("id");
  if (typeof item.name !== "string") return bad("name");
  if (createdAt == null) return bad("createdAt");
  return ok({ id, name: item.name, createdAt, updatedAt: asIsoDate(item.updatedAt) ?? createdAt });
}

interface ParsedChild {
  readonly row: ChildRow;
  readonly linkedRootIds: Set<string>;
}

function parseChild(item: SourceItem): Parsed<ParsedChild> {
  const id = asString(item.id);
  const rootId = asString(item.rootId);
  const createdAt = asIsoDate(item.createdAt);
  if (id == null) return bad("id");
  if (rootId == null) return bad("rootId");
  if (typeof item.name !== "string") return bad("name");
  if (createdAt == null) return bad("createdAt");
  const row = { id, name: item.name, rootId, createdAt, updatedAt: asIsoDate(item.updatedAt) ?? createdAt };
  return ok({ row, linkedRootIds: asStringSet(item.linkedRootIds) });
}

export function buildPlan(items: ReadonlyArray<SourceItem>, now: Date = new Date()): Plan {
  const findings = createFindings();
  const sourceCounts: Record<string, number> = {};
  const rootRows = new Map<string, RootRow>();
  const parsedChildren: Array<ParsedChild> = [];

  for (const item of items) {
    // todo: classify by your discriminator (entity prefix, pk prefix, attribute presence)
    const kind = typeof item.entity === "string" ? item.entity.split("|")[0] ?? "" : "";
    sourceCounts[kind] = (sourceCounts[kind] ?? 0) + 1;
    const ref = `id=${String(item.id)}`;

    if (kind === "root") {
      const parsed = parseRoot(item);
      if (!parsed.ok) findings.add("root.malformed", "skipped", `${ref} field=${parsed.reason}`);
      else rootRows.set(parsed.value.id, parsed.value);
    } else if (kind === "child") {
      const parsed = parseChild(item);
      if (!parsed.ok) findings.add("child.malformed", "skipped", `${ref} field=${parsed.reason}`);
      else parsedChildren.push(parsed.value);
    } else {
      findings.add("item.unknown-entity", "skipped", `${ref} entity=${kind}`);
    }
  }

  // Referential integrity is decided here, in memory, so the load never trips a foreign key
  // and every skipped row is reported with the reason.
  const childRows: Array<ChildRow> = [];
  const linkRows: Array<ChildLinkRow> = [];
  for (const child of parsedChildren) {
    if (!rootRows.has(child.row.rootId)) {
      findings.add("child.root-missing", "skipped", `child=${child.row.id} root=${child.row.rootId}`);
      continue;
    }
    childRows.push(child.row);
    for (const rootId of child.linkedRootIds) {
      if (!rootRows.has(rootId)) {
        findings.add("link.root-missing", "skipped", `child=${child.row.id} root=${rootId}`);
        continue;
      }
      linkRows.push({ childId: child.row.id, rootId, createdAt: child.row.createdAt });
    }
  }

  return {
    roots: sortBy([...rootRows.values()], (row) => row.id),
    children: sortBy(childRows, (row) => row.id),
    childLinks: sortBy(linkRows, (row) => `${row.childId}|${row.rootId}`),
    findings: findings.list(),
    sourceCounts,
  };
}

async function main(): Promise<void> {
  const flags = new Set(process.argv.slice(2));
  const tableName = process.env.DATA_TABLE_NAME;
  if (tableName == null) throw new Error("DATA_TABLE_NAME is required");

  const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const items = await scanAll({
    tableName,
    send: (input) => dynamo.send(new ScanCommand(input)) as never,
  });
  const plan = buildPlan(items);

  console.log("Source items per kind:", plan.sourceCounts);
  console.log(`Planned rows: roots=${plan.roots.length} children=${plan.children.length} child_links=${plan.childLinks.length}`);
  console.log(formatFindings(plan.findings));
  if (flags.has("--dry-run") || (!flags.has("--yes") && !flags.has("--verify"))) return;

  const host = process.env.DSQL_ENDPOINT;
  const region = process.env.DSQL_REGION;
  if (host == null || region == null) throw new Error("DSQL_ENDPOINT and DSQL_REGION are required");
  const db = toDb({ host, region });
  try {
    if (flags.has("--yes")) {
      const results = await loadTables({
        transact: (fn) => db.transactionWithRetry(fn),
        // Parents first.
        tables: [
          tableLoad({
            table: "roots",
            rows: plan.roots,
            insert: async (tx: Tx, chunk: Array<RootRow>) =>
              (await tx.insert(roots).values(chunk).onConflictDoNothing().returning({ key: roots.id })).length,
          }),
          tableLoad({
            table: "children",
            rows: plan.children,
            insert: async (tx: Tx, chunk: Array<ChildRow>) =>
              (await tx.insert(children).values(chunk).onConflictDoNothing().returning({ key: children.id })).length,
          }),
          tableLoad({
            table: "child_links",
            rows: plan.childLinks,
            insert: async (tx: Tx, chunk: Array<ChildLinkRow>) =>
              (
                await tx
                  .insert(childLinks)
                  .values(chunk)
                  .onConflictDoNothing()
                  .returning({ key: childLinks.rootId })
              ).length,
          }),
        ],
      });
      console.log(formatLoadResults(results));
    }

    if (flags.has("--verify")) {
      const actualRoots = new Set((await db.select({ id: roots.id }).from(roots)).map((row) => row.id));
      const diff = diffKeys({
        table: "roots",
        expected: new Set(plan.roots.map((row) => row.id)),
        actual: actualRoots,
      });
      const [total] = await db.select({ total: count() }).from(childLinks);
      console.log(`roots: missing=${diff.missingInTarget.length} unexpected=${diff.unexpectedInTarget.length}`);
      console.log(`child_links: expected=${plan.childLinks.length} actual=${total?.total ?? 0}`);
      // todo: amount sums per table, then a domain parity check for N sampled aggregates
      // (compute the same business number from DynamoDB items and from DSQL rows, compare).
      if (diff.missingInTarget.length > 0 || diff.unexpectedInTarget.length > 0) process.exitCode = 1;
    }
  } finally {
    await db.$client.end();
  }
}

if (import.meta.main) await main();
