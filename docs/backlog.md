# Backlog

Work after 4.0.0, ranked, not scheduled. This is the open copy: change it here.

The rows come from the plan that moved the PostgreSQL adapter onto
[`@marianmeres/sqlkit`](https://www.npmjs.com/package/@marianmeres/sqlkit) for 4.0.0, and
their ids continue that plan's. The plan was a local working set and is not part of the
repository, so a row that needs more than one line has its detail below the table.

**Status:** ⬜ open · ⏭️ deferred until its trigger · ✅ done

| Status | ID  | Rank | Task                                                                                                                                                                                               |
| ------ | --- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ⏭️     | T07 | 1    | The SQLite adapter onto sqlkit: `db` takes a `DatabaseSync` or a `Driver`, one code path. Needs its own plan. Trigger: sqlkit's node:sqlite backend reuses prepared statements and has savepoints. |
| ⬜     | T08 | 2    | CI's PostgreSQL image from `postgres:17` to `postgres:18` in `.github/workflows/ci.yml`, the major of the local and production databases. A change of its own.                                     |
| ⬜     | T09 | 3    | PGlite as a tested target: a dev dependency and its cases in `tests/driver.test.ts`. Ready once someone wants kv on PGlite.                                                                        |
| ⬜     | T10 | 4    | `redis` out of `dependencies`: `src/` imports it for types only. Needs a structural type for the client.                                                                                           |
| ⏭️     | T11 | 5    | The PostgreSQL statements as sqlkit `sql` fragments. Trigger: a statement that has to be composed from parts, or the two SQL adapters sharing statement code.                                      |

## T07: the SQLite adapter onto sqlkit

4.0.0 moved only the PostgreSQL adapter. The SQLite adapter still takes a raw
`node:sqlite` `DatabaseSync` and refuses a sqlkit `Driver` with a `TypeError`, because
sqlkit 0.1.1 cannot carry it without a regression. Three gaps, each measured or
reproduced on 2026-11-19:

1. **Statement cost.** kv prepares each statement once and caches it: about 0.9 µs a
   `get` and 1.3 µs a `set`. sqlkit 0.1.1 prepares a statement on every call: 5.9 µs and
   6.5 µs on its sync tier, 6.5 times and 5.0 times slower. Needs a statement cache in
   sqlkit's node:sqlite backend (sqlkit's backlog T29). Re-measure on the release the port
   would use before calling this gap closed.
2. **The savepoint join.** Inside a transaction the caller opened with `BEGIN` on the
   same handle, kv's multi-statement operations use a savepoint, so a failed one undoes
   only itself and the caller's `COMMIT` or `ROLLBACK` decides the rest (the test
   "sqlite: joins a transaction the caller opened on the same handle"). Through sqlkit
   0.1.1, `sync.transaction()` there rejects with `cannot start a transaction within a
   transaction`, and joined to a transaction opened through the driver, a failed unit is
   not undone alone. Needs savepoints in sqlkit (sqlkit's backlog T26), with this test as
   the case that proves them.
3. **`node:sqlite` at run time.** kv imports `node:sqlite` for its types only: the
   caller passes the handle, so a consumer that never uses the SQLite adapter never loads
   it. `@marianmeres/sqlkit/sqlite` imports it at run time. sqlkit has no row for this:
   the port decides whether kv's root may load it.

A fourth point decides which tier a port runs on. sqlkit's sync tier refuses a call while
an async transaction is open elsewhere (its rule S4, a `TypeError`), where the async tier
waits its turn. A port keeps kv's own guarantees only on the async tier, and pays the
statement cost of gap 1 on every call.

So the order that leaves no regression:

1. kv's PostgreSQL adapter moves onto sqlkit. Done in 4.0.0.
2. sqlkit gets its statement cache and savepoints, with kv's SQLite tests as the case
   that proves them.
3. kv's SQLite adapter ports: `db` accepts a `DatabaseSync` or a `Driver`, and there is
   one code path.

Until then a host that opened its database with sqlkit's `openSqlite()` cannot put kv on
that connection: the function answers a `Driver` and does not expose the handle.

Checked and not needed: a `SAVEPOINT` issued through `sync.exec()` inside a joined
transaction does undo a unit alone on node:sqlite. It is a way to carry gap 2 across
without sqlkit's savepoints. It would not hold on Durable Objects, where workerd refuses
`SAVEPOINT`.

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
