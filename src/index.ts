#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import pg from "pg";
import { readFile, stat } from "fs/promises";
import { existsSync } from "fs";
import { join, resolve } from "path";
import { platform } from "os";

// ─── CLI args & env ───────────────────────────────────────────────

const HOME = process.env.USERPROFILE || process.env.HOME || "";

function getArg(name: string): string | null {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return null;
  const next = process.argv[idx + 1];
  if (!next || next.startsWith("--")) return null;
  return next;
}

/** --config <path>  or  MCP_POSTGRES_CONFIG env  or  default */
const CONFIG_PATH = resolve(
  getArg("--config") ||
    process.env.MCP_POSTGRES_CONFIG ||
    join(HOME, ".mcp-postgres", "config.json")
);

/** --label <name>  — if set, only this database is visible */
const LABEL_FILTER = getArg("--label");

// ─── Zod Schemas ─────────────────────────────────────────────────

const SslConfigSchema = z.union([
  z.literal(true),
  z.object({
    rejectUnauthorized: z.boolean().optional(),
    ca: z.string().optional(),
    cert: z.string().optional(),
    key: z.string().optional(),
  }),
]);

const DbConnectionSchema = z
  .object({
    label: z.string().min(1, "Label is required"),
    host: z.string().optional(),
    port: z.coerce.number().int().positive().default(5432),
    user: z.string().optional(),
    password: z.string().default(""),
    database: z.string().optional(),
    url: z.string().optional(),
    enabled: z.boolean().default(true),
    ssl: SslConfigSchema.optional(),
    readOnly: z.boolean().default(true),
    poolSize: z.coerce.number().int().min(1).max(100).default(5),
  })
  .refine((c) => c.url || (c.host && c.user && c.database), {
    message: "Provide either 'url' or 'host' + 'user' + 'database'",
  });

type DbConnection = z.infer<typeof DbConnectionSchema>;

const DbConfigSchema = z.object({
  connections: z.union([
    z.array(DbConnectionSchema),
    z.record(z.string(), DbConnectionSchema),
  ]),
});

// ─── Connection Pool Management ──────────────────────────────────

interface PoolEntry {
  pool: pg.Pool;
  hash: string;
}

const pools = new Map<string, PoolEntry>();

function connHash(c: DbConnection): string {
  return JSON.stringify({
    h: c.host,
    p: c.port,
    u: c.user,
    pw: c.password,
    d: c.database,
    url: c.url,
    ssl: c.ssl,
    ps: c.poolSize,
  });
}

function getOrCreatePool(conn: DbConnection): pg.Pool {
  const hash = connHash(conn);
  const existing = pools.get(conn.label);
  if (existing && existing.hash === hash) return existing.pool;

  // Config changed — close old pool
  if (existing) {
    existing.pool.end().catch((e) =>
      console.error(`Pool close error (${conn.label}):`, e)
    );
  }

  const cfg: pg.PoolConfig = {
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
    idleTimeoutMillis: 60_000,
    max: conn.poolSize,
  };

  if (conn.url) {
    cfg.connectionString = conn.url;
  } else {
    cfg.host = conn.host;
    cfg.port = conn.port;
    cfg.user = conn.user;
    cfg.password = conn.password;
    cfg.database = conn.database;
  }

  if (conn.ssl) {
    cfg.ssl = conn.ssl === true ? { rejectUnauthorized: false } : conn.ssl;
  }

  const pool = new pg.Pool(cfg);
  pool.on("error", (err) =>
    console.error(`Pool error (${conn.label}):`, err.message)
  );
  pools.set(conn.label, { pool, hash });
  return pool;
}

async function drainAllPools(): Promise<void> {
  const tasks = [...pools.values()].map((e) => e.pool.end().catch(() => {}));
  pools.clear();
  await Promise.all(tasks);
}

// ─── Environment Variable Substitution ───────────────────────────

/**
 * Replaces `${VAR}` patterns in string values with process.env values.
 * Supports `${VAR:-default}` syntax for defaults when env var is unset.
 */
export function resolveEnvVars(obj: unknown): unknown {
  if (typeof obj === "string") {
    return obj.replace(/\$\{([^}]+)\}/g, (_, expr: string) => {
      const [name, ...rest] = expr.split(":-");
      const fallback = rest.join(":-");
      return process.env[name.trim()] ?? fallback ?? "";
    });
  }
  if (Array.isArray(obj)) return obj.map(resolveEnvVars);
  if (obj !== null && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = resolveEnvVars(v);
    }
    return out;
  }
  return obj;
}

// ─── Config Caching ──────────────────────────────────────────────

interface ConfigCache {
  connections: DbConnection[];
  mtime: number;
  loadedAt: number;
}

const CONFIG_CACHE_TTL = 5_000; // 5 seconds
let configCache: ConfigCache | null = null;

// ─── Config Loading ──────────────────────────────────────────────

async function loadConfig(): Promise<DbConnection[]> {
  try {
    // Check cache: reuse if TTL not expired and file unchanged
    if (configCache) {
      const elapsed = Date.now() - configCache.loadedAt;
      if (elapsed < CONFIG_CACHE_TTL) return configCache.connections;

      // TTL expired — check mtime
      try {
        const s = await stat(CONFIG_PATH);
        if (s.mtimeMs === configCache.mtime) {
          configCache.loadedAt = Date.now(); // refresh TTL
          return configCache.connections;
        }
      } catch {
        // File deleted or inaccessible — fall through to full reload
      }
    }

    const raw = await readFile(CONFIG_PATH, "utf-8");
    const jsonWithEnv = resolveEnvVars(JSON.parse(raw));
    const parsed = DbConfigSchema.parse(jsonWithEnv);

    let connections: DbConnection[];
    if (Array.isArray(parsed.connections)) {
      connections = parsed.connections;
    } else {
      connections = Object.values(parsed.connections);
    }

    // Detect duplicate labels
    const seen = new Set<string>();
    for (const c of connections) {
      if (seen.has(c.label)) {
        console.error(
          `Warning: duplicate label "${c.label}" in config — using first occurrence`
        );
      }
      seen.add(c.label);
    }

    // Deduplicate (keep first)
    connections = connections.filter(
      (c, i, arr) => arr.findIndex((x) => x.label === c.label) === i
    );

    connections = connections.filter((c) => c.enabled !== false);

    if (LABEL_FILTER) {
      connections = connections.filter((c) => c.label === LABEL_FILTER);
    }

    // Update cache
    try {
      const s = await stat(CONFIG_PATH);
      configCache = { connections, mtime: s.mtimeMs, loadedAt: Date.now() };
    } catch {
      configCache = { connections, mtime: 0, loadedAt: Date.now() };
    }

    return connections;
  } catch (e) {
    if (!existsSync(CONFIG_PATH)) {
      console.error(`Config not found: ${CONFIG_PATH}`);
      console.error(
        "Create it with your database connections. See README for format."
      );
    } else if (e instanceof z.ZodError) {
      console.error(`Invalid config (${CONFIG_PATH}):`);
      for (const issue of e.issues) {
        console.error(`  ${issue.path.join(".")}: ${issue.message}`);
      }
    } else {
      console.error(`Failed to read config: ${CONFIG_PATH}`, e);
    }
    return [];
  }
}

async function getConnection(label: string): Promise<DbConnection> {
  const connections = await loadConfig();
  const conn = connections.find((c) => c.label === label);
  if (!conn) {
    const available = connections.map((c) => c.label).join(", ") || "(none)";
    throw new Error(`Database "${label}" not found. Available: ${available}`);
  }
  return conn;
}

// ─── SQL Safety ──────────────────────────────────────────────────

/**
 * Detects multi-statement SQL to prevent injection via statement stacking.
 * Strips comments, string literals, and dollar-quoted strings before checking
 * for semicolons. Returns true only if the SQL is a single statement.
 */
export function isSingleStatement(sql: string): boolean {
  let i = 0;
  const len = sql.length;

  while (i < len) {
    const ch = sql[i];
    const next = i + 1 < len ? sql[i + 1] : "";

    // -- single-line comment → skip to EOL
    if (ch === "-" && next === "-") {
      i = sql.indexOf("\n", i);
      if (i === -1) return true;
      i++;
      continue;
    }

    // /* block comment */ → skip to closing
    if (ch === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) return true;
      i = end + 2;
      continue;
    }

    // 'single-quoted string' with '' escape
    if (ch === "'") {
      i++;
      while (i < len) {
        if (sql[i] === "'") {
          if (i + 1 < len && sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      i++;
      continue;
    }

    // "double-quoted identifier"
    if (ch === '"') {
      i++;
      while (i < len && sql[i] !== '"') i++;
      i++;
      continue;
    }

    // $tag$...$tag$ dollar-quoted string
    if (ch === "$") {
      let j = i + 1;
      while (j < len && /[a-zA-Z0-9_]/.test(sql[j])) j++;
      if (j < len && sql[j] === "$") {
        const tag = sql.substring(i, j + 1);
        const endIdx = sql.indexOf(tag, j + 1);
        if (endIdx === -1) return true;
        i = endIdx + tag.length;
        continue;
      }
    }

    // Semicolon — reject if anything meaningful follows
    if (ch === ";") {
      const rest = sql.substring(i + 1).trim();
      if (rest.length > 0) return false;
    }

    i++;
  }

  return true;
}

// ─── Helpers ─────────────────────────────────────────────────────

function errorResult(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return {
    content: [{ type: "text" as const, text: `Error: ${msg}` }],
    isError: true,
  };
}

async function withPool<T>(
  label: string,
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const conn = await getConnection(label);
  const pool = getOrCreatePool(conn);
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

// ─── MCP Server ──────────────────────────────────────────────────

const server = new McpServer({
  name: "postgres",
  version: "1.0.0",
});

// Tool 1: List databases
server.tool(
  "pg_list_databases",
  "List all available PostgreSQL databases",
  {},
  async () => {
    const connections = await loadConfig();
    if (connections.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No databases available.\nConfig: ${CONFIG_PATH}${LABEL_FILTER ? `\nFilter: --label ${LABEL_FILTER}` : ""}`,
          },
        ],
      };
    }

    const lines = connections.map((c) => {
      const addr = c.url
        ? "(connection string)"
        : `${c.user}@${c.host}:${c.port}/${c.database}`;
      const flags: string[] = [];
      if (c.ssl) flags.push("SSL");
      if (!c.readOnly) flags.push("RW");
      const suffix = flags.length ? ` [${flags.join(", ")}]` : "";
      return `- ${c.label}: ${addr}${suffix}`;
    });

    return {
      content: [
        {
          type: "text",
          text: `Available databases (${connections.length}):\n${lines.join("\n")}`,
        },
      ],
    };
  }
);

// Tool 2: Execute SQL query
server.tool(
  "pg_query",
  "Execute a SQL query against a PostgreSQL database. Read-only by default; write queries allowed only if the connection is configured with readOnly: false.",
  {
    database: z.string().describe("Database label from config"),
    query: z.string().describe("SQL query to execute"),
    params: z
      .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .optional()
      .describe("Optional query parameters for $1, $2, ... placeholders"),
    limit: z
      .coerce
      .number()
      .int()
      .positive()
      .optional()
      .describe("Max rows to return (truncates results if exceeded)"),
  },
  async ({ database, query, params, limit }) => {
    try {
      // SQL injection protection: reject multi-statement queries
      if (!isSingleStatement(query)) {
        return {
          content: [
            {
              type: "text",
              text: "Error: Multi-statement queries are not allowed. Send one statement at a time.",
            },
          ],
          isError: true,
        };
      }

      const conn = await getConnection(database);

      const result = await withPool(database, async (client) => {
        if (conn.readOnly) {
          await client.query("BEGIN TRANSACTION READ ONLY");
        } else {
          await client.query("BEGIN");
        }
        try {
          const res = params
            ? await client.query(query, params)
            : await client.query(query);
          await client.query("COMMIT");
          return res;
        } catch (e) {
          await client.query("ROLLBACK").catch(() => {});
          throw e;
        }
      });

      if (!result.rows || result.rows.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `Query executed. ${result.rowCount ?? 0} row(s) affected. No rows returned.`,
            },
          ],
        };
      }

      const columns = result.fields.map((f) => f.name);
      const totalRows = result.rows.length;
      const rows = limit && totalRows > limit
        ? result.rows.slice(0, limit)
        : result.rows;
      const truncated = limit && totalRows > limit;

      const payload: Record<string, unknown> = {
        columns,
        rows,
        rowCount: result.rowCount,
      };
      if (truncated) {
        payload.truncated = true;
        payload.totalRows = totalRows;
        payload.limit = limit;
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(payload, null, 2),
          },
        ],
      };
    } catch (e) {
      return errorResult(e);
    }
  }
);

// Tool 3: List tables
server.tool(
  "pg_list_tables",
  "List tables in a PostgreSQL database with estimated row counts",
  {
    database: z.string().describe("Database label from config"),
    schema: z
      .string()
      .default("public")
      .describe("Schema name (default: public)"),
  },
  async ({ database, schema }) => {
    try {
      const result = await withPool(database, (client) =>
        client.query(
          `SELECT t.tablename AS table_name,
                  COALESCE(s.n_live_tup, 0) AS estimated_rows
           FROM pg_tables t
           LEFT JOIN pg_stat_user_tables s
             ON s.schemaname = t.schemaname AND s.relname = t.tablename
           WHERE t.schemaname = $1
           ORDER BY t.tablename`,
          [schema]
        )
      );

      if (result.rows.length === 0) {
        return {
          content: [
            { type: "text", text: `No tables found in schema "${schema}".` },
          ],
        };
      }

      const lines = result.rows.map(
        (r) => `- ${r.table_name} (~${r.estimated_rows} rows)`
      );
      return {
        content: [
          {
            type: "text",
            text: `Tables in "${schema}" (${result.rows.length}):\n${lines.join("\n")}`,
          },
        ],
      };
    } catch (e) {
      return errorResult(e);
    }
  }
);

// Tool 4: Describe table (with indexes)
server.tool(
  "pg_describe_table",
  "Describe columns, types, constraints, and indexes of a PostgreSQL table",
  {
    database: z.string().describe("Database label from config"),
    table: z.string().describe("Table name"),
    schema: z
      .string()
      .default("public")
      .describe("Schema name (default: public)"),
  },
  async ({ database, table, schema }) => {
    try {
      const result = await withPool(database, async (client) => {
        const colsQuery = `
          SELECT c.column_name, c.data_type, c.character_maximum_length,
                 c.is_nullable, c.column_default,
                 CASE WHEN pk.column_name IS NOT NULL THEN 'YES' ELSE 'NO' END AS is_pk
          FROM information_schema.columns c
          LEFT JOIN (
            SELECT kcu.column_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name = kcu.constraint_name
              AND tc.table_schema = kcu.table_schema
            WHERE tc.constraint_type = 'PRIMARY KEY'
              AND tc.table_schema = $1 AND tc.table_name = $2
          ) pk ON pk.column_name = c.column_name
          WHERE c.table_schema = $1 AND c.table_name = $2
          ORDER BY c.ordinal_position`;

        const fkQuery = `
          SELECT kcu.column_name,
                 ccu.table_schema AS fk_schema,
                 ccu.table_name AS fk_table,
                 ccu.column_name AS fk_column
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
            AND tc.table_schema = kcu.table_schema
          JOIN information_schema.constraint_column_usage ccu
            ON tc.constraint_name = ccu.constraint_name
            AND tc.table_schema = ccu.table_schema
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND tc.table_schema = $1 AND tc.table_name = $2`;

        const idxQuery = `
          SELECT indexname, indexdef
          FROM pg_indexes
          WHERE schemaname = $1 AND tablename = $2
          ORDER BY indexname`;

        const [cols, fks, idxs] = await Promise.all([
          client.query(colsQuery, [schema, table]),
          client.query(fkQuery, [schema, table]),
          client.query(idxQuery, [schema, table]),
        ]);
        return { cols, fks, idxs };
      });

      if (result.cols.rows.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `Table "${schema}"."${table}" not found or has no columns.`,
            },
          ],
        };
      }

      const fkMap = new Map<string, string>();
      for (const fk of result.fks.rows) {
        fkMap.set(
          fk.column_name,
          `-> ${fk.fk_schema}.${fk.fk_table}(${fk.fk_column})`
        );
      }

      const colLines = result.cols.rows.map((col) => {
        let type = col.data_type;
        if (col.character_maximum_length)
          type += `(${col.character_maximum_length})`;
        const parts = [`  ${col.column_name}: ${type}`];
        if (col.is_pk === "YES") parts.push("[PK]");
        if (col.is_nullable === "NO") parts.push("NOT NULL");
        if (col.column_default) parts.push(`DEFAULT ${col.column_default}`);
        if (fkMap.has(col.column_name))
          parts.push(`[FK ${fkMap.get(col.column_name)}]`);
        return parts.join(" ");
      });

      let text = `Table "${schema}"."${table}" (${result.cols.rows.length} columns):\n${colLines.join("\n")}`;

      if (result.idxs.rows.length > 0) {
        const idxLines = result.idxs.rows.map(
          (idx) => `  ${idx.indexname}: ${idx.indexdef}`
        );
        text += `\n\nIndexes (${result.idxs.rows.length}):\n${idxLines.join("\n")}`;
      }

      return { content: [{ type: "text", text }] };
    } catch (e) {
      return errorResult(e);
    }
  }
);

// Tool 5: List schemas
server.tool(
  "pg_list_schemas",
  "List all schemas in a PostgreSQL database",
  {
    database: z.string().describe("Database label from config"),
  },
  async ({ database }) => {
    try {
      const result = await withPool(database, (client) =>
        client.query(
          `SELECT schema_name,
                  (SELECT count(*) FROM information_schema.tables t
                   WHERE t.table_schema = s.schema_name) AS table_count
           FROM information_schema.schemata s
           ORDER BY schema_name`
        )
      );

      const lines = result.rows.map(
        (r) => `- ${r.schema_name} (${r.table_count} tables)`
      );
      return {
        content: [
          {
            type: "text",
            text: `Schemas (${result.rows.length}):\n${lines.join("\n")}`,
          },
        ],
      };
    } catch (e) {
      return errorResult(e);
    }
  }
);

// Tool 6: Health check
server.tool(
  "pg_health_check",
  "Test database connectivity and return PostgreSQL version and response latency",
  {
    database: z.string().describe("Database label from config"),
  },
  async ({ database }) => {
    try {
      const start = Date.now();
      const result = await withPool(database, (client) =>
        client.query("SELECT version() AS version, now() AS server_time")
      );
      const latencyMs = Date.now() - start;

      const row = result.rows[0];
      return {
        content: [
          {
            type: "text",
            text: [
              `Database: ${database}`,
              `Status: connected`,
              `Latency: ${latencyMs}ms`,
              `Version: ${row.version}`,
              `Server time: ${row.server_time}`,
            ].join("\n"),
          },
        ],
      };
    } catch (e) {
      return errorResult(e);
    }
  }
);

// Tool 7: Explain query
server.tool(
  "pg_explain",
  "Run EXPLAIN ANALYZE on a query and return the execution plan. The query is always rolled back to prevent side effects.",
  {
    database: z.string().describe("Database label from config"),
    query: z.string().describe("SQL query to analyze"),
    params: z
      .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .optional()
      .describe("Optional query parameters for $1, $2, ... placeholders"),
  },
  async ({ database, query, params }) => {
    try {
      if (!isSingleStatement(query)) {
        return {
          content: [
            {
              type: "text",
              text: "Error: Multi-statement queries are not allowed.",
            },
          ],
          isError: true,
        };
      }

      const explainQuery = `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${query}`;
      const result = await withPool(database, async (client) => {
        await client.query("BEGIN");
        try {
          const res = params
            ? await client.query(explainQuery, params)
            : await client.query(explainQuery);
          return res;
        } finally {
          // Always rollback — EXPLAIN ANALYZE executes the query
          await client.query("ROLLBACK").catch(() => {});
        }
      });

      const plan = result.rows.map((r) => r["QUERY PLAN"]).join("\n");
      return {
        content: [{ type: "text", text: plan }],
      };
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ─── Graceful Shutdown ───────────────────────────────────────────

async function shutdown() {
  console.error("Shutting down — draining connection pools...");
  await drainAllPools();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// ─── Config Permission Check ─────────────────────────────────────

async function checkConfigPermissions(): Promise<void> {
  if (platform() === "win32") return; // Skip on Windows — no Unix-style permissions

  try {
    const s = await stat(CONFIG_PATH);
    const mode = s.mode & 0o777;
    // Warn if group or others can read (anything beyond owner-only)
    if (mode & 0o077) {
      console.error(
        `Warning: Config file ${CONFIG_PATH} has permissions ${mode.toString(8)}. ` +
          `Consider restricting with: chmod 600 ${CONFIG_PATH}`
      );
    }
  } catch {
    // File doesn't exist yet or can't stat — skip
  }
}

// ─── Start ───────────────────────────────────────────────────────

async function main() {
  await checkConfigPermissions();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const mode = LABEL_FILTER ? `label="${LABEL_FILTER}"` : "all databases";
  console.error(`mcp-postgres started (${mode}) | config: ${CONFIG_PATH}`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
