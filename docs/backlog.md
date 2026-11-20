# Backlog

Work after 4.0.0, ranked, not scheduled. This is the open copy: change it here.

The rows come from the plan that moved the PostgreSQL adapter onto
[`@marianmeres/sqlkit`](https://www.npmjs.com/package/@marianmeres/sqlkit) for 4.0.0, and
their ids continue that plan's. The plan was a local working set and is not part of the
repository, so a row that needs more than one line has its detail below the table.

**Status:** ⬜ open · ⏭️ deferred until its trigger · ✅ done

| Status | ID  | Rank | Task                                                                                                                                                                                                                                     |
| ------ | --- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ⬜     | T07 | 1    | The SQLite adapter onto sqlkit: `db` takes a `DatabaseSync` or a `Driver`, one code path. Needs its own plan. Its trigger is met: sqlkit has savepoints since 0.3.0 (and keeps prepared statements since 0.2.0), and kv is on 0.3 (T12). |
| ✅     | T08 | 2    | CI's PostgreSQL image from `postgres:17` to `postgres:18` in `.github/workflows/ci.yml`, the major of the local and production databases. A change of its own.                                                                           |
| ⬜     | T09 | 3    | PGlite as a tested target: a dev dependency and its cases in `tests/driver.test.ts`. Ready once someone wants kv on PGlite.                                                                                                              |
| ⬜     | T10 | 4    | `redis` out of `dependencies`: `src/` imports it for types only. Needs a structural type for the client.                                                                                                                                 |
| ⏭️     | T11 | 5    | The PostgreSQL statements as sqlkit `sql` fragments. Trigger: a statement that has to be composed from parts, or the two SQL adapters sharing statement code.                                                                            |
| ✅     | T12 | 6    | sqlkit to `^0.3.1`, in 4.1.0. From 0.3.0 a `SqlError` is recognized across copies of sqlkit, so the docs no longer ask an app to stay on the minor kv installs.                                                                          |

## T07: the SQLite adapter onto sqlkit

4.0.0 moved only the PostgreSQL adapter. The SQLite adapter still takes a raw
`node:sqlite` `DatabaseSync` and refuses a sqlkit `Driver` with a `TypeError`: sqlkit
could not carry it without a regression. Three gaps were measured or reproduced on
sqlkit 0.1.1 on 2026-11-19, and checked again on 0.2.0 on 2026-11-20 (measured on Node
26.13, a database in memory). sqlkit 0.2.0 closed the first. sqlkit 0.3.0 closed the
second but for one case, which the port carries itself (checked on 0.3.1 the same day,
on the same Node, a database in memory). The third is the port's to decide. Nothing in
sqlkit stands in the port's way any more.

1. **Statement cost. Closed by sqlkit 0.2.0.** kv prepares each statement once and
   caches it: about 0.9 µs a `get` and 1.3 µs a `set`. sqlkit 0.1.1 prepared a statement
   on every call: 5.9 µs and 6.5 µs on its sync tier, 6.5 times and 5.0 times slower.
   sqlkit 0.2.0 keeps compiled statements (its backlog T29): about 1.3 µs and 1.5 µs on
   the sync tier, 1.5 µs and 1.7 µs on the async tier. What is left is about half a
   microsecond a call. Three conditions come with it, for the port to meet:
   - A driver over a handle the host opened (`createSqliteDriver(db)`) keeps statements
     only when its `statementCache` option asks. Left at its default it costs what 0.1.1
     did: 6.2 µs and 6.7 µs. The port asks for a number when it is given a
     `DatabaseSync`, as kv keeps its statements on that handle today. A host's `Driver`
     comes as the host made it; `openSqlite()` keeps 128.
   - Every `exec()`, and every text that is not a query or a data change (a pragma, DDL,
     a `SAVEPOINT`), empties the cache. The port keeps both out of its operations. The
     driver's own `savepoint()` (since 0.3.0) is not one of them: it sends its statements
     straight to the handle and empties nothing.
   - On a Node below sqlkit's `engines` (before 24.20, any 25, before 26.6) the driver
     keeps nothing, whatever the number. kv's `engines` are sqlkit's, so no supported
     runtime pays the old cost.
2. **The savepoint join. Closed by sqlkit 0.3.0, but for a `BEGIN` on the raw handle.**
   Inside a transaction the caller opened with `BEGIN` on the same handle, kv's
   multi-statement operations use a savepoint, so a failed one undoes only itself and the
   caller's `COMMIT` or `ROLLBACK` decides the rest (the test "sqlite: joins a
   transaction the caller opened on the same handle"). Through sqlkit 0.2.0 a unit joined
   to a transaction opened through the driver was not undone alone. sqlkit 0.3.0 has
   `savepoint(fn)` on both tiers (its backlog T26). Checked on 0.3.1:
   - Joined to a transaction opened through the driver, a unit in `savepoint()` that
     fails is undone alone, and the caller's commit or rollback decides the rest. That
     holds for a call on the driver itself inside the caller's transaction, as kv would
     make it, and for `sync.savepoint()` inside an async transaction.
   - Outside a transaction `savepoint()` is a transaction, `BEGIN IMMEDIATE` as kv's is.
     So the one call is both branches of `#atomic()`.
   - It costs what a transaction does. A read and an update, the shape of kv's `incr`,
     took 2.6 µs in a `sync.savepoint()` joined to an open transaction and 2.7 µs in a
     `sync.transaction()` of its own; on the async tier, 3.6 µs and 3.3 µs.
   - A `BEGIN` sent to the handle behind the driver is not a transaction the driver
     knows. `savepoint()` and `transaction()` there still reject with `cannot start a
     transaction within a transaction`, and sqlkit documents that as the driver's rule
     (`createSqliteDriver` in its API.md).

   So the port keeps the `isTransaction` branch of `#atomic()` for the one case where it
   can tell: `db` is a `DatabaseSync`, kv holds the handle, and the caller's `BEGIN`
   shows on it. There it sends the savepoint's statements to the handle itself and its
   other statements through the driver (checked: a unit so wrapped is undone alone). What
   goes to the handle does not pass the driver, so the statements it keeps stay. The test
   above is that branch's case. Given a `Driver`, kv has no handle to look at: the
   caller's transactions are the ones opened through the driver, and a `BEGIN` behind it
   is refused as above.
3. **`node:sqlite` at run time. Open.** kv imports `node:sqlite` for its types only: the
   caller passes the handle, so a consumer that never uses the SQLite adapter never loads
   it. `@marianmeres/sqlkit/sqlite` imports it at run time. sqlkit has no row for this:
   the port decides whether kv's root may load it.

A fourth point decides which tier a port runs on. sqlkit's sync tier refuses a call while
an async transaction is open elsewhere (its rule S4, a `TypeError`), where the async tier
waits its turn. A port keeps kv's own guarantees only on the async tier, at the async
tier's cost in gap 1.

So the order that leaves no regression:

1. kv's PostgreSQL adapter moves onto sqlkit. Done in 4.0.0.
2. sqlkit gets its statement cache (done in sqlkit 0.2.0) and savepoints (done in sqlkit
   0.3.0).
3. kv moves to sqlkit 0.3 (T12). Done in 4.1.0.
4. kv's SQLite adapter ports: `db` accepts a `DatabaseSync` or a `Driver`, and there is
   one code path. kv's SQLite tests, the joined transaction among them, are the case
   that proves it.

Until then a host that opened its database with sqlkit's `openSqlite()` cannot put kv on
that connection: the function answers a `Driver` and does not expose the handle.

Superseded: a `SAVEPOINT` issued through `sync.exec()` inside a joined transaction. It
does undo a unit alone on node:sqlite, and was a way to carry gap 2 across before sqlkit
had savepoints. It would not hold on Durable Objects, where workerd refuses `SAVEPOINT`.
Since sqlkit 0.2.0 it also costs the statements kept: each `exec()` empties the cache, so
the unit compiles its statements again every time. A read and an update in
`sync.transaction()`, the shape of kv's `incr`, took 3.2 µs with statements kept and
13.4 µs inside such a savepoint, on 0.2.0; kv's `incr` takes 2.9 µs today. sqlkit's own
`savepoint()` has neither cost. On a Durable Object it nests the storage's own
transaction. On node:sqlite, in the run on 0.3.1 that gave the figures in gap 2, the
unit took 2.6 µs in a joined `sync.savepoint()` and 10.2 µs between a `SAVEPOINT` and a
`RELEASE` sent through `sync.exec()`. A second run read 0.2.0 and 0.3.1 alike, at about
2.5 µs for the transaction and 10 µs through `exec()`, so the distance from the 0.2.0
figures above is the measurement's, not the version's: compare within a run.

## T09: PGlite as a tested target

PGlite speaks the `pg` dialect, so a host can pass a sqlkit `Driver` built on it
(`createPgliteDriver` from `@marianmeres/sqlkit/pglite`) as the PostgreSQL adapter's
`db`. A probe ran the adapter's statements that way, 47 operations: each answer matched
the memory adapter's, and keyset paging walked exactly what `keys("*")` returns. It needs
`@electric-sql/pglite` as a dev dependency and its cases in `tests/driver.test.ts` before
it can be called supported. Until then `API.md` says it is expected to work and is not
tested.

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
