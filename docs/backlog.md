# Backlog

Work after 4.0.0, ranked, not scheduled. This is the open copy: change it here.

The rows come from the plan that moved the PostgreSQL adapter onto
[`@marianmeres/sqlkit`](https://www.npmjs.com/package/@marianmeres/sqlkit) for 4.0.0, and
their ids continue that plan's. The plan was a local working set and is not part of the
repository, so a row that needs more than one line has its detail below the table. The
same goes for the plan of T07, whose rows took the ids T15 to T19.

Decided on 2026-11-20: kv stays on the 4.x line. No next major is planned, so a change
that needs one waits (T10), and one that bends semver at an edge goes into a minor of
its own, with a "Changes in" section in the README that names it (T07).

**Status:** ⬜ open · ⏭️ deferred until its trigger · ✅ done

| Status | ID  | Rank | Task                                                                                                                                                                                           |
| ------ | --- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ✅     | T07 | –    | The SQLite adapter onto sqlkit: `db` takes a `DatabaseSync` or a `Driver`. A normalizing move: both SQL adapters on one driver contract. In 4.1.0.                                             |
| ✅     | T08 | –    | CI's PostgreSQL image from `postgres:17` to `postgres:18` in `.github/workflows/ci.yml`, the major of the local and production databases. A change of its own.                                 |
| ✅     | T09 | –    | PGlite as a tested target: a dev dependency, a fifth client in `tests/_tests-runner.ts` so every test runs on it, and its cases in `tests/driver.test.ts`. In 4.1.0.                           |
| ⏭️     | T10 | 1    | `redis` out of `dependencies`: `src/` imports it for types only. Needs a structural type for the client. Trigger: a major, and none is planned.                                                |
| ⏭️     | T11 | 2    | The PostgreSQL statements as sqlkit `sql` fragments. Trigger: a statement that has to be composed from parts, or the two SQL adapters sharing statement code.                                  |
| ✅     | T12 | –    | sqlkit to `^0.3.1`, in 4.1.0. From 0.3.0 a `SqlError` is recognized across copies of sqlkit, so the docs no longer ask an app to stay on the minor kv installs.                                |
| ✅     | T13 | –    | The PostgreSQL adapter's `transaction()` through the driver's `savepoint()`: inside a transaction the host opened on the same `Driver`, a failed unit is undone alone, as on SQLite. In 4.1.0. |
| ✅     | T14 | –    | `incr`/`decr` on a non-number no longer aborts the host's transaction on PostgreSQL: a statement that does not raise. In 4.1.0.                                                                |
| ⏭️     | T20 | 3    | Durable Objects as a tested target of the SQLite adapter, through sqlkit's driver for them. Trigger: someone wants kv there.                                                                   |

## T07: the SQLite adapter onto sqlkit

Done on 2026-11-20, for 4.1.0, as a normalizing move: no consumer asked for it. Both SQL
adapters now run on one driver contract, take a host's `Driver`, keep a unit
all-or-nothing the same way and reject with the same errors. It waited on sqlkit: 0.2.0
keeps compiled statements, without which a statement cost five to six and a half times
what kv's own cached statements did, and 0.3.0 has `savepoint()`, without which a unit joined to a
transaction opened through the driver was not undone alone. kv moved to 0.3 in 4.1.0
(T12).

**The tier follows what `db` is.**

- **Given a `DatabaseSync`, kv's own driver and its sync tier.** `createSqliteDriver`
  over the handle, one per handle, asked to keep 128 compiled statements (what
  `openSqlite()` keeps; left at its default it keeps none, and every call compiles).
  Nobody else has that driver, so no async transaction is ever open on it and sqlkit's
  rule S4 cannot bite. A statement runs inside the call and a unit is over when the call
  returns, as before the port; tests pin both. Rejected: the async tier there. A unit
  then has an `await` in it, and the host's own statement on its handle can land in that
  gap: checked, the host's write went into the unit and was rolled back with it, and the
  host's `BEGIN` was refused with `cannot start a transaction within a transaction`.
- **Given a `Driver`, the async tier outside and the sync tier inside.** The host may
  have a transaction open on it, and a sync call from elsewhere is then a `TypeError`
  (S4), where an async one waits its turn. So a single statement is `driver.query()`,
  and a unit is `driver.savepoint(async () => unit(driver.sync))`: the savepoint waits
  its turn and joins the host's transaction, and inside its callback the sync tier runs
  in it (S3). The unit stays synchronous, so it is written once, over a `SyncDriver`,
  for both cases. The `Driver` therefore needs a sync tier; node:sqlite's and Durable
  Objects' have one (T20).

**The handle branch stays.** A `BEGIN` the caller sent to the handle is not a
transaction the driver knows, and SQLite refuses a second one. So when `db` is a
`DatabaseSync` and the caller's transaction shows on it (`isTransaction`), `#atomic()`
sends `SAVEPOINT`, `ROLLBACK TO` and `RELEASE` to the handle and the unit's statements
through the driver. What goes to the handle does not pass the driver, so the statements
it keeps stay. Given a `Driver`, kv has no handle to look at: a `BEGIN` sent behind it
makes a unit fail, which is documented, not handled.

**`node:sqlite` at run time: a lazy import.** `@marianmeres/sqlkit/sqlite` imports
`node:sqlite` when it loads, so kv imports it with `import()`, when `initialize()` or
`destroy(true)` first opens the driver over a `DatabaseSync`; given a `Driver` it imports
nothing. The package root goes on loading no `node:sqlite`, and a test says so.
Rejected: a static import. It would load the module for every consumer, and make the
root unloadable on a runtime without it.

What it costs, in one run on 0.3.1 (µs a call, a database in memory): before the port
0.6 a `get`, 1.1 a `set`, 2.3 an `incr`; on kv's own driver 1.0, 1.2 and 3.1; on a
host's `Driver` 1.2, 1.4 and 3.5.

What changed for a caller, which the README's "Changes in 4.1.0" names:

- `db` also takes a `Driver` of the `sqlite` dialect with a sync tier and `savepoint()`.
- A statement SQLite refused rejects with sqlkit's `SqlError` (a locked database is a
  `BusyError`, `code` `"5"`, `retryable`), with node:sqlite's error as `cause` and the
  same message. It was node:sqlite's own `Error`, `code` `"ERR_SQLITE_ERROR"`, `errcode`
  `5`. 4.0.0 listed the same change on PostgreSQL as breaking; this one ships in a minor,
  since kv stays on 4.x.
- `options.db` is typed `SqliteDb`, a `DatabaseSync` or a `Driver`.
- `initialize()` and `destroy(true)` await an `import()` the first time, so their work is
  no longer done inside the call.
- A `db` that is neither is refused at construction, with a `TypeError`.

## T09: PGlite as a tested target

Done on 2026-11-20, for 4.1.0. PGlite speaks the `pg` dialect, so a host passes a sqlkit
`Driver` built on it (`createPgliteDriver` from `@marianmeres/sqlkit/pglite`) as the
PostgreSQL adapter's `db`. Nothing in `src/` changed: the adapter already ran on it.
What was missing was the proof, and "expected to work, not tested" in `API.md` is what
keeps someone from relying on it. So it was built ahead of a consumer.

- `@electric-sql/pglite` is a dev dependency (26 MB, nothing a consumer installs).
- `tests/_tests-runner.ts` builds a fifth client, `pglite`, so every test in
  `tests/kv.test.ts` runs on it. The file shares one in-memory PGlite
  (`tests/_pglite.ts`): starting one takes about half a second. The file takes about
  25 s where it took 19 s.
- `tests/driver.test.ts` has its two cases: the answers of the memory adapter, and the
  host's transaction (operations join it, a failed `transaction()` is undone alone).

## T10: `redis` out of `dependencies`

`src/adapter/redis.ts` imports `redis` for its types only, as the PostgreSQL adapter did
with `pg` before 4.0.0, so every install of kv pulls in the Redis client. Moving it to
`devDependencies` needs a structural type for the client the adapter takes, and the
client's type has five generic parameters. Removing a dependency belongs in a major.

## T11: statements as `sql` fragments

The PostgreSQL adapter's statements keep their text and their `$n` parameters on purpose:
every value is already a bound parameter, and sqlkit takes `query(text, params)` as a
first-class form, so a rewrite would change verified statements for style alone. Revisit
when a statement has to be composed from parts, or when the two SQL adapters come to
share statement code.

## T12: sqlkit to 0.3

Done on 2026-11-20: kv depends on `@marianmeres/sqlkit` `^0.3.1`. It goes out in 4.1.0,
which had moved to `^0.2.0` and was not published yet, so consumers move once, from the
`^0.1.1` of 4.0.0. A sqlkit minor is a kv minor (AGENTS.md, rule 24). What it brought kv:

- **`SqlError` recognized across copies of sqlkit.** From 0.3.0 every `SqlError` carries
  a mark that `instanceof` reads: an error one copy built is an instance of another
  copy's classes, and its `withRetry` retries it. A copy of 0.2.0 or older carries no
  mark. So an app's `instanceof SqlError` holds when its own sqlkit is 0.3.0 or newer, on
  whatever minor. The advice to stay on the minor kv installs (README, API.md) and the
  reason rule 24 gives changed with it. Checked on the published packages: 0.3.0 and
  0.3.1 installed as two copies know each other's errors, and neither knows an error from
  0.2.0.
- **Savepoints**, which T07 needs.

What it asked of kv: nothing in `src/`. `Driver` has a new required method, `savepoint`,
so a `Driver` an app built with sqlkit 0.2 no longer fits the type the PostgreSQL adapter
takes (checked: TypeScript refuses it), and an app with its own sqlkit moves it to
`^0.3.0` together with kv. The adapter calls neither `savepoint` nor sqlkit's migrations,
whose steps 0.3.0 runs differently. The Node floor did not move: 0.3's `engines` are
0.2's.

## T13: the PostgreSQL `transaction()` through `savepoint()`

Done on 2026-11-20, for 4.1.0. Until then `transaction()` called the driver's
`transaction()`, which joins a transaction the host opened on the same `Driver`. A
joined unit was not all-or-nothing: when an operation failed, the ones before it stayed
in the host's transaction and committed with it, and a statement Postgres refused
aborted the host's transaction. On SQLite the same unit was undone alone (`#atomic()`
uses a savepoint there). Reproduced on sqlkit 0.3.1 against Postgres 18.6.

sqlkit 0.3.0 has `savepoint(fn)`: a savepoint inside a transaction, a transaction
outside one. So the adapter calls that, and the two SQL adapters answer alike. The case
is "driver: transaction() inside the host's transaction is undone alone" in
`tests/driver.test.ts`; it fails on the old call with a `TransactionAbortedError`. A
`Driver` without `savepoint()` is refused at construction.

## T14: `incr` on a non-number, inside the host's transaction

Done on 2026-11-20, for 4.1.0. On PostgreSQL the adapter adds in SQL, and a stored value
that was not a number made the cast raise `22P02`, which the adapter turned into
`TypeError("KV value is not a number")`. Inside a transaction the host opened on the same
`Driver`, that failed statement had already aborted the host's transaction: a host that
caught the `TypeError` and went on got a `TransactionAbortedError` at its commit and lost
the lot. On SQLite and in memory the same host carried on.

The statement no longer raises. The `WHERE` of its `DO UPDATE` lets through an expired
row or a `jsonb_typeof(value) = 'number'`, so a live non-number updates nothing and
returns no row, and no row is the `TypeError`. The `22P02` catch stays as a backstop.
Rejected: a savepoint around every `incr`, two round trips each. Checked on PostgreSQL
18.6 and on PGlite: a new key, a number, a decimal and an expired key answer as before;
a string, an object, an array, a boolean, a `null` and a numeric string are left as they
are. The case is "driver: incr on a non-number leaves the host's transaction usable" in
`tests/driver.test.ts`, on a `pg.Pool` driver and on PGlite.

## T20: Durable Objects as a tested target

sqlkit has a driver for a Durable Object's SQLite storage, of the `sqlite` dialect and
with a sync tier, which is what the SQLite adapter takes since 4.1.0 (T07). Whether kv's
statements run there (`GLOB`, `json_each`, the upsert, the partial index) has not been
tried, and a test needs workerd. `API.md` says it is expected to work and is not tested.
