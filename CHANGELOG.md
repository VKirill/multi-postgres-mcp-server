# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-02-07

### Added

- **Multi-database support**: Manage multiple PostgreSQL connections from a single MCP server
- **Connection pooling**: `pg.Pool` with lazy initialization and hot-reload awareness via config hash comparison
- **SQL injection protection**: State-machine SQL parser rejects multi-statement queries (statement stacking prevention)
- **Parameterized queries**: `params` array support for `$1, $2, ...` bind variables
- **SSL/TLS support**: `ssl` field per connection (boolean or detailed config with `rejectUnauthorized`, `ca`, `cert`, `key`)
- **Connection string support**: `url` field as alternative to `host`/`port`/`user`/`database`
- **Write mode**: Optional `readOnly: false` per connection (default: read-only with `BEGIN TRANSACTION READ ONLY`)
- **Zod validation**: Full config validation with descriptive error messages
- **Duplicate label detection**: Warning on duplicate labels, keeps first occurrence
- **`--label` filtering**: Restrict server to a single database for per-project isolation
- **`--config` flag and `MCP_POSTGRES_CONFIG` env**: Flexible config file location
- **Async config loading**: Uses `fs/promises` for non-blocking I/O
- **Configurable pool size**: `poolSize` field per connection (1–100, default 5)
- **Graceful shutdown**: Drains all connection pools on SIGTERM/SIGINT

#### MCP Tools
- `pg_list_databases` — List all configured and enabled databases
- `pg_query` — Execute SQL with read-only transaction wrapper, parameterized queries
- `pg_list_tables` — List tables with estimated row counts
- `pg_describe_table` — Show columns, types, constraints, foreign keys, and indexes
- `pg_list_schemas` — List all schemas with table counts
- `pg_health_check` — Test connection, show PostgreSQL version and latency
- `pg_explain` — EXPLAIN ANALYZE wrapper (always rolled back)
- **Environment variable substitution** in config values (`${VAR}` syntax)
- **Config caching** with TTL and mtime check for reduced I/O
- **Result pagination**: Optional `limit` parameter for `pg_query`

#### Documentation
- README.md with setup, configuration, and usage examples
- SECURITY.md with defense-in-depth architecture, role setup, hardening checklist
- CONTRIBUTING.md with development guidelines
- CHANGELOG.md (this file)

#### DevOps
- GitHub Actions CI/CD workflow (lint, test, build)
- Dockerfile for container deployment
- ESLint + Prettier configuration
- vitest test suite (43+ tests)
- TypeScript source maps

### Security
- Read-only transactions by default
- Multi-statement SQL detection and rejection
- Connection timeouts (10s connect, 30s statement)
- Idle connection cleanup (60s)
- Defense-in-depth: 6 independent security layers
