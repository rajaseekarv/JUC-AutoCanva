# Canva OAuth PostgreSQL gates: controlled execution runbook

**Status: executed in full once (Stage 2.5, 2026-10-28, PostgreSQL 18.6): all 27 gates passed** (run record in §12). **Batches 3 and 6 were rerun in Stage 2.9** (2026-10-28, a new isolated cluster, PostgreSQL 18.6) after the Stage 2.8 and 2.8.1 changes, with Gate C extended: all 20 selected gates passed (§13). Every rerun needs its own approval and a fresh preflight.

This runbook covers the 27 gates of [the persistence proposal](canva-oauth-persistence-proposal.md) (§10). The gate inventory, scenarios, and invariants are in [canva.md](canva.md#postgresql-gates-how-to-run-later); this document is the execution procedure.

## 1. What exists and what does not

Verified by reading the repository (Stage 2.4):

| Item | Fact |
| --- | --- |
| Gate code | `apps/api/src/pg/canva-oauth.pg.spec.ts`, `canva-oauth-gates.pg.spec.ts`, `canva-browser.pg.spec.ts`, with the harness in `canva-gate-harness.ts`, `canva-gate-actors.ts`, `commit-drop-proxy.ts`, `prisma-migrate-runner.ts`, `canva-browser-harness.ts` |
| Isolated test cluster | No setup script exists in the repository. Stage 2.5 created one by hand with the PostgreSQL 18 binaries (§12); it is not reused automatically |
| `setup-local-postgres.ps1` | **Not for gates. Never use it here.** It targets the developer database (`localhost:5432`, `DATABASE_URL` from `.env`), creates or alters the `adflow` role and database, runs `prisma migrate deploy` against them (which would apply the unapproved Canva migrations to the developer database), and deletes itself on success. Earlier versions of `canva.md` pointed to it for the gates; that was wrong and is corrected |
| `docker-compose.yml` | The developer database (`postgres:16-alpine`, port 5432, database `adflow`). **Never a gate target**; the guards refuse it (port, name, marker) |
| Other `*.pg.spec.ts` | `concurrency.pg.spec.ts` and `field-audit.pg.spec.ts` write fixtures into the test database's `public` schema and do not remove them. They are not part of this plan; every command below names its files, so they never run with it |
| Browser driver | `playwright` 1.56.1 (dev dependency of `@adflow/api`, approved and installed in Stage 2.5), with bundled Chromium 141.0.7390.37 in the git-ignored `.playwright-browsers/` |

## 2. PostgreSQL version

- **Use PostgreSQL 18.x.** The only recorded run of an isolated suite in this repository (`canva.md`, `concurrency.pg.spec.ts`) was on PostgreSQL 18; using the same major version keeps results comparable. The developer database runs 16; that is not a reason to test on 16.
- **Not verified here:** that Prisma 6.19.3 (the pinned version) officially supports PostgreSQL 18. Check Prisma's supported-databases page before the run; if 18 is not listed, run on the newest listed major and record it.
- Record `SELECT version()` in the result table (§11).

## 3. Isolated cluster requirements

The guards (`assertIsolatedUrl`, `assertIsolatedServer`) refuse anything that does not meet all of these, before any write:

| Requirement | Why | Checked by |
| --- | --- | --- |
| A dedicated cluster in its own, newly created data directory, never a copy of the developer data | Disposable: deleting the directory is the cleanup of last resort | Data directory equals `ADFLOW_PG_TEST_DATA_DIR` |
| Listens on port **55432** | Never the default 5432 of the developer database | URL and `inet_server_port()` |
| `listen_addresses = '127.0.0.1'` (or `localhost`) only | A shared or production server listens beyond loopback | `current_setting('listen_addresses')` (Stage 2.4) |
| Connected over TCP to **127.0.0.1** | A Unix socket or another host is refused | URL host, `inet_server_addr()`; URLs carrying `host`, `hostaddr`, `port`, or `socket` parameters are refused (Stage 2.4) |
| A database whose name ends in **`_test`** (for example `adflow_gates_test`) | Never `adflow` | URL and `current_database()` |
| The database comment is exactly `adflow-isolated-test:<marker>`, with a marker chosen for this cluster | Proves the operator stamped this database as disposable | `shobj_description(…, 'pg_database')` against `ADFLOW_PG_TEST_MARKER` |
| The gate role can `CONNECT`, `CREATE` schemas in that database, and read `data_directory` (superuser of the throwaway cluster, or a role granted `pg_read_all_settings`) | Gates create and drop their own schemas; the identity check reads `data_directory` | The run fails closed otherwise |
| The cluster holds nothing else of value, and no other process uses it during the run | Gates observe locks through `pg_stat_activity` and create load | Preflight (§5) |

Illustrative operator commands (PostgreSQL 18 client tools on `PATH`; placeholders in angle brackets; **not executed or verified here**):

```powershell
initdb -D <new-empty-directory> -U <gate-superuser> -A scram-sha-256 -W
pg_ctl -D <new-empty-directory> -o "-p 55432 -c listen_addresses=127.0.0.1" -l <log-file> start
createdb -h 127.0.0.1 -p 55432 -U <gate-superuser> adflow_gates_test
psql -h 127.0.0.1 -p 55432 -U <gate-superuser> -d adflow_gates_test -c "COMMENT ON DATABASE adflow_gates_test IS 'adflow-isolated-test:<marker>'"
```

## 4. Environment variables

Set them in the PowerShell session that runs the gates, never in `.env` or any committed file. The test URL contains a password, so read it without echo:

```powershell
$secure = Read-Host 'Isolated gate database URL' -AsSecureString
$env:ADFLOW_PG_TEST_URL = [Net.NetworkCredential]::new('', $secure).Password
Remove-Variable secure
```

| Variable | Value | Secret | Needed for |
| --- | --- | --- | --- |
| `ADFLOW_PG_TEST_URL` | `postgresql://<role>:<password>@127.0.0.1:55432/<name>_test` with no query parameters | **Yes** (password) | Every batch |
| `ADFLOW_PG_TEST_MARKER` | The marker in the database comment | No | Every batch |
| `ADFLOW_PG_TEST_DATA_DIR` | The cluster's data directory, as the server reports it | No | Every batch |
| `ADFLOW_PG_GATES` | `run` | No | Every batch (without it the `pg` project does not exist) |
| `ADFLOW_PG_MIGRATE_RUNNER` | `run` | No | Batch 7 only; unset it afterwards |
| `ADFLOW_GATE_SEED` | An integer | No | Optional, batch 5 replay |
| `ADFLOW_GATE_KEEP` | `1` | No | Optional: keep a failed gate's schema for inspection |

Leave unset: `NODE_ENV` (never `production`), every `CANVA_*` variable (the gates build their own configuration with fixed test placeholders), and `DATABASE_URL` (the test setup replaces it with a closed port anyway). Never print the environment (`Get-ChildItem Env:`, `set`) while the URL is set.

## 5. Preflight checklist

Every item must pass, in order. Any failure is a stop.

1. **Repository state recorded.** `git status --porcelain=v1` and a file-hash snapshot (as in the Stage 2.x reports), so the post-run check can prove nothing changed.
2. **Offline checks green** (no database):
   ```powershell
   pnpm --filter @adflow/api exec vitest run --project unit src/pg
   pnpm --filter @adflow/api exec tsc --noEmit -p tsconfig.test.json --incremental false
   ```
   The `src/pg` unit tests include the guard, proxy, migrate-runner, and browser-harness tests.
3. **Target is not the developer database.** The URL's host is `127.0.0.1`, its port is `55432`, its database ends in `_test`, and it has no query parameters. The developer database (`5432`, `adflow`) is not running, or at least is not reachable on 55432.
4. **Target identity, read-only**, with `psql` against `ADFLOW_PG_TEST_URL` (no writes):
   ```sql
   SELECT version();
   SELECT current_database(), inet_server_addr(), inet_server_port(),
          current_setting('listen_addresses'), current_setting('data_directory'),
          shobj_description(oid, 'pg_database')
   FROM pg_database WHERE datname = current_database();
   SELECT datname FROM pg_database WHERE NOT datistemplate;          -- only postgres and the *_test database
   SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\_%' AND nspname <> 'information_schema';
   SELECT count(*) FROM pg_stat_activity WHERE datname = current_database();  -- only this session
   ```
   Expected: version 18.x; `127.0.0.1`, `55432`, loopback-only listen, the data directory in `ADFLOW_PG_TEST_DATA_DIR`, and the comment `adflow-isolated-test:<marker>`; no application databases; schemas `public` and at most leftover `g…_…` gate schemas; one session.
5. **Disposable confirmed.** You would delete this cluster's data directory without loss.
6. **Gate G needs its driver**: `playwright` 1.56.1 and its bundled Chromium, installed in Stage 2.5 (§9). Confirm `.playwright-browsers/` exists and set `PLAYWRIGHT_BROWSERS_PATH` to it for batch 8; without the driver the gate registers a todo instead of running. (Before Stage 2.5 this item read "Gate G stays blocked".)
7. **Tooling**: `node --version` is 24.x (the repository pins 24.21.0), and `pnpm --version` is 11.19.0, or use the `npx --no-install vitest` form (§7).

## 6. What each batch can change

| Effect | Gates |
| --- | --- |
| Create a `g<gate>_<epoch>_<hex>` schema, apply the migrations' SQL to it, write rows, then drop it | All |
| Drop leftover gate schemas older than one hour (only names matching `g…_<epoch>_<hex>`) | Any gate, at schema creation |
| Interrupt connections (the server logs aborted backends) | A, B, O (commit-dropping proxy on a random loopback port) |
| Hold row locks on purpose (3 seconds, then more than 5 seconds) | N |
| Randomized concurrent load | E, P |
| Write migration history (`_prisma_migrations`) and take Prisma's database-wide advisory migration lock | F (rest) only, in its own `gf_*` schema |
| Start HTTP listeners on loopback (API, fake authorize page, web stand-in) and headless browsers | G |

**Gate F's reach** (reviewed in `prisma-migrate-runner.ts`):
- It can only run `migrate deploy` or `migrate resolve --rolled-back`.
- Its target is a `gf_<epoch>_<hex>` schema created by the gate itself; `public`, other gates' schemas, and the reference schema `gfref_*` are refused.
- `--schema` points at a copy of `schema.prisma` and `migrations/` in a fresh `adflow-gate-f-*` temp directory, so the repository's migration files are read, copied, and never modified.
- The datasource reads only `DATABASE_URL` (no `directUrl` or shadow database), and no migration names a schema explicitly, so `?schema=gf_…` confines every statement and `_prisma_migrations` to that schema.
- The child environment contains only `PATH`, the Windows system root, the computed `DATABASE_URL`, and Prisma's quiet flags; it runs with no shell, after the server identity check.

## 7. Execution order

Run from the repository root, one batch at a time, in this order. Each command names its spec file, so the older `public`-schema suites never run. Stop at the first failure (§8).

The commands assume `pnpm` 11.19.0 (the repository's `packageManager`) on `PATH`. It was not on `PATH` in the Stage 2.4 session; do not install or enable it just for this run without approval. The equivalent without `pnpm`, from `apps/api`, uses the repository-local Vitest binary: `npx --no-install vitest run --project pg <spec file> -t "<pattern>"`. Without `ADFLOW_PG_TEST_URL` and `ADFLOW_PG_GATES=run`, either form stops at startup with `No projects matched the filter "pg"` (checked in Stage 2.4), before any test file is loaded.

Every `-t` pattern below was checked offline against the gate names: each gate test in `canva-oauth-gates.pg.spec.ts` is selected by exactly one batch. Parentheses are written `[(]` and `[)]`, never with a backslash: pnpm 11 forwards a backslash doubled, so `\(` reached Vitest as `\\(` and silently selected nothing for five gates in the first Stage 2.5 run.

| Batch | Purpose | Gates | Risk |
| --- | --- | --- | --- |
| 1 | Smoke: guards, schema creation, migration SQL, cleanup | 9 | Lowest: one actor, raw SQL |
| 2 | Database-only interleavings | 1, 9, H(a), H(b), J, M(c), R(b), 7 (part) | Lock waits between actors |
| 3 | Services with the fake Canva, no interruption | 2, 3, 4, 5, 6, 7 (rest), 8, C, D, I, J (variants), K, L, M(a, b), Q, R(a, c), F (part) | Several actors; fake Canva only |
| 4 | Deliberate long lock waits | N | Holds locks for 3 s and over 5 s |
| 5 | Randomized concurrency | P, then E | Load; record the printed seed |
| 6 | Connection interruption | A, B, O | Dropped connections through the proxy |
| 7 | Migration history and recovery | F (rest) | Prisma CLI against `gf_*` only; extra opt-in |
| 8 | Browser binding | G | Needs the Playwright driver (§9; installed in Stage 2.5, where G passed) |

```powershell
$env:ADFLOW_PG_GATES = 'run'
# ADFLOW_PG_TEST_URL (read without echo, §4), ADFLOW_PG_TEST_MARKER, and ADFLOW_PG_TEST_DATA_DIR are set.

# Batch 1
pnpm --filter @adflow/api test:pg src/pg/canva-oauth.pg.spec.ts -t "Gate 9:"
# Batch 2
pnpm --filter @adflow/api test:pg src/pg/canva-oauth.pg.spec.ts
# Batch 3
pnpm --filter @adflow/api test:pg src/pg/canva-oauth-gates.pg.spec.ts -t "Gate (2|3|4|5|6|8|C|D|I|K|L|Q):|Gate 7 [(]rest[)]|Gate J [(]variants[)]|Gate M[(]a, b[)]|Gate R[(]a, c[)]|Gate F [(]part[)]"
# Batch 4
pnpm --filter @adflow/api test:pg src/pg/canva-oauth-gates.pg.spec.ts -t "Gate N:"
# Batch 5 (optionally set $env:ADFLOW_GATE_SEED to replay)
pnpm --filter @adflow/api test:pg src/pg/canva-oauth-gates.pg.spec.ts -t "Gate P:"
pnpm --filter @adflow/api test:pg src/pg/canva-oauth-gates.pg.spec.ts -t "Gate E:"
# Batch 6
pnpm --filter @adflow/api test:pg src/pg/canva-oauth-gates.pg.spec.ts -t "Gate (A|B|O):"
# Batch 7: the only batch that runs the Prisma CLI
$env:ADFLOW_PG_MIGRATE_RUNNER = 'run'
pnpm --filter @adflow/api test:pg src/pg/canva-oauth-gates.pg.spec.ts -t "Gate F [(]rest[)]"
Remove-Item Env:ADFLOW_PG_MIGRATE_RUNNER
# Batch 8: Gate G (with $env:PLAYWRIGHT_BROWSERS_PATH set to the repository's .playwright-browsers; a todo without the driver)
pnpm --filter @adflow/api test:pg src/pg/canva-browser.pg.spec.ts
```

Before each batch, check the planned selection with `--reporter verbose`: Vitest lists every test, and only the batch's gates may run (the rest are skipped).

## 8. Expected results and stop conditions

**Expected:** every selected gate passes, the invariant checker reports no violation, and each gate's schema is gone afterwards. The output may print notes (`INV-2` stale holds, which are safe) and, for E and P, `Gate randomized mix seed: <n>`. Gate F (rest) is reported as skipped in every batch except 7. Gate G runs in batch 8 when its driver is installed (as since Stage 2.5) and is reported as a todo only without it.

**Stop immediately, record, and do not change code or configuration to make a gate pass, when:**

| Signal | Meaning | Action |
| --- | --- | --- |
| `Refusing to run: …` | A guard rejected the target or the environment | Stop. Fix the setup, never the guard. Recheck §3 to §5 |
| `Proxy assumption not met: …` | Prisma frames transactions differently than gates A, B, and O assume, a drop did not fire, or the client did not reconnect | Stop batch 6. Record the message: it is a finding about Prisma, not a flaky test |
| `Gate F finding: …` | Prisma applied part of a failed migration | Stop. Record it: recovery would need manual cleanup (proposal §9, F8) |
| A failed invariant (`INV-1` to `INV-7`) | A protocol defect, or a gate bug | Stop. Keep the schema (`ADFLOW_GATE_KEEP=1` on a rerun) for inspection |
| An unhandled deadlock (`40P01`) or a timeout | A lock-order defect, or an environment problem | Stop. Record the seed for E and P |
| Any session, schema, or database outside the isolated cluster appears to be involved | Unknown; potentially unsafe | Stop everything; unset the variables; inspect before anything else |
| Any network request beyond loopback | Unexpected: the global `fetch` is stubbed to throw and the fake Canva refuses other hosts | Stop |

The first run of each gate is also its first debugging session: a failure from the gate's own code (as opposed to the protocol) is expected occasionally and must be fixed in review, not by weakening an assertion.

## 9. Gate G dependency (approved and installed in Stage 2.5)

| Item | Proposal |
| --- | --- |
| Package | `playwright`, exactly `1.56.1`, as a dev dependency of `@adflow/api` |
| Verified (npm registry) | Version `1.56.1` exists; `engines.node` is `>=18` (the repository pins Node 24.21.0); license Apache-2.0; its only dependency is `playwright-core@1.56.1`. Published in October 2025 (third-party release trackers give 2025-10-17; not confirmed against the GitHub release page) |
| Why | Only a real browser can prove `SameSite=Lax`, host-only, `HttpOnly` binding-cookie behavior across a top-level form POST and redirects. Playwright launches a persistent context on a given profile directory, which is how the gate keeps profiles isolated |
| Browser | Playwright's bundled Chromium only (1.56.1 bundles Chromium 141). The harness calls `chromium.launchPersistentContext` without a `channel`, so it never launches the installed Chrome or Edge |
| Profiles | `TempBrowserProfile` creates a fresh `adflow-gate-g-profile-*` directory directly in the OS temp directory and refuses any other path, including the user's Chrome, Edge, and Firefox profile locations and the home directory. `loadBrowserDriver` re-checks the path before launching, and removal is refused for anything that is not a gate profile |
| Compatibility concerns | Newer Playwright versions exist; 1.56.1 is pinned as requested and should be revisited at approval. Chromium 141 includes Local Network Access changes; every gate G host is `127.0.0.1` (or `localhost` in the wrong-host scenario), so no public-to-local request occurs, but this is unverified until the gate runs. Browser binaries are about 150 MB and are a separate download. If pnpm reports a build script for the package, do not allow it: browsers are installed explicitly below |
| Repository changes on approval | `apps/api/package.json` and `pnpm-lock.yaml` (from the install), and a `.gitignore` entry for the browser cache. Nothing else |

Commands as run in Stage 2.5 (pnpm through corepack, and the repository-local store that `node_modules` was installed from; without `--store-dir`, pnpm 11 refuses with `ERR_PNPM_UNEXPECTED_STORE`):

```powershell
corepack pnpm --filter @adflow/api add --save-dev --save-exact --store-dir "$PWD\.pnpm-store" playwright@1.56.1
$env:PLAYWRIGHT_BROWSERS_PATH = "$PWD\.playwright-browsers"   # repository-local; add .playwright-browsers/ to .gitignore
corepack pnpm --filter @adflow/api exec playwright install chromium
```

Set the same `PLAYWRIGHT_BROWSERS_PATH` when running batch 8. With the driver installed, gate G runs instead of registering a todo.

## 10. Cleanup and post-run verification

1. **Leftover schemas**, read-only: `SELECT nspname FROM pg_namespace WHERE nspname ~ '^g[a-z0-9]+_[0-9]+_[0-9a-f]+$';`. Expect none, unless `ADFLOW_GATE_KEEP=1` kept a failed gate's schema. Inspect those, then drop them by name (`DROP SCHEMA "<name>" CASCADE`) on the isolated cluster only.
2. **Temp directories**: none named `adflow-gate-f-*` or `adflow-gate-g-profile-*` should remain in the OS temp directory (both are removed in `finally`); delete any by exact name.
3. **Environment**: `Remove-Item Env:ADFLOW_PG_TEST_URL, Env:ADFLOW_PG_TEST_MARKER, Env:ADFLOW_PG_TEST_DATA_DIR, Env:ADFLOW_PG_GATES` (and `ADFLOW_PG_MIGRATE_RUNNER`, `ADFLOW_GATE_SEED`, `ADFLOW_GATE_KEEP`, `PLAYWRIGHT_BROWSERS_PATH` if set).
4. **Cluster**: stop it (`pg_ctl -D <directory> stop`), or delete the data directory if it is no longer needed.
5. **Repository**: `git status` and the file-hash comparison must show no change from the preflight snapshot.
6. **Developer database**: the gates never connect to it (the guards refuse its port, name, and marker). Do not connect to it to "check"; nothing to verify there.
7. **Record** each batch in §11, with the PostgreSQL version, the date, any seed, and the exact text of any failure (no URL or password).

## 11. Results

| Gate | Batch | File | Status | Date | PostgreSQL | Seed | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 9 (smoke) | 1 | `canva-oauth.pg.spec.ts` | PASS | 2026-10-28 | 18.6 |  |  |
| 1 | 2 | `canva-oauth.pg.spec.ts` | PASS | 2026-10-28 | 18.6 |  |  |
| 9 | 2 | `canva-oauth.pg.spec.ts` | PASS | 2026-10-28 | 18.6 |  | Rerun after its final check was corrected (§12, item 3) |
| H(a) | 2 | `canva-oauth.pg.spec.ts` | PASS | 2026-10-28 | 18.6 |  |  |
| H(b) | 2 | `canva-oauth.pg.spec.ts` | PASS | 2026-10-28 | 18.6 |  |  |
| J | 2 | `canva-oauth.pg.spec.ts` | PASS | 2026-10-28 | 18.6 |  |  |
| M(c) | 2 | `canva-oauth.pg.spec.ts` | PASS | 2026-10-28 | 18.6 |  |  |
| R(b) | 2 | `canva-oauth.pg.spec.ts` | PASS | 2026-10-28 | 18.6 |  |  |
| 7 (part) | 2 | `canva-oauth.pg.spec.ts` | PASS | 2026-10-28 | 18.6 |  |  |
| 2 | 3 | `canva-oauth-gates.pg.spec.ts` | PASS | 2026-10-28 | 18.6 |  |  |
| 3 | 3 | `canva-oauth-gates.pg.spec.ts` | PASS | 2026-10-28 | 18.6 |  |  |
| 4 | 3 | `canva-oauth-gates.pg.spec.ts` | PASS | 2026-10-28 | 18.6 |  | 1.5 s after the harness fix (17 s before; §12, item 2) |
| 5 | 3 | `canva-oauth-gates.pg.spec.ts` | PASS | 2026-10-28 | 18.6 |  |  |
| 6 | 3 | `canva-oauth-gates.pg.spec.ts` | PASS | 2026-10-28 | 18.6 |  |  |
| 7 (rest) | 3 | `canva-oauth-gates.pg.spec.ts` | PASS | 2026-10-28 | 18.6 |  | Skipped by the first batch 3 filter (§12, item 1) |
| 8 | 3 | `canva-oauth-gates.pg.spec.ts` | PASS | 2026-10-28 | 18.6 |  |  |
| C | 3 | `canva-oauth-gates.pg.spec.ts` | PASS | 2026-10-28 | 18.6 |  | Failed first: gate defect, fixed (§12, item 2) |
| D | 3 | `canva-oauth-gates.pg.spec.ts` | PASS | 2026-10-28 | 18.6 |  |  |
| I | 3 | `canva-oauth-gates.pg.spec.ts` | PASS | 2026-10-28 | 18.6 |  |  |
| J (variants) | 3 | `canva-oauth-gates.pg.spec.ts` | PASS | 2026-10-28 | 18.6 |  | Skipped by the first batch 3 filter |
| K | 3 | `canva-oauth-gates.pg.spec.ts` | PASS | 2026-10-28 | 18.6 |  |  |
| L | 3 | `canva-oauth-gates.pg.spec.ts` | PASS | 2026-10-28 | 18.6 |  |  |
| M(a, b) | 3 | `canva-oauth-gates.pg.spec.ts` | PASS | 2026-10-28 | 18.6 |  | Skipped by the first batch 3 filter |
| Q | 3 | `canva-oauth-gates.pg.spec.ts` | PASS | 2026-10-28 | 18.6 |  |  |
| R(a, c) | 3 | `canva-oauth-gates.pg.spec.ts` | PASS | 2026-10-28 | 18.6 |  | Skipped by the first batch 3 filter |
| F (part) | 3 | `canva-oauth-gates.pg.spec.ts` | PASS | 2026-10-28 | 18.6 |  | Skipped by the first batch 3 filter |
| N | 4 | `canva-oauth-gates.pg.spec.ts` | PASS | 2026-10-28 | 18.6 |  |  |
| P | 5 | `canva-oauth-gates.pg.spec.ts` | PASS | 2026-10-28 | 18.6 | 783151, 101, 202 | Coverage strengthened (§12, item 4); seeds 783151, 101, 202 |
| E | 5 | `canva-oauth-gates.pg.spec.ts` | PASS | 2026-10-28 | 18.6 | 788924, 303, 404 | Coverage strengthened (§12, item 4); seeds 788924, 303, 404 |
| A | 6 | `canva-oauth-gates.pg.spec.ts` | PASS | 2026-10-28 | 18.6 |  | Proxy calibration held |
| B | 6 | `canva-oauth-gates.pg.spec.ts` | PASS | 2026-10-28 | 18.6 |  | Proxy calibration held |
| O | 6 | `canva-oauth-gates.pg.spec.ts` | PASS | 2026-10-28 | 18.6 |  | Proxy calibration held |
| F (rest) | 7 | `canva-oauth-gates.pg.spec.ts` | PASS | 2026-10-28 | 18.6 |  | With ADFLOW_PG_MIGRATE_RUNNER=run; the failed migration left no tables; repository migrations unchanged |
| G | 8 | `canva-browser.pg.spec.ts` | PASS | 2026-10-28 | 18.6 |  | Playwright 1.56.1, bundled Chromium 141; no profile directory left |

## 12. Stage 2.5 run record (2026-10-28)

**Environment.**
- PostgreSQL 18.6 (x86_64-windows, MSVC build), binaries from the existing `C:\Program Files\PostgreSQL\18` installation. The existing Windows service on `0.0.0.0:5432` was never connected to, stopped, or modified.
- A new cluster: `initdb` into the fresh directory `%LOCALAPPDATA%\adflow-gates\stage25-20261028162906\data` (refused if it existed), superuser `gate_admin`, `listen_addresses = '127.0.0.1'` and `port = 55432` written into its own `postgresql.conf`, started with `pg_ctl`, database `adflow_gates_test` commented `adflow-isolated-test:stage25-20261028162906`.
- Authentication: `trust` on the loopback lines `initdb` writes (`127.0.0.1/32`, `::1/128`), so no password or other secret was created. Any local process could have connected during the run; the preflight and post-run checks showed no other session.
- Prisma 6.19.3: PostgreSQL 18 is listed on [Prisma's v6 supported-databases page](https://www.prisma.io/docs/orm/v6/reference/supported-databases).
- Tooling: Node 24.21.0; pnpm 11.19.0 through `corepack pnpm` (not on `PATH`; nothing was enabled globally).
- Preflight (§5): every item passed; the read-only identity queries returned the expected version, address, port, listen setting, data directory, and marker, two databases, the `public` schema with no tables, and one session.

**Defects found and fixed during the run.** Each was in the gates or this runbook, not in the protocol; no assertion was weakened, and every affected gate was rerun.

1. **Runbook filter.** pnpm 11 forwards a backslash doubled, so the batch 3 pattern's `\(` reached Vitest as `\\(` and five gates (7 (rest), J (variants), M(a, b), R(a, c), F (part)) were silently skipped. Patterns now use `[(]` and `[)]`.
2. **Gate C ordering, and background worker runs.** Gate C scripted the fake Canva's responses in arrival order, but a worker batch processes its claimed rows in the order of `UPDATE … RETURNING`, which PostgreSQL does not guarantee. Evidence from the kept schema: every row's state matched the response it actually received (for example `c-429` finished `not_revocable` after receiving the 400 meant for `c-400`). The fake now scripts responses per Canva user. Separately, the services' automatic worker triggers ran in the background on each actor's single connection, racing the gates' explicit worker runs (Gate 4 took 17 s, with "revocation result not confirmed" warnings); they are now inert in gates, and Gate 4 takes 1.5 s with no warning.
3. **Gate 9's last check proved the wrong thing.** "One candidate per Canva user" reused another organization's attempt and was refused by the `attemptId` unique key. It now uses its own attempt and must be refused by the `canvaUserId` unique index (`23505`, which PostgreSQL checks before the end-of-statement foreign-key check), and every other refusal in Gate 9 must name its intended constraint.
4. **Gates P and E were mostly no-ops.** Their outcome tallies (added during the run) showed 1 to 4 activations per run, and every one of E's 22 refreshes ended `not_connected`, so no refresh write ever took part. Operations are now state-aware (activation creates a candidate when none is pending; refresh connects one when no organization has a credential), the mixes fail on programming errors, guard refusals, or fewer than half the operations completing, and each requires its key paths to occur (P: a connection; E: a connection and a completed refresh). Final runs: P 5 to 9 connections; E 10 to 14 connections and 10 to 19 refreshes per seed.

**Findings about the system under test.**
- Prisma framed every protocol transaction as one BEGIN and one COMMIT and sent no transaction control for autocommitted raw queries; every armed drop fired; and the client reconnected after each dropped connection (gates A, B, O calibration). Prisma's reconnect behavior, open since Stage 2.3, held in this run.
- A migration failing halfway left none of its tables (gate F): it was applied atomically. This run does not show whether Prisma or PostgreSQL's implicit transaction for a multi-statement query provides that.
- The server log's only errors were the gates' intended effects: Gate 9's constraint refusals, Gate F's injected `division by zero`, Gate N's `lock timeout`, and batch 6's dropped connections. No `FATAL` or `PANIC`.

**What the run does not prove.** One platform (Windows) and one PostgreSQL version; one run per gate (three seeds each for P and E); browser behavior in Chromium only (not Firefox or Safari); and Canva's own behavior only as the fake models it (assumptions A-R1 to A-R6 and A-S1 in the proposal remain unverified). Passing gates do not make real Canva mode ready: it stays disabled, and live use still needs the remaining steps in `canva.md`.

**Cleanup.** The kept Gate C schema was dropped by name after its evidence was saved; no gate schema, `adflow-gate-f-*`, or `adflow-gate-g-profile-*` directory remained; the cluster was stopped with `pg_ctl stop`. Its directory is kept, with `server.log`, every batch log, and `gateC-evidence.txt`; delete it when no longer needed. No environment variable was set beyond each command's own process.

## 13. Stage 2.9 rerun: batches 3 and 6 (2026-10-28)

**Why.** Stage 2.8 changed the revocation classification (`401 invalid_access_token` is a configuration error), added the worker's `configurationErrors` count, and Stage 2.8.1 added the `inspect` health SQL. Batch 3 holds the worker and service gates, including Gate C; batch 6 holds Gate O (ambiguous commits in `E`, T1, and T2). No other batch was run: not 1, 2, 4, 5, 7 (migration recovery), or 8 (browser).

**Gate C extension** (in `canva-oauth-gates.pg.spec.ts`; the `invalid_client` case is kept and now also asserts `lastErrorKind = configuration` and the 15-minute pause). A new Canva user `c-401-documented` gets Canva's documented revoke response, `401 {"code":"invalid_access_token","message":"Client secret is invalid for …"}`, through the fake's injected fetch and the real `CanvaTokenClient`:
- the first batch reports `configurationErrors: 2` (both 401 cases) and `exhausted: 0`;
- the row stays `queued` with `attempts = 0`, `outcome = NULL`, `lastErrorKind = configuration`, `nextAttemptAt` at least 15 minutes after `callStartedAt`, and its key version, IV, ciphertext, and tag byte-for-byte unchanged;
- `inspect()` reports `revocationConfigurationErrors: 2` (the Stage 2.8.1 SQL, on PostgreSQL);
- nine more refusals (past the 8-attempt limit) each report `configurationErrors: 1` and `exhausted: 0`; the row is still `queued` with 0 attempts and the same ciphertext, and the fake saw 10 revoke calls;
- only with the row's age past the 7-day pause limit is it `exhausted`, still with 0 attempts, `lastErrorKind = configuration`, and the same ciphertext.

What the gate asserted directly, and what rests on other evidence (wording corrected after the Stage 2.10 review, which found the original "exhausted (audited)" overstated):
- **Asserted by Gate C for this row**: the worker summaries, the queue row's state, attempts, outcome, `lastErrorKind`, `nextAttemptAt`, and stored key version, IV, ciphertext, and tag, the `inspect()` health counts, and the fake's revoke count, as listed above.
- **Not asserted for this row: its audit record.** Gate C's only audit assertion (`canva.connection.revocation_exhausted` among the audit actions) comes later and is satisfied by the separate `c-exhaust` row, so it would pass even if this row's exhaustion wrote no audit event.
- **Supported by code review and the log, not by an assertion**: the exhaustion audit is written by `auditExhausted` in the same transaction as the T2 update that set the row `exhausted` (`canva-revocation.prisma-store.ts`), so the asserted state change implies the audit insert committed with it; and `batch3.log` contains that function's error-level log line `Canva revocation exhausted after 0 attempts (disconnect)` (wrapped onto two lines by the PowerShell redirection), which only this row (0 attempts) could produce in Gate C. A per-row audit assertion can be added the next time the gates are approved to run.

**Environment and preflight.** PostgreSQL 18.6 binaries from `C:\Program Files\PostgreSQL\18` (the Windows service on port 5432 was not connected to, stopped, or changed). A new cluster: `initdb` into the fresh `%LOCALAPPDATA%\adflow-gates\stage29-20261028180510\data`, superuser `gate_admin`, `trust` on the loopback lines only (no password or other secret created), `listen_addresses = '127.0.0.1'` and `port = 55432` in its own `postgresql.conf`. Database `adflow_gates_test` commented `adflow-isolated-test:stage29-20261028180510`. Every §5 item passed: offline `src/pg` unit tests (68) and the test typecheck; the read-only identity queries returned `PostgreSQL 18.6 on x86_64-windows`, `adflow_gates_test`, `127.0.0.1`, `55432`, listen `127.0.0.1`, the expected data directory and marker, only `adflow_gates_test` and `postgres`, only the `public` schema with no tables, and one session.

**Results** (commands exactly as §7; `pnpm` through `corepack`):

| Gate | Batch | Status | Notes |
| --- | --- | --- | --- |
| 2, 3, 4, 5, 6, 7 (rest), 8, D, I, J (variants), K, L, M(a, b), Q, R(a, c), F (part) | 3 | PASS | Same warnings as Stage 2.5's batch 3 rerun (one `rotation lost; reconnect mark not saved` from Gate 7, one `claim lost` from Gate C's crash recovery, exhaustion error logs) |
| C (extended) | 3 | PASS | 2.2 s; one additional, expected `exhausted after 0 attempts` log from the pause-limit step |
| A, B, O | 6 | PASS | Proxy calibration held; same warnings as Stage 2.5 |

17 of 25 tests ran in batch 3 and 3 in batch 6; the others were skipped by the filters, as intended. No refusal, proxy-assumption failure, invariant violation, deadlock, or timeout. The server log had no `ERROR`, `FATAL`, or `PANIC`; its only events were three "unexpected EOF on client connection with an open transaction" from batch 6's dropped connections.

**Cleanup.** No gate schema, other session, `adflow-gate-f-*`, or `adflow-gate-g-profile-*` directory remained; the cluster was stopped with `pg_ctl stop -m fast`. Its directory is kept with `server.log`, `batch3.log`, `batch6.log`, and `marker.txt`; delete it when no longer needed. Environment variables were set only inside each command's process.

**Not shown by this rerun.** Batches 1, 2, 4, 5, 7, and 8 were not rerun (their code paths did not change in Stages 2.8 and 2.8.1). The operator command's real entry point was not run against the database. Canva's own behavior is still only as the fake models it.
