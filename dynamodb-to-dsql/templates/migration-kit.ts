// Reusable, project independent parts of a DynamoDB -> Aurora DSQL data migration.
// Copy next to your migration script. Nothing here knows your tables.

export const maxRowsPerTransaction = 1_000;
const maxRefsPrintedPerCode = 500;

export type SourceItem = Record<string, unknown>;

export type FindingAction = "skipped" | "imported" | "ignored";

export interface Finding {
  readonly code: string;
  readonly action: FindingAction;
  readonly refs: string;
}

export interface Findings {
  add(code: string, action: FindingAction, refs: string): void;
  list(): ReadonlyArray<Finding>;
}

export function createFindings(): Findings {
  const findings: Array<Finding> = [];
  return {
    add: (code, action, refs) => {
      findings.push({ code, action, refs });
    },
    list: () => findings,
  };
}

export function formatFindings(findings: ReadonlyArray<Finding>): string {
  if (findings.length === 0) return "Reconciliation: no findings.";
  const byCode = new Map<string, Array<Finding>>();
  for (const finding of findings) {
    const group = byCode.get(finding.code) ?? [];
    group.push(finding);
    byCode.set(finding.code, group);
  }
  const lines = [`Reconciliation: ${findings.length} finding(s).`];
  for (const [code, group] of [...byCode].sort()) {
    lines.push(`  ${code} [${group[0]?.action}] x${group.length}`);
    for (const finding of group.slice(0, maxRefsPrintedPerCode)) lines.push(`    ${finding.refs}`);
    if (group.length > maxRefsPrintedPerCode)
      lines.push(`    ... ${group.length - maxRefsPrintedPerCode} more`);
  }
  return lines.join("\n");
}

export type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

export const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
export const bad = (reason: string): Parsed<never> => ({ ok: false, reason });

const int32Max = 2_147_483_647;

export const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

export const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export const asInt32 = (value: unknown): number | undefined => {
  const number = asNumber(value);
  return number != null && Number.isInteger(number) && Math.abs(number) <= int32Max
    ? number
    : undefined;
};

export const asIsoDate = (value: unknown): Date | undefined => {
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

export const asEpochSecondsDate = (value: unknown): Date | undefined => {
  const seconds = asNumber(value);
  return seconds == null ? undefined : new Date(seconds * 1000);
};

export function asStringSet(value: unknown): Set<string> {
  const result = new Set<string>();
  if (value instanceof Set || Array.isArray(value)) {
    for (const entry of value) if (typeof entry === "string" && entry !== "") result.add(entry);
  }
  return result;
}

export function toChunks<T>(rows: ReadonlyArray<T>, size = maxRowsPerTransaction): Array<Array<T>> {
  const chunks: Array<Array<T>> = [];
  for (let index = 0; index < rows.length; index += size) chunks.push(rows.slice(index, index + size));
  return chunks;
}

export function sortBy<T>(rows: ReadonlyArray<T>, key: (row: T) => string): Array<T> {
  return [...rows].sort((left, right) => (key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0));
}

export interface TableLoad<Tx, Row> {
  readonly table: string;
  readonly rows: ReadonlyArray<Row>;
  /** Must be `INSERT ... ON CONFLICT DO NOTHING` and return the number of rows really inserted. */
  readonly insert: (tx: Tx, chunk: Array<Row>) => Promise<number>;
}

export interface PreparedLoad<Tx> {
  readonly table: string;
  readonly planned: number;
  readonly chunks: ReadonlyArray<(tx: Tx) => Promise<number>>;
}

export function tableLoad<Tx, Row>(load: TableLoad<Tx, Row>): PreparedLoad<Tx> {
  return {
    table: load.table,
    planned: load.rows.length,
    chunks: toChunks(load.rows).map((chunk) => (tx: Tx) => load.insert(tx, chunk)),
  };
}

export interface LoadResult {
  readonly table: string;
  readonly planned: number;
  readonly inserted: number;
}

/**
 * Loads tables in the order given (parents first). One transaction per chunk, so a failed
 * run can be repeated: existing rows are left alone and a re-run never overwrites newer data.
 */
export async function loadTables<Tx>(props: {
  readonly transact: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
  readonly tables: ReadonlyArray<PreparedLoad<Tx>>;
  readonly log?: (message: string) => void;
}): Promise<Array<LoadResult>> {
  const log = props.log ?? console.log;
  const results: Array<LoadResult> = [];
  for (const load of props.tables) {
    let inserted = 0;
    for (const [index, insertChunk] of load.chunks.entries()) {
      inserted += await props.transact(insertChunk);
      log(`  ${load.table}: chunk ${index + 1}/${load.chunks.length}`);
    }
    results.push({ table: load.table, planned: load.planned, inserted });
  }
  return results;
}

export function formatLoadResults(results: ReadonlyArray<LoadResult>): string {
  return results
    .map((result) => {
      const present = result.planned - result.inserted;
      return `  ${result.table}: planned=${result.planned} inserted=${result.inserted} alreadyPresent=${present}`;
    })
    .join("\n");
}

export interface KeyDiff {
  readonly table: string;
  readonly missingInTarget: ReadonlyArray<string>;
  readonly unexpectedInTarget: ReadonlyArray<string>;
}

export function diffKeys(props: {
  readonly table: string;
  readonly expected: ReadonlySet<string>;
  readonly actual: ReadonlySet<string>;
}): KeyDiff {
  return {
    table: props.table,
    missingInTarget: [...props.expected].filter((key) => !props.actual.has(key)).sort(),
    unexpectedInTarget: [...props.actual].filter((key) => !props.expected.has(key)).sort(),
  };
}

export async function scanAll(props: {
  readonly send: (input: {
    TableName: string;
    ConsistentRead: boolean;
    ExclusiveStartKey?: Record<string, unknown>;
  }) => Promise<{ Items?: Array<SourceItem>; LastEvaluatedKey?: Record<string, unknown> }>;
  readonly tableName: string;
}): Promise<Array<SourceItem>> {
  const items: Array<SourceItem> = [];
  let startKey: Record<string, unknown> | undefined;
  let pages = 0;
  do {
    const page = await props.send({
      TableName: props.tableName,
      ConsistentRead: true,
      ...(startKey != null ? { ExclusiveStartKey: startKey } : {}),
    });
    items.push(...(page.Items ?? []));
    startKey = page.LastEvaluatedKey;
    pages += 1;
  } while (startKey != null);
  console.log(`DynamoDB Scan: ${items.length} items in ${pages} page(s).`);
  return items;
}
