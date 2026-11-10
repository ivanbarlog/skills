# Discovering DynamoDB patterns in a code base

Goal: produce an inventory that lists, for every place the code touches DynamoDB, which
pattern it is (ids in `pattern-catalog.md`) and what replaces it. Be technology agnostic: the
framework, DI style and wrappers differ per project; the DynamoDB calls do not.

## Step 1: run the scanner

```bash
bun <skill>/scripts/scan-dynamodb-usage.ts <repo> > dynamodb-inventory.md
bun <skill>/scripts/scan-dynamodb-usage.ts <repo> --json > dynamodb-inventory.json
```

It finds, by regex, in `.ts .tsx .js .mjs .cjs .svelte .vue .py` files (skipping `node_modules`,
build output):

- SDK usage: v3 commands (`new GetCommand(...)`), v2/document-client methods (`db.get({ TableName })`),
  helper libraries (`@beesolve/dynamo-helpers`, ElectroDB, dynamodb-toolbox, dynamoose, OneTable).
- For every call: operation, fields used (`IndexName`, `ConsistentRead`, `ExclusiveStartKey`...),
  literal expression strings, `Key` attribute names, transaction item counts, flags and
  pattern ids.
- Signals: composite key encoding, sets, TTL-style attributes, counter-like names, version
  attributes, idempotency tokens, streams, manual marshalling, DynamoDB error handling,
  read-time validation, hand written chunking, and infrastructure (table, GSI, PITR, billing).

It is a candidate finder. False positives are expected (a `new Set` that is not a DynamoDB set,
a `|` in a log message). False negatives are expected too: wrappers hide calls, expressions are
built dynamically (`update:templated`), table names come from env vars.

## Step 2: read what the scanner cannot

1. Every module listed under "Helper wrappers imported" and every in-repo wrapper (a `dynamo.ts`
   with `batchGet`, `queryAll`, `getMany`). Their callers are the real call sites; use
   `grep` for the wrapper names to list them (the reference project had `getMany` with 15 callers).
2. Every file with `update:templated`: open it and expand the expression by hand.
3. The repository layer top to bottom, one module at a time. For each public method write one row
   of the worksheet below.
4. Everything that persists a copy of the model outside the table: S3 objects, queue messages,
   caches, emails, exports (pattern P39).
5. Infrastructure code: table keys, GSIs, TTL attribute, streams, PITR, backups, alarms,
   IAM policies granting `dynamodb:*`, env vars (`TABLE_NAME`, index names).
6. Scripts (backfills, one-off migrations) - they reveal historical shapes and drift.
7. Tests: which ones touch DynamoDB (often few; most fake the repositories).

## Step 3: profile the data

Run `scripts/profile-table.ts` against a stage with realistic data (or a dev copy). It tells you
shapes, attribute presence, types, set sizes, numeric ranges, string lengths, without printing
values. Compare with the code: shapes with no code, attributes with mixed types, attributes
present in 40% of items (added later, defaults in code).

## Step 4: fill the worksheet

One row per repository method or access pattern:

| Method / handler | Items touched | DynamoDB ops | Patterns | SQL replacement | Behavior change? | Atomicity | Callers |
|---|---|---|---|---|---|---|---|

Rules for the SQL column:

- If ids come from a relationship, join; do not fetch ids then fetch by ids (P12).
- Prefer `EXISTS` to `count(*)` for yes/no (P07).
- Prefer `DELETE ... WHERE <condition> [RETURNING]` to listing ids (P26).
- Anything that issues a query per row of a result is a bug to fix, not to port.
- Writes that were a transaction stay one transaction; side effects move after the commit (P25).

Record every deliberate behavior change in a table (date, change, reason). In the worked
example these were: overwrite -> reject duplicates, stricter membership checks, idempotent
re-delivery, no borrower-count cap, counters removed.

## Step 5: decide, then confirm with the owner

Ask the owner (do not guess) when:
- an old behavior looks like a bug (silent overwrite, a check that never existed);
- a new constraint could reject existing data (the migration will report it);
- downtime is acceptable;
- an item shape has no obvious destination;
- anything outside the data table (other tables owned by libraries, sessions) should move.

Write the decisions down in a journal with sources. Mark anything remembered rather than
verified as UNVERIFIED.

## Output of discovery

1. `dynamodb-inventory.md` (scanner) plus the filled worksheet.
2. Target schema proposal (tables, keys, FKs, CHECKs, indexes) mapped from the worksheet.
3. List of behavior changes and open questions.
4. List of persisted model copies (S3, queues) to keep compatible.
5. Migration mapping rules per item shape (feeds `data-migration.md`).
