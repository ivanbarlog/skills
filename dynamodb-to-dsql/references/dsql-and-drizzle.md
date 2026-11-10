# Aurora DSQL with Drizzle: constraints, setup, gotchas

Primary source for the adapter: https://github.com/awslabs/aurora-dsql-orms/tree/main/node/drizzle
(read it before writing code; it changes). Versions observed in the reference migration:
`@aws/aurora-dsql-drizzle` 0.2.0 (pre-1.0, pin it), `drizzle-orm` 0.45.4 (the adapter peers
`^0.45`; Drizzle 1.0 beta replaces the `casing` option, so stay on 0.45), `pg` 8.x,
`drizzle-kit` 0.31.x. Node >= 20.

## Hard constraints to design against

| Area | Fact |
|---|---|
| Isolation | Fixed repeatable read with optimistic concurrency. Conflicts raise 40001 (OC000 data, OC001 schema) at commit. |
| Transaction size | At most 3,000 rows, 10 MiB, 5 minutes. Cascaded rows count. |
| DDL | One DDL statement per transaction. Indexes are `CREATE INDEX ASYNC` (background jobs). |
| Unsupported | Stored array columns, `TRUNCATE`, triggers, PL/pgSQL, temp tables. `GRANT ... ON SCHEMA public` fails with 0A000 (`public` is a system schema). |
| Collation | `C` only. |
| Index keys | No `DESC` index keys. `bytea` is not indexable. |
| JSON | `json`/`jsonb` columns supported, 1 MiB compressed, not indexable. |
| Connections | pg wire protocol, IAM token per new connection, one hour connection cap. |
| Foreign keys | Supported with all referential actions; `ALTER TABLE ... ADD CONSTRAINT` must be `NOT VALID` then `ALTER TABLE ASYNC ... VALIDATE CONSTRAINT`. Updating a parent's key columns conflicts with concurrent child inserts. All DML on FK tables does extra reads (more DPUs). |
| CHECK | Supported. Prefer `CHECK (col IN (...))` over lookup-table FKs for fixed value sets. |
| Billing | DPUs plus storage; aborted/failed transactions are billed; idle scales to zero. Check the pricing page for current rates. |
Sources: AWS DSQL user guide (quotas, supported SQL, concurrency control) and the AWS database
blog "Working with foreign key constraints in Aurora DSQL". Re-verify against the docs.

## Schema in Drizzle

- `drizzle-orm/pg-core`. Ids `text` (keeps existing ids); timestamps
  `timestamp({ withTimezone: true })`; money integer minor units.
- `casing: "snake_case"` in BOTH `drizzle({ ... casing })` and `drizzle.config.ts`: columns are
  declared without explicit names (`createdAt` maps to `created_at`). In the reference run
  `drizzle-kit generate` honoured it; `pushSchema` did not (drizzle-orm issue #3525).
- Composite FKs with `foreignKey({ columns, foreignColumns })`; unique expression index with
  ``uniqueIndex().on(sql`least(a, b)`, sql`greatest(a, b)`)``. Both were accepted by a real
  cluster.
- Declare every index the old GSIs and the new joins need; check query plans with `EXPLAIN` on
  a populated cluster (the pair expression index was used by `least(..) = .. AND greatest(..) = ..`
  on Postgres/PGlite; DSQL planner use is worth confirming).

## Connection

```ts
import { drizzle } from "@aws/aurora-dsql-drizzle";
import * as schema from "./schema.ts";

const db = drizzle({
  connection: { host, region, user, ...(profile != null ? { profile } : {}) },
  schema,
  casing: "snake_case",
});
db.$client.on("error", (error) => console.error("Idle database connection error", error.message));
```

- Create it once per process/Lambda container at module level; never `end()` per request. The
  connector signs a fresh IAM token for each new connection and replaces connections at the
  one hour cap.
- `user` is required; there is no default. Applications connect as a restricted role,
  migrations and one-off scripts as `admin`.
- Add the pool `error` listener: an error on an idle pooled connection is otherwise an
  unhandled `error` event.
- Wrap `transactionWithRetry` once and map `AwsDsqlRetryExhaustedError` to a user-facing
  "please try again" error. Repositories take `{ db, transact }` so tests can substitute
  `db.transaction`.

## Migrations workflow

1. `bunx aurora-dsql-drizzle generate --out ./drizzle -- --config drizzle.config.ts`
   (runs drizzle-kit, then rewrites for DSQL: `CREATE INDEX ASYNC`, `NOT VALID` on FKs, drops
   unsupported `DESC`/`USING BTREE`).
2. Exit code 3 means "fixed with advisories" and is expected whenever the transform changed
   something; it is not a failure.
3. drizzle-kit emits foreign keys as `ALTER TABLE ... ADD CONSTRAINT ... NOT VALID`. Add one
   custom migration (`drizzle-kit generate --custom`) with `ALTER TABLE ASYNC ... VALIDATE
   CONSTRAINT ...` for each. Comments in hand written migrations are stripped by the transform;
   commit the file without comments so `generate` leaves a clean tree.
4. Apply with `migrate(db, { migrationsFolder })` from the adapter, as `admin`. It applies one
   statement per transaction and tracks each statement, and `getMigrationStatus` reports
   progress. Keep drizzle-kit breakpoints on.
5. Expect it to be slow: tens of seconds per index even on empty tables (10 indexes took about
   2m44s on an empty stg cluster; about 11 minutes for the prod schema with 48 statements, index
   builds dominating), with no progress output. Print `SELECT * FROM sys.jobs` while waiting.
6. Known sharp edge: a statement and its tracking row are separate commits. If the client is
   stopped while waiting for an async job, the object exists but is untracked and the re-run
   fails with 42P07 "already exists". Do not interrupt. If it happens, record the first pending
   statement as applied only after confirming the index is valid or the constraint validated
   (the reference project wrote a `--repair` flag doing exactly that).

## Database roles for applications

Run once as `admin` after the schema exists, idempotently:

```sql
CREATE ROLE app_role WITH LOGIN;
AWS IAM GRANT app_role TO 'arn:aws:iam::<account>:role/<lambda-role>';  -- one per IAM role
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_role;
```

- Skip `GRANT USAGE ON SCHEMA public` (0A000); the role had USAGE by default in the reference run.
- Existing mappings are visible in `sys.iam_pg_role_mappings` (`arn`, `pg_role_name`); check
  before granting to stay idempotent.
- IAM side: `dsql:DbConnect` on the cluster ARN for each runtime role. `admin` needs
  `dsql:DbConnectAdmin`.
- After the grants, verify with `has_table_privilege` for every table and fail loudly if
  anything is missing. Local runs as `admin` need a differently named variable than the
  application role name, otherwise one variable ends up meaning two things.
- Endpoint: `<cluster identifier>.dsql.<region>.on.aws`. In CDK `CfnCluster` has no L2; the
  `Ref` returns the identifier.

## Error handling

```ts
export function toSqlState(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== "object" || current == null) return undefined;
    if ("code" in current && typeof current.code === "string" && /^[0-9A-Z]{5}$/.test(current.code))
      return current.code;
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}
```

Codes: 23505 unique, 23503 foreign key, 23514 check, 40001 OCC conflict.

## Testing without a cluster

- Use PGlite (`@electric-sql/pglite`, `drizzle-orm/pglite`): a real Postgres in-process, no
  Docker or network. Apply the committed migration files through a normalizer that strips
  `ASYNC` (`CREATE INDEX ASYNC` -> `CREATE INDEX`, `ALTER TABLE ASYNC` -> `ALTER TABLE`);
  reset between tests with `DELETE` in FK order (not `TRUNCATE`). It enforced unique expression
  indexes, composite FKs, CHECK, `ON CONFLICT`, `INSERT ... SELECT ... RETURNING`,
  `DELETE ... RETURNING` and SQLSTATE codes. Startup was 1-2 s once per process.
- PGlite is more permissive than DSQL (it accepts `SERIAL`, `TRUNCATE`), so add a static test
  running `aurora-dsql-drizzle lint` (from `@aws/dsql-lint`) over `drizzle/*.sql`.
- Real DSQL behavior (OCC conflicts, row caps, IAM, async DDL timing) needs a flagged, opt-in
  suite or a rehearsal on a non-production cluster; never put it in the default test run.
- Once, PGlite crashed with `PANIC ERRORDATA_STACK_SIZE exceeded` on `VALIDATE CONSTRAINT`
  (not reproducible). If it recurs, skip `VALIDATE` statements in the normalizer.

## Measured, indicative (one app, one run, 1,024 MB Lambda)

Warm p50 was equal (33.9 vs 35.2 ms). Reads were equal or faster on DSQL; writes were slower
in the same click path (a delete 47-66 ms vs 35-41 ms, an insert 65-123 ms vs 54-97
ms). Cold start heavier: init 461 vs 271-376 ms; first request 395 vs 214 ms
(token signing plus first connection). One run each; measure your own workload on your own
data, on the same stage, before and after, under the same conditions.
