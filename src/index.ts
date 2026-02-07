#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import pg from "pg";
import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";

// ─── CLI args & env ───────────────────────────────────────────────

const HOME = process.env.USERPROFILE || process.env.HOME || "";

function getArg(name: string): string | null {
  const idx = process.argv.indexOf(name);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : null;
}

/** --config <path>  or  MCP_POSTGRES_CONFIG env  or  default */
const CONFIG_PATH = resolve(
  getArg("--config") ||
    process.env.MCP_POSTGRES_CONFIG ||
    join(HOME, ".mcp-postgres", "config.json")
);

/** --label <name>  — if set, only this database is visible */
const LABEL_FILTER = getArg("--label");

// ─── Types ────────────────────────────────────────────────────────

interface DbConnection {
  label: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  enabled?: boolean;
}

interface DbConfig {
  connections: DbConnection[] | Record<string, DbConnection>;
}

// ─── Config ───────────────────────────────────────────────────────

function loadConfig(): DbConnection[] {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const config = JSON.parse(raw) as DbConfig;

    // Support both array and object formats
    let connections: DbConnection[];
    if (Array.isArray(config.connections)) {
      connections = config.connections;
    } else {
      connections = Object.values(config.connections || {});
    }

    // Filter enabled only
    connections = connections.filter((c) => c.enabled !== false);

    // Apply --label filter
    if (LABEL_FILTER) {
      connections = connections.filter((c) => c.label === LABEL_FILTER);
    }

    return connections;
  } catch (e) {
    if (!existsSync(CONFIG_PATH)) {
      console.error(`Config not found: ${CONFIG_PATH}`);
      console.error("Create it with your database connections. See README for format.");
    } else {
      console.error(`Failed to read config: ${CONFIG_PATH}`, e);
    }
    return [];
  }
}

function getConnection(label: string): DbConnection {
  const connections = loadConfig();
  const conn = connections.find((c) => c.label === label);
  if (!conn) {
    const available = connections.map((c) => c.label).join(", ") || "(none)";
    throw new Error(`Database "${label}" not found. Available: ${available}`);
  }
  return conn;
}

async function withClient<T>(
  label: string,
  fn: (client: pg.Client) => Promise<T>
): Promise<T> {
  const conn = getConnection(label);
  const client = new pg.Client({
    host: conn.host,
    port: conn.port,
    user: conn.user,
    password: conn.password,
    database: conn.database,
    connectionTimeoutMillis: 10000,
    statement_timeout: 30000,
  });

  try {
    await client.connect();
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

// ─── MCP Server ───────────────────────────────────────────────────

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
    const connections = loadConfig();
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

    const lines = connections.map(
      (c) => `- ${c.label}: ${c.user}@${c.host}:${c.port}/${c.database}`
    );
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

// Tool 2: Execute read-only SQL
server.tool(
  "pg_query",
  "Execute a read-only SQL query against a PostgreSQL database",
  {
    database: z.string().describe("Database label from config"),
    query: z.string().describe("SQL query to execute (read-only)"),
  },
  async ({ database, query }) => {
    try {
      const result = await withClient(database, async (client) => {
        await client.query("BEGIN TRANSACTION READ ONLY");
        try {
          const res = await client.query(query);
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
              text: `Query executed. ${result.rowCount ?? 0} row(s). No rows returned.`,
            },
          ],
        };
      }

      const columns = result.fields.map((f) => f.name);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { columns, rows: result.rows, rowCount: result.rowCount },
              null,
              2
            ),
          },
        ],
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
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
      const result = await withClient(database, async (client) => {
        return client.query(
          `SELECT t.tablename AS table_name,
                  COALESCE(s.n_live_tup, 0) AS estimated_rows
           FROM pg_tables t
           LEFT JOIN pg_stat_user_tables s
             ON s.schemaname = t.schemaname AND s.relname = t.tablename
           WHERE t.schemaname = $1
           ORDER BY t.tablename`,
          [schema]
        );
      });

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
      const msg = e instanceof Error ? e.message : String(e);
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
    }
  }
);

// Tool 4: Describe table
server.tool(
  "pg_describe_table",
  "Describe columns, types, and constraints of a PostgreSQL table",
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
      const result = await withClient(database, async (client) => {
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

        const [cols, fks] = await Promise.all([
          client.query(colsQuery, [schema, table]),
          client.query(fkQuery, [schema, table]),
        ]);
        return { cols, fks };
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
        fkMap.set(fk.column_name, `-> ${fk.fk_schema}.${fk.fk_table}(${fk.fk_column})`);
      }

      const lines = result.cols.rows.map((col) => {
        let type = col.data_type;
        if (col.character_maximum_length) type += `(${col.character_maximum_length})`;
        const parts = [`  ${col.column_name}: ${type}`];
        if (col.is_pk === "YES") parts.push("[PK]");
        if (col.is_nullable === "NO") parts.push("NOT NULL");
        if (col.column_default) parts.push(`DEFAULT ${col.column_default}`);
        if (fkMap.has(col.column_name)) parts.push(`[FK ${fkMap.get(col.column_name)}]`);
        return parts.join(" ");
      });

      return {
        content: [
          {
            type: "text",
            text: `Table "${schema}"."${table}" (${result.cols.rows.length} columns):\n${lines.join("\n")}`,
          },
        ],
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
    }
  }
);

// ─── Start ────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const mode = LABEL_FILTER ? `label="${LABEL_FILTER}"` : "all databases";
  console.error(`mcp-postgres started (${mode}) | config: ${CONFIG_PATH}`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
