---
name: dynamodb-to-dsql
description: Migrate an application from Amazon DynamoDB to Aurora DSQL using Drizzle ORM (TypeScript, Node.js or Bun). Discovers the DynamoDB access patterns in a code base (SDK commands, single-table design, GSIs, mirrored items, sets, counters, TTL, transactions, batch calls), proposes the relational and DSQL replacement for each, and helps write an idempotent, verifiable data-migration script plus a cutover plan. Use when someone wants to move from NoSQL to SQL, replace DynamoDB with DSQL, redesign a single-table model relationally, or map DynamoDB operations to SQL. Framework agnostic. Do not use for DynamoDB-only work, other SQL targets (RDS/Aurora PostgreSQL provisioned), or ORMs other than Drizzle unless adapted.
---

# DynamoDB to Aurora DSQL (Drizzle)

Turn a DynamoDB data layer into a relational DSQL data layer without translating items one to
one, and move the data safely. Targets TypeScript on Node.js or Bun; the discovery works on the
DynamoDB calls themselves, so it does not depend on any web framework or DI style.

Drizzle adapter reference: https://github.com/awslabs/aurora-dsql-orms/tree/main/node/drizzle
(read its README first; it is pre-1.0 and changes).

## Files in this skill

| File | Use |
|---|---|
| `scripts/scan-dynamodb-usage.ts` | Static inventory of DynamoDB calls, expressions, key encodings, sets, TTL, streams, IaC. Prints pattern ids. |
| `scripts/profile-table.ts` | Shapes, attribute types, presence, set sizes and ranges of the real data. Structure only, no values. |
| `references/discovery.md` | How to run the discovery and fill the access-pattern worksheet. |
| `references/pattern-catalog.md` | P01-P40: each DynamoDB pattern, its SQL/DSQL replacement, and the traps. |
| `references/dsql-and-drizzle.md` | DSQL limits, Drizzle schema/connection/migration workflow, roles, errors, testing. |
| `references/data-migration.md` | Migration script design, mapping rules, reconciliation, verify, cutover, rollback. |
| `references/worked-example.md` | A real migration (261 items to 593 rows) for calibration. |
| `templates/migration-kit.ts` | Copy-as-is helpers: chunking, findings, load runner, key diff, scan. |
| `templates/migrate-dynamodb-to-dsql.template.ts` | Per-project migration script skeleton (parse, plan, load, verify). |

Paths are relative to this skill's directory. Scripts run with `bun <script>`; tests with
`bun test` in the skill directory.

## Workflow

Do the phases in order. Ask the user at the decision points marked (ask).

### Phase 1: Discover

1. Read `references/discovery.md`.
2. Run `scripts/scan-dynamodb-usage.ts <repo>`; save the output. Then read the code the scanner
   cannot see (wrappers, templated expressions, infrastructure, scripts, persisted model
   copies) as described in the reference.
3. If a stage with data is available (ask before touching any AWS account; read-only), run
   `scripts/profile-table.ts` or ask for `aws dynamodb scan` output.
4. Fill the worksheet: one row per repository method or access pattern, tagged with pattern ids.

### Phase 2: Design the replacement

1. For each pattern id found, apply `references/pattern-catalog.md`. Principles:
   - relational model, not item translation; one row per relation, no mirrored items;
   - no counters or cached aggregates, compute with `count(*)`/`EXISTS`;
   - join instead of "fetch ids then fetch by ids"; set-based statements instead of per-row loops;
   - real foreign keys and CHECK constraints replace `ConditionCheck` items and parsers;
   - `jsonb` only for data whose shape genuinely varies;
   - keep existing ids (`text`) and random ids; no monotonic keys on hot tables.
2. Check `references/dsql-and-drizzle.md` for what DSQL cannot do (arrays, TRUNCATE, triggers,
   3,000 row transactions, `C` collation, async DDL, no TTL) and design around it.
3. Produce: target schema (Drizzle `pg-core`, `casing: "snake_case"`), the per-method SQL
   replacement table, a deliberate-behavior-changes table, a list of persisted model copies
   (S3, queues) to keep compatible. (ask) Confirm behavior changes and any new constraint that
   could reject existing data.

### Phase 3: Implement the data layer

Follow `references/dsql-and-drizzle.md`: client factory with `{ db, transact }`, migrations via
`aurora-dsql-drizzle generate` plus a hand-written `VALIDATE CONSTRAINT` migration, roles and IAM
grants, SQLSTATE error mapping, PGlite-based fast tests plus a static DSQL lint test. Side
effects stay outside `transactionWithRetry` callbacks.

### Phase 4: Write the migration script

1. Follow `references/data-migration.md`. Copy `templates/migration-kit.ts` into the project and
   adapt `templates/migrate-dynamodb-to-dsql.template.ts` using the profile output.
2. Requirements for the script: read-only on DynamoDB, pure `buildPlan`, findings with stable
   codes and ids only, `ON CONFLICT DO NOTHING` chunks of at most 1,000 rows in parent-first
   order, `--dry-run`, `--yes`, `--verify`, no item contents in output.
3. Test `buildPlan` and the load on PGlite: second run inserts 0 rows, verify passes, verify
   fails after a deliberate deletion.

### Phase 5: Cutover plan

Write a runbook from the cutover section of `references/data-migration.md`: dry run on
production first, rehearsal on a non-production stage, announce downtime, deploy, schema as
admin, roles, load, verify, queue/DLQ check, smoke test, go/rollback decision, keep the DynamoDB
table until verified. The user runs deploys and loads on production; prepare filled-in commands
and do read-only checks yourself.

## Rules for this skill

- Never run writes against a user's AWS account, DynamoDB table or DSQL cluster without explicit
  confirmation. Scans for profiling are read-only; say so and ask first.
- Never print or store item contents (emails, names, free text) in reports, logs or journals;
  counts and ids only.
- Mark anything not verified on a live DSQL cluster as UNVERIFIED and cite sources (docs link or
  command) for facts. Re-check limits and syntax against the current DSQL docs.
- Do not use `TRUNCATE`, `SERIAL` keys on hot tables, triggers, PL/pgSQL, temp tables or array
  columns in DSQL.
- Record every deliberate behavior change; do not hide them in the port.
- Keep a dated journal of decisions and measurements while working; it is the factual base for
  documentation or a blog post.
