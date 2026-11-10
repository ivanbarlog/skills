// TEMPLATE. Copy to scripts/migrate-dynamodb-to-dsql.ts and replace the `todo:` parts.
// The example entities (user, group with a member set) only show the shape of the code;
// derive the real parsers from references/data-migration.md and your profile-table.ts output.
//
//   bun scripts/migrate-dynamodb-to-dsql.ts --dry-run             read + classify + report, no DSQL access
//   bun scripts/migrate-dynamodb-to-dsql.ts --yes                 load (idempotent, re-runnable)
//   bun scripts/migrate-dynamodb-to-dsql.ts --verify [--sample N] compare source and target
//
// Environment: DATA_TABLE_NAME, AWS_REGION, (--yes/--verify) DSQL_ENDPOINT, DSQL_REGION.
// DynamoDB is only read. Only counts and ids are printed, never names, emails or free text.
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

const { groupMembers, groups, users } = schema;

function toDb(props: { readonly host: string; readonly region: string }) {
  // Local runs connect as `admin` (the local IAM identity is not mapped to an application role).
  return drizzle({
    connection: { host: props.host, region: props.region, user: "admin" },
    schema,
    casing: "snake_case",
  });
}

type Tx = Parameters<Parameters<ReturnType<typeof toDb>["transaction"]>[0]>[0];

type UserRow = typeof users.$inferInsert;
type GroupRow = typeof groups.$inferInsert;
type GroupMemberRow = typeof groupMembers.$inferInsert;

export interface Plan {
  readonly users: Array<UserRow>;
  readonly groups: Array<GroupRow>;
  readonly groupMembers: Array<GroupMemberRow>;
  readonly findings: ReadonlyArray<Finding>;
  readonly sourceCounts: Record<string, number>;
}

// todo: one parser per item shape from profile-table.ts. Return `bad(reason)` instead of throwing.
function parseUser(item: SourceItem): Parsed<UserRow> {
  const id = asString(item.id);
  const createdAt = asIsoDate(item.createdAt);
  if (id == null) return bad("id");
  if (typeof item.name !== "string") return bad("name");
  if (createdAt == null) return bad("createdAt");
  return ok({ id, name: item.name, createdAt, updatedAt: asIsoDate(item.updatedAt) ?? createdAt });
}

interface ParsedGroup {
  readonly row: GroupRow;
  readonly memberIds: Set<string>;
}

function parseGroup(item: SourceItem): Parsed<ParsedGroup> {
  const id = asString(item.id);
  const ownerId = asString(item.ownerId);
  const createdAt = asIsoDate(item.createdAt);
  if (id == null) return bad("id");
  if (ownerId == null) return bad("ownerId");
  if (typeof item.name !== "string") return bad("name");
  if (createdAt == null) return bad("createdAt");
  const row = { id, name: item.name, ownerId, createdAt, updatedAt: asIsoDate(item.updatedAt) ?? createdAt };
  return ok({ row, memberIds: asStringSet(item.members) });
}

export function buildPlan(items: ReadonlyArray<SourceItem>, now: Date = new Date()): Plan {
  const findings = createFindings();
  const sourceCounts: Record<string, number> = {};
  const userRows = new Map<string, UserRow>();
  const parsedGroups: Array<ParsedGroup> = [];

  for (const item of items) {
    // todo: classify by your discriminator (entity prefix, pk prefix, attribute presence)
    const kind = typeof item.entity === "string" ? item.entity.split("|")[0] ?? "" : "";
    sourceCounts[kind] = (sourceCounts[kind] ?? 0) + 1;
    const ref = `id=${String(item.id)}`;

    if (kind === "user") {
      const parsed = parseUser(item);
      if (!parsed.ok) findings.add(`user.malformed`, "skipped", `${ref} field=${parsed.reason}`);
      else userRows.set(parsed.value.id, parsed.value);
    } else if (kind === "group") {
      const parsed = parseGroup(item);
      if (!parsed.ok) findings.add(`group.malformed`, "skipped", `${ref} field=${parsed.reason}`);
      else parsedGroups.push(parsed.value);
    } else {
      findings.add("item.unknown-entity", "skipped", `${ref} entity=${kind}`);
    }
  }

  // Referential integrity is decided here, in memory, so the load never trips a foreign key
  // and every skipped row is reported with the reason.
  const groupRows: Array<GroupRow> = [];
  const memberRows: Array<GroupMemberRow> = [];
  for (const group of parsedGroups) {
    if (!userRows.has(group.row.ownerId)) {
      findings.add("group.owner-missing", "skipped", `group=${group.row.id} owner=${group.row.ownerId}`);
      continue;
    }
    groupRows.push(group.row);
    for (const userId of group.memberIds) {
      if (!userRows.has(userId)) {
        findings.add("member.user-missing", "skipped", `group=${group.row.id} user=${userId}`);
        continue;
      }
      memberRows.push({ groupId: group.row.id, userId, createdAt: group.row.createdAt });
    }
  }

  return {
    users: sortBy([...userRows.values()], (row) => row.id),
    groups: sortBy(groupRows, (row) => row.id),
    groupMembers: sortBy(memberRows, (row) => `${row.groupId}|${row.userId}`),
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
  console.log(`Planned rows: users=${plan.users.length} groups=${plan.groups.length} group_members=${plan.groupMembers.length}`);
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
            table: "users",
            rows: plan.users,
            insert: async (tx: Tx, chunk: Array<UserRow>) =>
              (await tx.insert(users).values(chunk).onConflictDoNothing().returning({ key: users.id })).length,
          }),
          tableLoad({
            table: "groups",
            rows: plan.groups,
            insert: async (tx: Tx, chunk: Array<GroupRow>) =>
              (await tx.insert(groups).values(chunk).onConflictDoNothing().returning({ key: groups.id })).length,
          }),
          tableLoad({
            table: "group_members",
            rows: plan.groupMembers,
            insert: async (tx: Tx, chunk: Array<GroupMemberRow>) =>
              (
                await tx
                  .insert(groupMembers)
                  .values(chunk)
                  .onConflictDoNothing()
                  .returning({ key: groupMembers.userId })
              ).length,
          }),
        ],
      });
      console.log(formatLoadResults(results));
    }

    if (flags.has("--verify")) {
      const actualUsers = new Set((await db.select({ id: users.id }).from(users)).map((row) => row.id));
      const diff = diffKeys({
        table: "users",
        expected: new Set(plan.users.map((row) => row.id)),
        actual: actualUsers,
      });
      const [total] = await db.select({ total: count() }).from(groupMembers);
      console.log(`users: missing=${diff.missingInTarget.length} unexpected=${diff.unexpectedInTarget.length}`);
      console.log(`group_members: expected=${plan.groupMembers.length} actual=${total?.total ?? 0}`);
      // todo: amount sums per table, then a domain parity check for N sampled aggregates
      // (compute the same business number from DynamoDB items and from DSQL rows, compare).
      if (diff.missingInTarget.length > 0 || diff.unexpectedInTarget.length > 0) process.exitCode = 1;
    }
  } finally {
    await db.$client.end();
  }
}

if (import.meta.main) await main();
