# Security Policy

## Overview

`multi-postgres-mcp-server` is a Model Context Protocol (MCP) server that provides
AI coding assistants (Claude Code, Cursor, Windsurf, etc.) with access to multiple
PostgreSQL databases through a single process. Because this server bridges AI agents
and live databases, security is a first-class design concern.

This document describes the security model, built-in protections, recommended
deployment practices, and how to report vulnerabilities.

---

## Table of Contents

- [Security Model](#security-model)
  - [Read-Only by Default](#1-read-only-by-default)
  - [SQL Injection Protection](#2-sql-injection-protection)
  - [Connection Security](#3-connection-security)
  - [Configuration Security](#4-configuration-security)
  - [Database Isolation](#5-database-isolation)
- [Recommended PostgreSQL Role Setup](#recommended-postgresql-role-setup)
- [Deployment Hardening Checklist](#deployment-hardening-checklist)
- [Known Limitations](#known-limitations)
- [Reporting a Vulnerability](#reporting-a-vulnerability)

---

## Security Model

### 1. Read-Only by Default

All database connections default to **read-only** mode. Every query issued through
the `pg_query` tool is wrapped in a read-only transaction:

```sql
BEGIN TRANSACTION READ ONLY;
-- user query executes here --
COMMIT;
```

This means that `INSERT`, `UPDATE`, `DELETE`, `DROP`, `TRUNCATE`, `ALTER`, and other
write operations will fail at the PostgreSQL level with an error, even if the
connected database user has write privileges.

When a connection is explicitly configured with `readOnly: false`, the read-only
transaction wrapper is removed for that connection. **This should only be used in
development environments where write access is intentional and understood.**

### 2. SQL Injection Protection

#### Multi-Statement Detection

The server includes a state-machine SQL parser that analyzes queries before
execution. The parser:

1. Strips single-line comments (`-- ...`)
2. Strips block comments (`/* ... */`)
3. Strips string literals (single-quoted `'...'`, double-quoted `"..."`, and
   dollar-quoted `$$...$$`)
4. Scans the remaining text for semicolons

If a semicolon is found outside of comments and string literals, the query is
**rejected** as a potential multi-statement injection. This prevents attacks like:

```sql
SELECT 1; DROP TABLE users; --
```

#### Parameterized Queries

The `pg_query` tool supports parameterized queries with positional placeholders.
Callers can pass values through a `params` array, which maps to `$1`, `$2`, etc.
in the SQL text:

```json
{
  "database": "production",
  "query": "SELECT * FROM users WHERE email = $1 AND status = $2",
  "params": ["user@example.com", "active"]
}
```

Values passed through `params` are sent to PostgreSQL as bind parameters and are
**never** interpolated into the SQL string, eliminating SQL injection through
parameter values.

#### Built-in Catalog Queries

The `pg_list_tables` and `pg_describe_table` tools use hardcoded,
parameterized queries against PostgreSQL's `information_schema` and system
catalogs. User-supplied table and schema names are always passed as bind
parameters (`$1`, `$2`), never concatenated into SQL.

### 3. Connection Security

#### SSL/TLS

For cloud-hosted databases (AWS RDS, Azure Database for PostgreSQL, Google Cloud
SQL, Supabase, Neon, etc.), SSL connections are supported. Configure the `ssl`
property in your connection entry:

```json
{
  "label": "cloud-db",
  "host": "your-instance.region.rds.amazonaws.com",
  "port": 5432,
  "user": "mcp_readonly",
  "password": "...",
  "database": "myapp",
  "ssl": { "rejectUnauthorized": true }
}
```

For self-signed certificates, you may set `"rejectUnauthorized": false`, though
this is **not recommended** for production.

#### Timeouts

| Setting | Value | Purpose |
|---|---|---|
| `connectionTimeoutMillis` | 10,000 ms (10 s) | Prevents hanging on unreachable hosts |
| `statement_timeout` | 30,000 ms (30 s) | Kills long-running queries server-side |

These values are hardcoded to prevent denial-of-service scenarios where a
malformed or expensive query could tie up a connection indefinitely.

#### Connection Pooling

The server uses `pg.Pool` with lazy initialization per database label. Pools are
created on first access and automatically refreshed if the connection config
changes (hot-reload aware via hash comparison). Key pool settings:

| Setting | Value | Purpose |
|---|---|---|
| `max` | Configurable (`poolSize`, default 5) | Limits concurrent connections per database |
| `idleTimeoutMillis` | 60,000 ms (60 s) | Closes idle connections to free resources |

On graceful shutdown (`SIGTERM`/`SIGINT`), all pools are drained and connections
are properly closed.

### 4. Configuration Security

#### Local Filesystem Only

The configuration file is read from the local filesystem using Node.js `fs`
modules. There is no network-based config loading, no remote URLs, and no
environment variable interpolation inside the config file.

The config path is resolved in this order:

1. `--config <path>` CLI argument
2. `MCP_POSTGRES_CONFIG` environment variable
3. Default: `~/.mcp-postgres/config.json`

#### Input Validation

Connection configuration is validated using [Zod](https://zod.dev/) schemas.
Malformed entries (missing required fields, wrong types, invalid port numbers)
are rejected at load time with descriptive error messages.

#### Password Storage

Database passwords are stored in plaintext within the config file. To mitigate
the risk of credential exposure:

**On Linux/macOS:**
```bash
chmod 600 ~/.mcp-postgres/config.json
```

**On Windows:**
Restrict file access via Properties > Security to your user account only.

**Additional recommendations:**
- Add `config.json` to your global `.gitignore` to prevent accidental commits
- Consider using connection strings with environment variables for CI/CD:
  ```
  MCP_POSTGRES_CONFIG=/secure/path/config.json
  ```
- For maximum security, use PostgreSQL's `~/.pgpass` file or cloud IAM
  authentication instead of passwords in the config

### 5. Database Isolation

The `--label` flag restricts the server to a single database connection:

```bash
node dist/index.js --label production
```

When `--label` is set:
- Only the matching connection is visible
- `pg_list_databases` shows only that one database
- All other connections are completely hidden from the AI agent
- This prevents an AI from discovering or querying databases it should not access

This is the recommended configuration for per-project Cursor setups, where each
project should only access its own database.

---

## Recommended PostgreSQL Role Setup

Create a dedicated read-only role for the MCP server. **Do not reuse application
credentials or superuser accounts.**

```sql
-- 1. Create a dedicated role
CREATE ROLE mcp_readonly LOGIN PASSWORD 'secure_password';

-- 2. Grant connection access
GRANT CONNECT ON DATABASE mydb TO mcp_readonly;

-- 3. Grant schema usage
GRANT USAGE ON SCHEMA public TO mcp_readonly;

-- 4. Grant SELECT on all existing tables
GRANT SELECT ON ALL TABLES IN SCHEMA public TO mcp_readonly;

-- 5. Auto-grant SELECT on future tables
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO mcp_readonly;
```

### For multiple schemas

```sql
-- Repeat for each schema the MCP server needs to read
GRANT USAGE ON SCHEMA analytics TO mcp_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA analytics TO mcp_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA analytics
  GRANT SELECT ON TABLES TO mcp_readonly;
```

### Additional restrictions (optional but recommended)

```sql
-- Prevent the role from creating objects
ALTER ROLE mcp_readonly NOSUPERUSER NOCREATEDB NOCREATEROLE;

-- Set a connection limit
ALTER ROLE mcp_readonly CONNECTION LIMIT 5;

-- Set a statement timeout at the role level (belt and suspenders)
ALTER ROLE mcp_readonly SET statement_timeout = '30s';
```

### Verify the setup

```sql
-- Connect as mcp_readonly and confirm read-only access
SET ROLE mcp_readonly;

SELECT count(*) FROM users;        -- Should succeed
INSERT INTO users DEFAULT VALUES;  -- Should fail: permission denied
DROP TABLE users;                  -- Should fail: permission denied
```

---

## Deployment Hardening Checklist

- [ ] Use a dedicated PostgreSQL role with `SELECT`-only privileges (see above)
- [ ] Set `chmod 600` (or equivalent) on the config file
- [ ] Add config file path to `.gitignore`
- [ ] Enable SSL for all non-localhost connections
- [ ] Use `--label` filtering for per-project deployments
- [ ] Set `enabled: false` on connections that are not actively needed
- [ ] Keep `readOnly: true` (the default) unless you have a specific reason to change it
- [ ] Review PostgreSQL logs (`log_statement = 'all'`) to audit MCP server queries
- [ ] Run the MCP server process under a non-privileged OS user
- [ ] Keep dependencies updated (`npm audit`, `npm update`)

---

## Known Limitations

| Limitation | Mitigation |
|---|---|
| Config file stores passwords in plaintext | Use restrictive file permissions (`chmod 600`); consider `~/.pgpass` or IAM auth |
| No query allow-listing or deny-listing | Rely on read-only transactions + restricted PostgreSQL role privileges |
| Dollar-quoted string parsing (`$$...$$`) is best-effort | Exotic or nested dollar-quoting may bypass multi-statement detection; the read-only transaction provides a second layer of defense |
| No rate limiting on tool invocations | Rate limiting is the responsibility of the MCP client (Claude Code, Cursor, etc.) |
| No audit logging | Enable PostgreSQL-side logging (`log_statement`, `pgAudit`) for a complete audit trail |
| Connection credentials visible in process arguments if passed via CLI | Use config file or environment variable instead of inline arguments |

---

## Supported Versions

| Version | Supported |
|---|---|
| 1.x (current) | Yes |

---

## Reporting a Vulnerability

We take the security of this project seriously. If you discover a security
vulnerability, please report it responsibly.

### How to Report

1. **GitHub Private Vulnerability Reporting (preferred)**
   Navigate to the [Security Advisories](https://github.com/VKirill/multi-postgres-mcp-server/security/advisories)
   page and click **"Report a vulnerability"**. This creates a private channel
   between you and the maintainers.

2. **GitHub Issues**
   For lower-severity issues that do not involve credential exposure or remote
   code execution, you may open a regular
   [GitHub Issue](https://github.com/VKirill/multi-postgres-mcp-server/issues)
   with the `security` label.

### What to Include

- A clear description of the vulnerability
- Steps to reproduce (proof of concept if possible)
- Affected version(s)
- Potential impact assessment
- Suggested fix (if you have one)

### Response Timeline

| Step | Timeframe |
|---|---|
| Acknowledgment of report | Within 48 hours |
| Initial assessment and severity classification | Within 5 business days |
| Patch development and testing | Depends on severity |
| Public disclosure (coordinated) | After patch is available |

### Scope

The following are **in scope** for security reports:

- SQL injection bypasses (e.g., circumventing multi-statement detection)
- Read-only transaction escapes
- Configuration file parsing vulnerabilities
- Dependency vulnerabilities with a known exploit path
- Information disclosure through error messages

The following are **out of scope**:

- PostgreSQL server vulnerabilities (report to the PostgreSQL project)
- MCP protocol-level issues (report to the MCP specification maintainers)
- Denial-of-service through legitimate but expensive queries (mitigated by
  `statement_timeout`)
- Social engineering attacks

---

## Security Design Principles

This project follows a **defense-in-depth** approach with multiple independent
layers of protection:

```
Layer 1: PostgreSQL role privileges (SELECT only)
    Layer 2: Read-only transaction wrapper (BEGIN TRANSACTION READ ONLY)
        Layer 3: Multi-statement detection (reject semicolons)
            Layer 4: Parameterized queries (no string interpolation)
                Layer 5: Connection timeouts (10s connect, 30s query)
                    Layer 6: --label isolation (single-database exposure)
```

Each layer is designed to function independently. Even if one layer is bypassed,
the remaining layers continue to provide protection. For example:

- If multi-statement detection is bypassed, the read-only transaction still
  prevents writes
- If the read-only transaction is somehow circumvented, the PostgreSQL role
  privileges still deny write operations
- If a query runs longer than expected, the `statement_timeout` kills it
  server-side

---

*Last updated: 2026-02-07*
