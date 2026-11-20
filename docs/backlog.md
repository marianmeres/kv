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

| Status | ID  | Rank | Task                                                                                                                                                                                                                              |
| ------ | --- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ⬜     | T07 | 1    | The SQLite adapter onto sqlkit: `db` takes a `DatabaseSync` or a `Driver`. A normalizing move: both SQL adapters on one driver contract. On the 4.x line, as a minor of its own (4.2.0). Planned; its plan's rows are T15 to T19. |
| ✅     | T08 | –    | CI's PostgreSQL image from `postgres:17` to `postgres:18` in `.github/workflows/ci.yml`, the major of the local and production databases. A change of its own.                                                                    |
| ✅     | T09 | –    | PGlite as a tested target: a dev dependency, a fifth client in `tests/_tests-runner.ts` so every test runs on it, and its cases in `tests/driver.test.ts`. In 4.1.0.                                                              |
| ⏭️     | T10 | 3    | `redis` out of `dependencies`: `src/` imports it for types only. Needs a structural type for the client. Trigger: a major, and none is planned.                                                                                   |
| ⏭️     | T11 | 4    | The PostgreSQL statements as sqlkit `sql` fragments. Trigger: a statement that has to be composed from parts, or the two SQL adapters sharing statement code.                                                                     |
| ✅     | T12 | –    | sqlkit to `^0.3.1`, in 4.1.0. From 0.3.0 a `SqlError` is recognized across copies of sqlkit, so the docs no longer ask an app to stay on the minor kv installs.                                                                   |
| ✅     | T13 | –    | The PostgreSQL adapter's `transaction()` through the driver's `savepoint()`: inside a transaction the host opened on the same `Driver`, a failed unit is undone alone, as on SQLite. In 4.1.0.                                    |
| ⬜     | T14 | 2    | `incr`/`decr` on a non-number must not abort the host's transaction on PostgreSQL: a statement that does not raise. Rides with T07's plan.                                                                                        |
| ⏭️     | T20 | 5    | Durable Objects as a tested target of the SQLite adapter, through sqlkit's driver for them. Trigger: T07 has landed, and someone wants kv there.                                                                                  |

## T07: the SQLite adapter onto sqlkit

4.0.0 moved only the PostgreSQL adapter. The SQLite adapter still takes a raw
`node:sqlite` `DatabaseSync` and refuses a sqlkit `Driver` with a `TypeError`: sqlkit
could not carry it without a regression. Three gaps were measured or reproduced on
sqlkit 0.1.1 on 2026-11-19, and checked again on 0.2.0 on 2026-11-20 (measured on Node
26.13, a database in memory). sqlkit 0.2.0 closed the first. sqlkit 0.3.0 closed the
second but for one case, which the port carries itself (checked on 0.3.1 the same day,
on the same Node, a database in memory). The third is the port's to decide, and is
answered below. Nothing in sqlkit stands in the port's way any more.

Decided on 2026-11-20: the port goes ahead, as a normalizing move. No consumer asks for
it; the point is that both SQL adapters run on one driver contract, take a host's
`Driver`, keep a unit all-or-nothing the same way and reject with the same errors. It
ships on the 4.x line as a minor of its own, 4.2.0, so that what changes for a caller
has one section of notes ("What changes for a caller" below).

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
3. **`node:sqlite` at run time. Answered: a lazy import.** kv imports `node:sqlite` for
   its types only: the caller passes the handle, so a consumer that never uses the SQLite
   adapter never loads it. `@marianmeres/sqlkit/sqlite` imports it at run time. So the
   port imports that entry with `import()`, in `initialize()`, and only when `db` is a
   `DatabaseSync`: by then the host has loaded `node:sqlite` itself. Given a `Driver`,
   kv imports nothing. kv's root goes on loading no `node:sqlite` (checked on the root as
   it is: it loads `node:async_hooks`, for the PostgreSQL driver, and nothing of
   SQLite). A static import would be simpler and prints no warning on Node 24.22 or
   26.13, but it would load the module for every consumer, and make the root unloadable
   on a runtime without it.

A fourth point decides which tier the port runs on, and the answer depends on what `db`
is. An earlier reading here put the whole port on the async tier. It was wrong for a
handle the host also uses directly (checked on 0.3.1):

- **Given a `DatabaseSync`, the sync tier.** kv builds the driver and nobody else has
  it, so no async transaction is ever open on it and sqlkit's rule S4 cannot bite. A
  statement runs inside the call, and a unit is over when the call returns, as today.
  On the async tier a unit has an `await` in it, and the host's own statement on its
  handle can land in that gap: in the probe the host's write went into the unit and was
  rolled back with it, and the host's `BEGIN` was refused with `cannot start a
  transaction within a transaction`.
- **Given a `Driver`, the async tier outside and the sync tier inside.** The host may
  have a transaction open on it. A sync call from elsewhere is then a `TypeError` (S4),
  where an async one waits its turn. So a single statement is `driver.query()`, and a
  unit is `driver.savepoint(async () => unit(driver.sync))`: the savepoint waits its
  turn and joins the host's transaction, and inside its callback the sync tier runs in
  it (rule S3). The unit itself stays synchronous, so it is written once, over a
  `SyncDriver`, for both cases. The `Driver` therefore needs a sync tier; node:sqlite's
  and Durable Objects' have one.

What it costs, in one run on 0.3.1 (µs a call, a database in memory): today 0.6 a `get`,
1.1 a `set`, 2.3 an `incr`; on the sync tier with statements kept 1.0, 1.2 and 3.1; on a
host's `Driver` 1.2, 1.4 and 3.5.

What changes for a caller who passes a `DatabaseSync`, which the notes of 4.2.0 name:

- A statement SQLite refused rejects with sqlkit's `SqlError` (a locked database is a
  `BusyError`, `code` `"5"`, `retryable`), with node:sqlite's error as `cause` and the
  same message. Today it is node:sqlite's own `Error`, `code` `"ERR_SQLITE_ERROR"`,
  `errcode` `5`. 4.0.0 listed the same change on PostgreSQL as breaking.
- `options.db` is typed as what the option takes, a `DatabaseSync` or a `Driver`.
- `initialize()` and `destroy()` await an `import()` the first time, so their work is no
  longer done inside the call.

So the order that leaves no regression:

1. kv's PostgreSQL adapter moves onto sqlkit. Done in 4.0.0.
2. sqlkit gets its statement cache (done in sqlkit 0.2.0) and savepoints (done in sqlkit
   0.3.0).
3. kv moves to sqlkit 0.3 (T12). Done in 4.1.0.
4. kv's SQLite adapter ports: `db` accepts a `DatabaseSync` or a `Driver`, and every
   statement goes through a driver. kv's SQLite tests, the joined transaction among
   them, are the case that proves it. Planned for 4.2.0.

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

On PostgreSQL the adapter adds in SQL, and a stored value that is not a number makes the
cast raise `22P02`, which the adapter turns into `TypeError("KV value is not a number")`.
Inside a transaction the host opened on the same `Driver`, that failed statement has
already aborted the host's transaction: a host that catches the `TypeError` and goes on
gets a `TransactionAbortedError` at its commit and loses the lot. On SQLite and in
memory the same host carries on.

A savepoint around every `incr` would cost two round trips each. The statement can
simply not raise: a `WHERE` on its `DO UPDATE` that lets through an expired row or a
`jsonb_typeof(value) = 'number'`, so a live non-number updates nothing and returns no
row, and no row is the `TypeError`. Checked on PostgreSQL 18.6 and on PGlite: the
answers are today's for a new key, a number, a decimal and an expired key; a string, an
object, an array, a boolean, a `null` and a numeric string are left as they are; and
the host's transaction goes on and commits.

## T20: Durable Objects as a tested target

sqlkit has a driver for a Durable Object's SQLite storage, of the `sqlite` dialect and
with a sync tier, which is what the SQLite adapter will take after T07. Whether kv's
statements run there (`GLOB`, `json_each`, the upsert, the partial index) has not been
tried, and a test needs workerd. After T07 `API.md` says it is expected to work and is
not tested.
