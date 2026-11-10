# Worked example: expense-ease (single table to 9 relational tables)

Source: the `dsql-experiment` journal and design. Use it to calibrate decisions, not to copy
the schema.

## Before

One DynamoDB table `Expenses` (PK `id`, SK `entity`, GSI `reverseGsi` on `entity`,`id`),
pay-per-request. 261 production items: user 19, group 10, expense 109, debt 10, friendship 48
(mirrored), `member|user|` 35, `member|group|` 30. Data layer: 8 repository modules, 2,592 lines.

## Shape mapping

| DynamoDB | Pattern | Relational |
|---|---|---|
| `user` items | P01 | `users`; 8 notification settings as plain boolean columns, not jsonb; CHECKs: virtual implies no email, real implies email; unique index on nullable email |
| `friendship\|<id>` items, two per friendship | P04 | `friendships` one row per pair, PK `(requester_id, acceptor_id)`, `kind`, `confirmed_at`, unique `(least, greatest)` expression index |
| group item with `members`, `notifyUserIds`, `reviewConfirmed` sets, `expensesCount`, `debts` map, `breakdown` string | P05 P07 P08 | `groups` (id, name, owner_id, status, currency) only |
| `member\|user\|` + `member\|group\|` mirror items | P04 P05 | `group_members (group_id, user_id, notify, review_confirmed_at)` |
| expense item with `borrowers` list, id `groupId#rand` | P02 P06 | `expenses` + `expense_borrowers`, composite FKs to `group_members` for payer and borrowers |
| debt items, id `group#debtor#creditor`, `settled` bool | P02 | `debts` composite PK, `settled_at` |
| `groupArchive` items with TTL, id `user#millis#group` | P02 P29 | `group_archives (user_id, group_id)`, `created_at`, `expires_at`; payload stays in S3 |
| `pendingNotification` items with TTL | P29 | `pending_notifications` with `kind` as CHECKed column and `expires_at` |
| TTL | P29 | `expires_at > now()` on reads + daily cleanup in an existing scheduled Lambda (<= 1,000 rows per transaction, 50 loops cap) |

No jsonb column in the final schema.

## Code that moved into the engine

| By hand (DynamoDB) | Engine (DSQL) |
|---|---|
| Two mirrored items written in one transaction | One row; PK + unique expression index |
| 3 counters updated inside many transactions | `count(*)` / `EXISTS` |
| One `ConditionCheck` per borrower (+100 item cap) | Composite FK to `group_members` (also checks the payer, which was never checked) |
| `attribute_not_exists` | PK / unique violation 23505 |
| Sets and a map of sets with `ADD`/`DELETE` | Join-table rows |
| `batchGet` + `BatchWrite` chunk loops | Joins, `WHERE`, `DELETE ... RETURNING` |
| One request per row loops | One set-based statement (`LEFT JOIN`, `INSERT ... SELECT`) |
| Parsing `CancellationReasons` | SQLSTATE codes |
| Valibot `parseOne` on every read | Column types and constraints |

Honest list of what did NOT move: the debt-simplification algorithm, `localeCompare` name
sorting (DSQL has only `C` collation), email sending, and the new work DSQL adds (OCC retries,
cleanup job instead of TTL, token/connection handling, slow async DDL).

## Round trips (statements) before and after

| Path | Before | After |
|---|---|---|
| list groups | 3 | 1 |
| group members | ids fetch + getMany | 1 join |
| remove group | one transaction per member + delete | 1 transaction |
| friend list | list + getMany | 1 `UNION ALL` join |
| transient friendships for a group | 1 read + n(n-1)/2 transactions | 1 `INSERT ... SELECT ... RETURNING` + 1 read |

## Deliberate behavior changes

Repeated friend request no longer overwrites (rejects); payer must be a group member;
debt re-delivery no longer resets settled debts; borrower cap removed; owned-group count
excludes `archiving`; task payloads carry a group id instead of a member list.

## Bugs the migration surfaced

- S3 snapshot reader broke when a counter left the model (P39): fixed with an optional field
  and a cross-boundary test.
- Archive snapshots had held `breakdown` as an object for a year and as a string before and
  after (P08): reader accepts both.
- Shared query function re-exported from two modules got the wrong remote-function id in a
  framework (SvelteKit); unrelated to the data layer but found during the smoke test. Smoke
  test every screen.

## Size measures (indicative; lines are a weak proxy)

Repository modules 2,534 -> 1,774 lines (-30%); data layer incl. schema and client 2,592 ->
2,280 (-12%). References to hand-written chunk loops 16 -> 0, `TransactWriteCommand` calls 13 -> 6
`transact(` calls, stored-counter mentions 25 -> 0. Count the migration script, runbook and test
harness as new code in a fair total.
