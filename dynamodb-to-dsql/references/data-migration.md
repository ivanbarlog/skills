# Writing the data migration script (DynamoDB -> DSQL)

Goal: a read-only, idempotent, verifiable script that turns DynamoDB items into relational
rows, and a rehearsed cutover. Starting points in this skill:

- `scripts/profile-table.ts` - what shapes exist in the table (structure only)
- `templates/migration-kit.ts` - chunking, findings, load runner, key diff, scan (copy as is)
- `templates/migrate-dynamodb-to-dsql.template.ts` - the per-project part (parsers, plan, load, verify)

## Principles

1. Read-only on the source. One consistent paginated `Scan`. The old table stays valid, so
   rollback is a redeploy.
2. Pure planning. `buildPlan(items) -> Plan` has no I/O: parse, classify, resolve references in
   memory, produce rows per table plus findings. It is unit-testable with hand-made items.
3. Nothing is dropped silently and nothing invalid is loaded. Every skipped, imported-with-
   caveat or ignored item becomes a finding with a stable code and ids only.
4. Idempotent load. `INSERT ... ON CONFLICT DO NOTHING`, parents first, at most 1,000 rows per
   transaction (the cap is 3,000 rows / 10 MiB). A re-run never overwrites newer data; report
   `planned`, `inserted`, `alreadyPresent` per table.
5. Never print item contents. Counts and ids only (no names, emails, free text), in logs and
   findings.
6. Verify separately. `--verify` compares source and target and exits non-zero on mismatch.
7. Dry run first, on production, read-only, days before the cutover so the findings can be
   decided without time pressure.

## Workflow

1. Run `bun scripts/profile-table.ts --table <t> --classify <discriminator attrs>` (or
   `--file` with `aws dynamodb scan` output). For each shape note attributes, types,
   presence %, sets/lists, numeric ranges, `maxLen`. Presence below 100% means defaults or
   nullable columns; mixed types mean a parser decision.
2. Write the target schema (see `pattern-catalog.md`). For every source shape: target table(s),
   mapping per attribute, items dropped on purpose.
3. Write one parser per shape returning `Parsed<Row>` (`ok(value)` / `bad(reason)`), using the
   `as*` helpers. Unknown shapes become `item.unknown-entity` findings.
4. Write `buildPlan`: parse all, then resolve relations in dependency order (referenced tables
   first, then the tables that point at them, then join/child tables). A row whose parent is not
   loadable is skipped with a finding, together with its dependants. Skip a whole parent entity
   (a record and all its nested children) rather than a partial one, otherwise totals are wrong.
5. Write `loadTables` entries in parent-first order using `onConflictDoNothing().returning(...)`.
6. Write `--verify`: per-table counts and primary-key diffs, sums of money columns on both sides,
   and a domain parity check - compute the same business number (a balance, a total) from the
   DynamoDB items and from the DSQL rows for a sample of aggregates (largest first) and compare.
   Differences fully explained by reported skips are not failures.
7. Unit-test `buildPlan` and the load against PGlite with the committed migration files:
   re-run inserts 0 rows, verify passes, verify fails after a deliberate deletion.
8. Rehearse on a non-production stage with a fresh cluster. Record timings.

## Mapping rules that came up (decide each explicitly)

| Situation | Rule used in the reference migration |
|---|---|
| Set of members on the parent plus mirror items on both sides | The set on the parent is authoritative for the relation; cross-check both mirror kinds and report disagreements |
| Per-member flags stored as separate sets (notify, confirmed) | Columns on the join row (`notify` boolean, `review_confirmed_at`); stale ids for non-members are `ignored` findings |
| A set that had no timestamp but the column needs one | Deterministic value (the parent's `updated_at`), so a re-run is identical and never later than the real time |
| Two mirrored items of one relation | One row; take roles from the stored side markers; if both sides claim the same role on a pending request, skip (a guessed role would let the wrong person accept); on a confirmed relation use a deterministic rule (smaller id) and report it |
| Epoch-second TTL attributes | Convert to `Date`; do not load already expired rows (reads treated them as gone) |
| Boolean flag such as `settled` | Nullable timestamp (`settled_at = updated_at`) |
| Key-embedded data (`<parentId>#<childId>`) | Strip the prefix, move embedded values to columns |
| Duplicate natural keys after collapsing a key (two items differing only by an embedded timestamp) | Keep the newest, report the rest |
| Unique column with duplicates (email) | Keep the oldest, report the rest |
| Counters and cached aggregates | Not migrated; computed |
| Number outside the new column range | Reject the row with a finding (`amount-not-int32`) |
| A new constraint the old code never enforced (payer must be a member) | The plan enforces it; violations are findings, decided by the owner before cutover |

## Reconciliation report

Print, per stable code: action (`skipped` | `imported` | `ignored`), count and ids. Keep a
decision table in the runbook: code, meaning, what happens to dependants, and the decision
(accept / fix source data and re-run). Typical codes: `item.unknown-entity`, `X.malformed`,
`group.owner-missing`, `member.user-missing`, `member.mirror-missing` (imported),
`member.mirror-without-set-entry`, `member.mirror-group-missing`, `expense.payer-not-member`,
`friendship.one-sided`, `friendship.roles-ambiguous-*`, `*.duplicate-*`. Fix source data BEFORE
the cutover window (writes are frozen afterwards).

## Cutover (with downtime)

Choose downtime when the user base allows it; it removes dual-write and online-sync
complexity. Maintenance mode is optional; announcing the window is not.

1. Dry run on prod days before; decide every finding.
2. Rehearse on a non-prod stage end to end (deploy, schema, roles, load, verify, smoke test).
3. Capture a baseline (latency on the old stack) if you want a before/after comparison; Lambda
   logs are retained only as long as configured, so do it before the cutover, on the same stage.
4. Announce. Deploy the new stack (DSQL cluster, env vars, IAM). From here users get errors.
   Do not touch the DynamoDB table (no backfills, no admin scripts) until the go decision.
5. Apply the schema as `admin`, create roles and IAM mappings, verify privileges.
6. Load (`--yes`), then `--verify`. Re-runs are safe.
7. Drain dead-letter queues and check that messages queued during the window still parse
   (payload shapes may have changed; see P39 in the pattern catalog).
8. Smoke test the real UI paths, including every bug found during rehearsal.
9. Go / rollback decision. Point of no return: after go, new writes exist only in DSQL.
10. Keep the DynamoDB table (RETAIN) for a while, remove it in a separate change.

Rollback before the point of no return: redeploy the previous version; the old table is
untouched. The new cluster is orphaned if it has a retain policy; delete it deliberately.

Measured in the reference migration (indicative): 593 rows loaded and verified; total
downtime about 20 minutes, dominated by index creation during the schema step (about 11
minutes). Record your own timings per step in the rehearsal.

## Pitfalls seen

- Two meanings for one environment variable (`DSQL_DB_USER` as login role and as the app role
  to grant) broke the first migrate run. Use separate names.
- A tool that auto-loads `.env` files can silently point a production run at staging values.
  Resolve per-stage values from the deployed stack (CloudFormation) or require explicit
  exports and an account check, and print the endpoint before writing.
- Interrupting the schema step (see `dsql-and-drizzle.md`, step 6 of the workflow).
- Error logs: if remote handlers swallow server errors, log checks during cutover prove
  nothing. Make sure errors are logged before relying on "no ERROR lines".
- Unrelated UI bugs surface during smoke tests (and are not caused by the data layer); keep a
  separate list so the cutover decision stays about data.
