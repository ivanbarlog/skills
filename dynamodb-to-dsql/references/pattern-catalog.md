# Pattern catalog: DynamoDB to Aurora DSQL (Drizzle)

Ids (P01...) are referenced by `scripts/scan-dynamodb-usage.ts`. Each entry: what it looks
like, the SQL replacement, and the traps. Evidence comes from a real migration of a
SvelteKit expense-splitting app (about 2,600 lines of data layer, 261 production items that
became 593 rows). Anything marked UNVERIFIED was not run on a live DSQL cluster.

Guiding rule: do not translate items one to one. Model the entities and relations, then
let constraints and queries replace the code that kept DynamoDB items consistent.

## Contents

- Model: P01-P10
- Reads: P11-P17
- Writes: P20-P28
- Platform features: P29-P40

## Model

### P01 Single table with an entity discriminator

Looks like: one table, `id` + `entity` keys (or `pk`/`sk`), several item shapes in it.
SQL: one table per entity. The discriminator disappears. Use `text` ids so existing ids are
preserved; keep random ids (no `serial`, no monotonic keys on write-hot tables).
Trap: shapes you did not know existed. Run `profile-table.ts` and make sure every shape has a
destination or an explicit "dropped" decision.

### P02 Composite key encoded in a string

Looks like: `` `${userId}#${createdAt}#${groupId}` ``, `entity: "member|user|<id>"`,
`id.split("#")` in parsers.
SQL: real typed columns, composite primary key. Replace `split` parsing with columns.
Trap: the encoded part may carry data that has no other home (a creation timestamp in the
key). Move it to a column before dropping the key. When two ids used to differ only in an
embedded timestamp, the new primary key may collapse them; the migration must pick one
(newest) and report it.

### P03 Global secondary index / reverse index

Looks like: `IndexName`, "list all of entity X" through a GSI whose partition key is the
discriminator, reverse lookups (items by user).
SQL: an ordinary index on the lookup columns. "List all rows of an entity" is just the table.
Trap: indexes are created with `CREATE INDEX ASYNC` and build as background jobs; tens of
seconds each even on an empty table. The GSI hot partition problem (all rows of one entity in
one partition) is gone; do not recreate it with monotonic keys.

### P04 Mirrored items (the same fact stored twice)

Looks like: a friendship or membership written as two items in one transaction, one per side,
so each side can query its own partition.
SQL: one row per relation. Roles stay as columns (`requester_id`, `acceptor_id`) when they
mean something. If the pair is unordered, enforce uniqueness with an expression index:
`CREATE UNIQUE INDEX ASYNC ... ON t ((least(a, b)), (greatest(a, b)))`. An application level
"does the reverse exist" check races under snapshot isolation (two transactions writing
different rows both pass it). Query both directions with `UNION ALL`, one branch per index.
Trap: mirrors drift. In the reference migration 5 of 35 user-side membership items had no
counterpart, with no visible symptom. The migration script must cross-check both sides and
report disagreements instead of trusting either blindly.

### P05 String / number sets

Looks like: `new Set(...)`, `ADD`/`DELETE` update expressions, `SS`/`NS`.
SQL: a join table with one row per element (DSQL has no stored array columns). Per-element
attributes (notify flag, confirmed time) become columns on the join row.
Trap: sets can contain stale ids (members removed without clearing a second set). Load only
elements whose target exists and report the rest.

### P06 Nested maps and lists

Looks like: an `expense.borrowers` list of `{user, share}`, a map of sets.
SQL: a child table (`expense_borrowers`) with a composite foreign key to the parent. Use
`jsonb` only for data whose shape genuinely varies; never for relations or for data that can be
columns. Document why for every `jsonb` column (1 MiB compressed limit, not indexable).

### P07 Counters and stored aggregates

Looks like: `expensesCount`, `groupsCount`, `ADD #count :n` in transactions, `membersCount`.
SQL: delete the column; compute `count(*)` or, for yes/no questions, `EXISTS`. Fetch a badge
count in the same statement as the row it belongs to (scalar subquery).
Trap: a counter often doubles as a hot item (every write touches the parent). Removing it also
removes the OCC conflict hot spot. If you measure a real need for a stored aggregate, add it
deliberately and journal why.

### P08 Cached derived values

Looks like: a stored `breakdown` string or `debts` map recomputed on write.
SQL: derive on read, or store as proper rows when they are state (settled flags). Keep complex
algorithms in the application; do not port them to SQL.
Trap: derived values may have changed type over time (a string that was an object for a year).
Readers of stored snapshots must accept every historic form.

### P09 Prefix queries on the sort key

Looks like: `begins_with(#id, :prefix)`, `KeyConditionExpression` with `BETWEEN`.
SQL: `WHERE group_id = $1`. A prefix was a poor man's foreign key.

### P10 Sparse indexes

Looks like: a GSI that only contains items having a certain attribute.
SQL: `WHERE column IS NOT NULL` in the query plus an ordinary index. Partial indexes are
UNVERIFIED on DSQL; check the supported-SQL page before relying on them.

## Reads

### P11 GetItem

`SELECT ... WHERE id = $1`. Missing row: raise your domain "not found" error.

### P12 BatchGet / TransactGet and the `getMany` helper

DynamoDB cannot join, so lists of ids were fetched in chunks of 100 with an unprocessed-keys
loop. Decide by where the ids come from:

| Ids come from | Replace with |
|---|---|
| A relationship in the database (members of a group) | `JOIN` or subquery on that relationship. Never select ids and then select by ids. |
| Outside the database (request input, an S3 snapshot) | `WHERE id IN (...)` (Drizzle `inArray`), chunk only if huge |
| A known pair | two lookups or `IN (a, b)`; never rely on result order |

Keep the helper's contract if callers depend on it (input order, duplicates allowed, missing
id raises). Other multi-get callers usually become joins and the helper shrinks to the
"external ids" case.

### P13 Query with FilterExpression

Move the filter into `WHERE`; a filter on a non-key attribute no longer costs read capacity
for discarded rows. Add an index if the predicate is selective.

### P14 Scan

Not needed in application code. In migration scripts use one paginated, consistent scan.

### P15 Pagination (`LastEvaluatedKey`)

Hide it behind an `all()` helper in the old code; in SQL use `LIMIT`/keyset pagination
(`WHERE (created_at, id) < ($1, $2) ORDER BY created_at DESC, id DESC LIMIT n`).

### P16 ProjectionExpression

Select the needed columns.

### P17 ConsistentRead

DSQL reads are strongly consistent within a transaction snapshot; drop the flag. There is no
eventual-consistency GSI lag to design around.

## Writes

### P20 Put without a condition (silent overwrite)

Looks like: `PutCommand` with no `ConditionExpression`. Decide per call site what it was
meant to be and write it down:
- create-only: `INSERT` (a duplicate raises 23505);
- idempotent create: `INSERT ... ON CONFLICT DO NOTHING RETURNING` (empty result = already existed);
- true upsert: `INSERT ... ON CONFLICT (...) DO UPDATE`.
Trap: the old code may have overwritten a confirmed record by accident (a repeated friend
request reset a confirmed friendship). Changing that is a behavior change: record it.

### P21 Put with `attribute_not_exists`

`INSERT`; map SQLSTATE 23505 to your "already exists" error.

### P22 Update with `attribute_exists` / key equality condition

`UPDATE ... WHERE id = $1 RETURNING *`; zero rows means not found (or "already in that state"
when the condition encoded a state, e.g. `WHERE confirmed_at IS NULL`).

### P23 Update expressions

| Expression | SQL |
|---|---|
| `SET a = :v` | `SET a = $1` |
| `SET n = n + :x`, `if_not_exists` | `SET n = coalesce(n, 0) + $1` (or remove the counter, P07) |
| `ADD s :member`, `DELETE s :member` on sets | `INSERT` / `DELETE` on the join table (P05) |
| `list_append` | insert child rows (P06) |
| `REMOVE a` | `SET a = NULL` |
| Dynamically assembled expression strings | a partial `set` object built in code; the scanner flags these as `update:templated`, read them by hand |
Always also set `updated_at`.

### P24 Conditional delete and other conditions

`DELETE ... WHERE id = $1 AND <guard> RETURNING`. Guards about other rows ("no expenses
exist") become `NOT EXISTS (...)` inside the same statement or transaction, with a foreign
key `RESTRICT` as the safety net for the race.

### P25 TransactWriteItems

One database transaction via `db.transactionWithRetry(async (tx) => ...)`.
- `Put`/`Update`/`Delete` items become statements.
- `ConditionCheck` items (for example "every borrower is a member") become foreign keys, CHECK
  constraints, or a guard in the `WHERE`. A composite FK replaces N condition checks and lifts
  the 100-item transaction limit.
- The callback is re-run on OCC conflict, so it must be idempotent and free of side effects
  (no email, queue, S3 writes); do those after the transaction returns.
- Isolation is repeatable read with optimistic concurrency, not serializable. Conflicts only
  occur when two transactions write the same row. Do not assume `SELECT ... FOR UPDATE` can
  lock a row that does not exist; use a unique index for "at most one".
- Limits: 3,000 rows and 10 MiB per transaction, 5 minutes. Cascades count toward the row cap.

### P26 BatchWriteItem

- Many deletes by id -> `DELETE ... WHERE <condition>` (the condition that produced the id
  list), chunked under the row cap, children first.
- Many puts -> multi-row `INSERT ... ON CONFLICT DO NOTHING`, or `INSERT ... SELECT` when the
  rows derive from other rows (it can `RETURNING` exactly what was created, e.g. to email it).
- Delete-then-send flows (at-most-once): `DELETE ... WHERE ... RETURNING` is atomic and removes
  the list-then-delete race.

### P27 Optimistic locking (`version` attribute)

DSQL already detects write-write conflicts at commit (SQLSTATE 40001, retried by
`transactionWithRetry`). Keep a `version` column only when a read-modify-write spans several
requests (a form edited for minutes); then `UPDATE ... WHERE id = $1 AND version = $2`.

### P28 Idempotency tokens

`ClientRequestToken` or a conditional put on a request id -> a unique constraint plus
`ON CONFLICT DO NOTHING`. Queue re-delivery safety (SQS) is usually best served by
`DO NOTHING` on the natural key; verify that a re-run does not reset settled state.

## Platform features

### P29 TTL

DynamoDB TTL deletes lazily and for free. DSQL has none. Replace with:
1. an `expires_at timestamptz` column and an index on it;
2. every read filters `expires_at > now()` (so correctness never depends on cleanup);
3. a scheduled job deleting in chunks of at most 1,000 rows
   (`DELETE ... WHERE id IN (SELECT id ... WHERE expires_at <= now() LIMIT 1000)`), looped with
   a call cap, failures logged and swallowed so they cannot fail the host job.
TTL attributes are epoch seconds; convert on migration (`new Date(seconds * 1000)`) and skip
already expired items.

### P30 DynamoDB Streams

No change data capture, triggers or PL/pgSQL in DSQL. Replace stream consumers with: events
emitted by the application after the commit, or an outbox table plus a scheduled poller.
UNVERIFIED which of the two fits; design it per consumer.

### P31 Error handling

| DynamoDB | DSQL (SQLSTATE) |
|---|---|
| ConditionalCheckFailed (not exists) | 23505 unique violation |
| ConditionalCheckFailed (exists / state) | 0 rows returned |
| TransactionCanceled with CancellationReasons | 23505, 23503 foreign key, 23514 check, or a guard returning 0 rows |
| Throttling, TransactionConflict | 40001 (OC000 data, OC001 schema), retried by `transactionWithRetry`; exhausted retries throw `AwsDsqlRetryExhaustedError` |
Drizzle 0.45 wraps driver errors in `DrizzleQueryError`; the pg error is in `.cause`, so walk
the cause chain to read `code`.

### P32 Size and count limits

400 KB item, 100 transaction items, 25 batch items disappear; 3,000 rows / 10 MiB per
transaction, 1 MiB compressed per jsonb value, and a one hour connection cap appear. Put chunk
sizes in named constants and unit-test them.

### P33 Ordering

Sort keys gave free ordering. In SQL write `ORDER BY`. DSQL supports only the `C` collation:
text sorts bytewise (uppercase before lowercase, non-ASCII last), so keep `localeCompare` in
the application for user-visible name ordering. No descending index keys (use a backward scan).

### P34 Hot keys

Keep random ids. Removing counters (P07) removes the usual hot row.

### P35 Validating every item on read

Parsers like `parseOne` on each read exist because the table is schemaless. Move the rules to
column types, NOT NULL, CHECK and foreign keys; keep schema validation (Valibot, Zod) only at
the input boundary.

### P36 Schemaless drift

Old items miss attributes added later; defaults lived in code. Decide defaults per column
(`DEFAULT`, `NOT NULL`) and apply them in the migration parser. Report items that cannot be
represented instead of loading something invented.

### P37 Dates

ISO strings and epoch seconds/millis -> `timestamp with time zone` (UTC). Convert in the parser;
epoch TTL values are seconds.

### P38 Numbers

DynamoDB numbers are arbitrary precision. Choose per column: `integer` (check the range; reject
values outside int32 in the parser), `bigint`, `numeric`, or `double precision` when the code
multiplies by fractions and you must keep the exact current behavior. Money: integer minor units.

### P39 Side effects and persisted copies of the model

Anything that serialized the old model outside the table must be reviewed: S3 snapshots,
queued SQS messages, caches, emails. In the reference migration, removing a counter from the
model silently changed an S3 snapshot format and broke reading old and new snapshots; the type
checker cannot see across JSON. Make readers tolerant (`optional`) and test with a snapshot
written by the new code and one written by the old.

### P40 Infrastructure and operational features

- Table definition, GSIs, TTL attribute, streams, PITR, deletion protection, billing mode and
  global tables are all CDK/CloudFormation/Terraform concerns. DSQL has an L1 `CfnCluster`
  (CDK) with deletion protection; no VPC is required.
- Backups, PITR and multi-region: map each to the DSQL equivalent deliberately (UNVERIFIED in
  this catalog); do not assume parity.
- Keep the DynamoDB table (RETAIN) until the data migration is verified; remove it in a
  separate, explicit change.
- Each Lambda (or service) needs `dsql:DbConnect` on the cluster ARN and a database role
  mapped to its IAM role (see `dsql-and-drizzle.md`).
