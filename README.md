# mcp-postgres

**One MCP server for all your PostgreSQL databases.**

[English](#english) | [Русский](#русский) | [中文](#中文)

---

## English

### Why?

The official `@modelcontextprotocol/server-postgres` supports only **one database per server instance**. If you have 5 projects with 5 databases, you need 5 separate MCP server processes.

**mcp-postgres** solves this:
- **One server** serves all your databases
- **One config file** with all connections
- **Hot reload** — add a database to config, it's immediately available (no restart)
- **`--label` filter** — restrict access to a single database per project (isolation)
- **Read-only** — all queries run inside `BEGIN TRANSACTION READ ONLY` (safety)

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    config.json                           │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐              │
│  │ staging  │  │production│  │  local   │  ...          │
│  └──────────┘  └──────────┘  └──────────┘              │
└──────────────────────┬──────────────────────────────────┘
                       │ reads on every call
                       ▼
              ┌─────────────────┐
              │  mcp-postgres   │  ← single MCP server process
              │  (stdio)        │
              └────────┬────────┘
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
    ┌──────────┐ ┌──────────┐ ┌──────────┐
    │Claude Code│ │  Cursor  │ │ Any MCP  │
    │(all DBs) │ │(filtered)│ │ client   │
    └──────────┘ └──────────┘ └──────────┘
```

### Tools

| Tool | Parameters | Description |
|---|---|---|
| `pg_list_databases` | — | List all available databases |
| `pg_query` | `database`, `query` | Execute read-only SQL query |
| `pg_list_tables` | `database`, `schema?` | List tables with row counts |
| `pg_describe_table` | `database`, `table`, `schema?` | Column types, PK, FK, defaults |

### Installation

```bash
git clone https://github.com/VKirill/mcp-postgres.git
cd mcp-postgres
npm install
npm run build
```

Or install globally:
```bash
npm install -g mcp-postgres-multi
```

### Configuration

Create `~/.mcp-postgres/config.json`:

```json
{
  "connections": [
    {
      "label": "production",
      "host": "db.example.com",
      "port": 5432,
      "user": "readonly_user",
      "password": "secret",
      "database": "myapp",
      "enabled": true
    },
    {
      "label": "staging",
      "host": "localhost",
      "port": 5432,
      "user": "dev",
      "password": "dev123",
      "database": "myapp_staging",
      "enabled": true
    }
  ]
}
```

You can also use an object format (keyed by any identifier):

```json
{
  "connections": {
    "project-a": {
      "label": "production",
      "host": "db.example.com",
      ...
    }
  }
}
```

### Custom config path

```bash
# Via CLI argument
node dist/index.js --config /path/to/my-config.json

# Via environment variable
MCP_POSTGRES_CONFIG=/path/to/config.json node dist/index.js
```

### Usage with Claude Code

Add to `~/.claude.json` → `mcpServers`:

```json
{
  "mcpServers": {
    "postgres": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/mcp-postgres/dist/index.js"]
    }
  }
}
```

All databases from config are available. The AI can call `pg_list_databases` to see them and `pg_query` with any `database` label.

### Usage with Cursor (per-project isolation)

Create `.cursor/mcp.json` **in each project folder**:

```json
{
  "mcpServers": {
    "postgres": {
      "command": "node",
      "args": [
        "/path/to/mcp-postgres/dist/index.js",
        "--label",
        "production"
      ]
    }
  }
}
```

With `--label production`, the server only exposes the `production` database. The AI doesn't see other databases and can query directly without choosing.

### Usage with npx (no installation)

```json
{
  "mcpServers": {
    "postgres": {
      "command": "npx",
      "args": ["-y", "mcp-postgres-multi"]
    }
  }
}
```

### Example session

```
User: Show me all tables in the production database

AI calls: pg_list_tables(database="production")
→ Tables in "public" (12):
  - users (~45000 rows)
  - orders (~128000 rows)
  - products (~3200 rows)
  ...

User: What does the users table look like?

AI calls: pg_describe_table(database="production", table="users")
→ Table "public"."users" (8 columns):
    id: integer [PK] NOT NULL DEFAULT nextval('users_id_seq')
    email: character varying(255) NOT NULL
    name: character varying(100)
    created_at: timestamp with time zone DEFAULT now()
    ...
```

### Security

- All queries execute inside `READ ONLY` transactions
- Write operations (`INSERT`, `UPDATE`, `DELETE`, `DROP`) will fail
- Connection timeout: 10 seconds
- Query timeout: 30 seconds
- Config file with passwords is excluded from git via `.gitignore`
- Use `--label` to prevent AI from accessing unrelated databases

---

## Русский

### Зачем?

Официальный `@modelcontextprotocol/server-postgres` поддерживает только **одну БД на сервер**. Если у вас 5 проектов с 5 базами — нужно 5 отдельных процессов MCP-сервера.

**mcp-postgres** решает это:
- **Один сервер** обслуживает все БД
- **Один конфиг** со всеми подключениями
- **Hot reload** — добавил БД в конфиг, она сразу доступна (без рестарта)
- **Фильтр `--label`** — ограничивает доступ одной БД для проекта (изоляция)
- **Только чтение** — все запросы в `BEGIN TRANSACTION READ ONLY` (безопасность)

### Архитектура

```
┌─────────────────────────────────────────────────────────┐
│                    config.json                           │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐              │
│  │ staging  │  │production│  │  local   │  ...          │
│  └──────────┘  └──────────┘  └──────────┘              │
└──────────────────────┬──────────────────────────────────┘
                       │ читает при каждом вызове
                       ▼
              ┌─────────────────┐
              │  mcp-postgres   │  ← один процесс MCP-сервера
              │  (stdio)        │
              └────────┬────────┘
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
    ┌──────────┐ ┌──────────┐ ┌──────────┐
    │Claude Code│ │  Cursor  │ │Любой MCP │
    │(все БД)  │ │(фильтр)  │ │ клиент   │
    └──────────┘ └──────────┘ └──────────┘
```

### Инструменты

| Инструмент | Параметры | Описание |
|---|---|---|
| `pg_list_databases` | — | Список доступных БД |
| `pg_query` | `database`, `query` | Read-only SQL запрос |
| `pg_list_tables` | `database`, `schema?` | Таблицы с количеством строк |
| `pg_describe_table` | `database`, `table`, `schema?` | Колонки, типы, PK, FK, defaults |

### Установка

```bash
git clone https://github.com/VKirill/mcp-postgres.git
cd mcp-postgres
npm install
npm run build
```

Или глобально:
```bash
npm install -g mcp-postgres-multi
```

### Конфигурация

Создайте `~/.mcp-postgres/config.json`:

```json
{
  "connections": [
    {
      "label": "production",
      "host": "db.example.com",
      "port": 5432,
      "user": "readonly_user",
      "password": "secret",
      "database": "myapp",
      "enabled": true
    }
  ]
}
```

Путь к конфигу можно задать:
```bash
node dist/index.js --config /path/to/config.json
# или
MCP_POSTGRES_CONFIG=/path/to/config.json node dist/index.js
```

### Claude Code (глобально, все БД)

В `~/.claude.json` → `mcpServers`:

```json
{
  "mcpServers": {
    "postgres": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/mcp-postgres/dist/index.js"]
    }
  }
}
```

### Cursor (изоляция по проектам)

В каждой папке проекта создайте `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "postgres": {
      "command": "node",
      "args": [
        "/path/to/mcp-postgres/dist/index.js",
        "--label",
        "production"
      ]
    }
  }
}
```

С `--label production` сервер видит только БД `production`. ИИ не знает про другие базы и может сразу делать запросы без выбора.

### Безопасность

- Все запросы выполняются в `READ ONLY` транзакциях
- Операции записи (`INSERT`, `UPDATE`, `DELETE`, `DROP`) завершатся ошибкой
- Таймаут подключения: 10 сек, таймаут запроса: 30 сек
- Конфиг с паролями исключён из git через `.gitignore`
- `--label` не даёт ИИ видеть чужие базы данных

---

## 中文

### 为什么需要？

官方 `@modelcontextprotocol/server-postgres` 每个服务器实例只支持**一个数据库**。如果你有5个项目对应5个数据库，就需要5个独立的MCP服务器进程。

**mcp-postgres** 解决了这个问题：
- **一个服务器**管理所有数据库
- **一个配置文件**包含所有连接
- **热重载** — 在配置中添加数据库，立即可用（无需重启）
- **`--label` 过滤器** — 限制项目只能访问单个数据库（隔离）
- **只读模式** — 所有查询在 `BEGIN TRANSACTION READ ONLY` 中执行（安全）

### 架构

```
┌─────────────────────────────────────────────────────────┐
│                    config.json                           │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐              │
│  │ staging  │  │production│  │  local   │  ...          │
│  └──────────┘  └──────────┘  └──────────┘              │
└──────────────────────┬──────────────────────────────────┘
                       │ 每次调用时读取
                       ▼
              ┌─────────────────┐
              │  mcp-postgres   │  ← 单个MCP服务器进程
              │  (stdio)        │
              └────────┬────────┘
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
    ┌──────────┐ ┌──────────┐ ┌──────────┐
    │Claude Code│ │  Cursor  │ │任意 MCP  │
    │(所有数据库)│ │(已过滤)  │ │ 客户端   │
    └──────────┘ └──────────┘ └──────────┘
```

### 工具

| 工具 | 参数 | 描述 |
|---|---|---|
| `pg_list_databases` | — | 列出所有可用数据库 |
| `pg_query` | `database`, `query` | 执行只读SQL查询 |
| `pg_list_tables` | `database`, `schema?` | 列出表及行数估计 |
| `pg_describe_table` | `database`, `table`, `schema?` | 列类型、主键、外键、默认值 |

### 安装

```bash
git clone https://github.com/VKirill/mcp-postgres.git
cd mcp-postgres
npm install
npm run build
```

或全局安装：
```bash
npm install -g mcp-postgres-multi
```

### 配置

创建 `~/.mcp-postgres/config.json`：

```json
{
  "connections": [
    {
      "label": "production",
      "host": "db.example.com",
      "port": 5432,
      "user": "readonly_user",
      "password": "secret",
      "database": "myapp",
      "enabled": true
    }
  ]
}
```

自定义配置路径：
```bash
node dist/index.js --config /path/to/config.json
# 或
MCP_POSTGRES_CONFIG=/path/to/config.json node dist/index.js
```

### Claude Code（全局，所有数据库）

在 `~/.claude.json` → `mcpServers` 中添加：

```json
{
  "mcpServers": {
    "postgres": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/mcp-postgres/dist/index.js"]
    }
  }
}
```

### Cursor（按项目隔离）

在每个项目文件夹中创建 `.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "postgres": {
      "command": "node",
      "args": [
        "/path/to/mcp-postgres/dist/index.js",
        "--label",
        "production"
      ]
    }
  }
}
```

使用 `--label production` 后，服务器只暴露 `production` 数据库。AI看不到其他数据库，可以直接查询无需选择。

### 安全性

- 所有查询在 `READ ONLY` 事务中执行
- 写操作（`INSERT`、`UPDATE`、`DELETE`、`DROP`）会失败
- 连接超时：10秒，查询超时：30秒
- 包含密码的配置文件通过 `.gitignore` 排除在git之外
- `--label` 防止AI访问无关数据库

---

## License

MIT
