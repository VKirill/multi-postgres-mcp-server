import { describe, it, expect } from "vitest";
import { isSingleStatement } from "../index.js";

describe("isSingleStatement", () => {
  // ─── Single statements (should return TRUE = safe) ──────────────

  describe("returns true for safe single statements", () => {
    it("simple SELECT", () => {
      expect(isSingleStatement("SELECT * FROM users")).toBe(true);
    });

    it("SELECT with WHERE clause", () => {
      expect(isSingleStatement("SELECT id FROM users WHERE name = 'test'")).toBe(true);
    });

    it("trailing semicolon (no content after it)", () => {
      expect(isSingleStatement("SELECT 1;")).toBe(true);
    });

    it("trailing semicolon with whitespace after", () => {
      expect(isSingleStatement("SELECT 1;   ")).toBe(true);
    });

    it("empty string", () => {
      expect(isSingleStatement("")).toBe(true);
    });

    it("complex query with JOIN", () => {
      expect(
        isSingleStatement(
          "SELECT u.id, p.title FROM users u JOIN posts p ON u.id = p.user_id WHERE u.active = true"
        )
      ).toBe(true);
    });

    it("INSERT statement", () => {
      expect(
        isSingleStatement("INSERT INTO users (name, email) VALUES ('John', 'john@example.com')")
      ).toBe(true);
    });

    it("UPDATE statement", () => {
      expect(
        isSingleStatement("UPDATE users SET name = 'Jane' WHERE id = 1")
      ).toBe(true);
    });

    it("DELETE statement", () => {
      expect(isSingleStatement("DELETE FROM users WHERE id = 1")).toBe(true);
    });
  });

  // ─── Semicolons inside string literals ────────────────────────────

  describe("ignores semicolons inside single-quoted strings", () => {
    it("semicolon in single-quoted value", () => {
      expect(isSingleStatement("SELECT * FROM users WHERE name = 'foo;bar'")).toBe(true);
    });

    it("multiple semicolons inside single-quoted string", () => {
      expect(isSingleStatement("SELECT * FROM t WHERE x = 'a;b;c;d'")).toBe(true);
    });

    it("escaped single quotes (SQL double-quote escape)", () => {
      expect(isSingleStatement("SELECT * FROM users WHERE name = 'O''Brien'")).toBe(true);
    });

    it("escaped quote followed by semicolon inside string", () => {
      expect(isSingleStatement("SELECT * FROM t WHERE x = 'it''s;here'")).toBe(true);
    });
  });

  // ─── Semicolons inside double-quoted identifiers ──────────────────

  describe("ignores semicolons inside double-quoted identifiers", () => {
    it("semicolon in double-quoted column name", () => {
      expect(isSingleStatement('SELECT "col;name" FROM users')).toBe(true);
    });

    it("semicolon in double-quoted table name", () => {
      expect(isSingleStatement('SELECT * FROM "my;table"')).toBe(true);
    });
  });

  // ─── Semicolons inside comments ───────────────────────────────────

  describe("ignores semicolons inside comments", () => {
    it("semicolon in single-line comment (--)", () => {
      expect(isSingleStatement("SELECT 1 -- ; DROP TABLE users")).toBe(true);
    });

    it("semicolon in block comment (/* */)", () => {
      expect(isSingleStatement("SELECT /* ; */ 1")).toBe(true);
    });

    it("block comment with multiple semicolons", () => {
      expect(isSingleStatement("SELECT /* ;; ;; */ 1")).toBe(true);
    });

    it("unclosed block comment (treated as single statement)", () => {
      expect(isSingleStatement("SELECT 1 /* ; unclosed")).toBe(true);
    });

    it("unclosed single-line comment at end of input", () => {
      expect(isSingleStatement("SELECT 1 -- this is fine")).toBe(true);
    });
  });

  // ─── Semicolons inside dollar-quoted strings ──────────────────────

  describe("ignores semicolons inside dollar-quoted strings", () => {
    it("semicolon in untagged dollar-quote ($$...$$)", () => {
      expect(isSingleStatement("SELECT $$foo;bar$$")).toBe(true);
    });

    it("semicolon in tagged dollar-quote ($tag$...$tag$)", () => {
      expect(isSingleStatement("SELECT $tag$foo;bar$tag$")).toBe(true);
    });

    it("multiple semicolons in dollar-quoted body", () => {
      expect(isSingleStatement("SELECT $fn$BEGIN; RETURN 1; END;$fn$")).toBe(true);
    });

    it("unclosed dollar-quoted string (treated as single statement)", () => {
      expect(isSingleStatement("SELECT $$foo;bar")).toBe(true);
    });
  });

  // ─── Multi-statement SQL (should return FALSE = dangerous) ────────

  describe("returns false for multi-statement SQL (injection attempts)", () => {
    it("classic SQL injection: SELECT then DROP", () => {
      expect(isSingleStatement("SELECT 1; DROP TABLE users")).toBe(false);
    });

    it("COMMIT injection with CASCADE", () => {
      expect(isSingleStatement("COMMIT; DROP SCHEMA public CASCADE; --")).toBe(false);
    });

    it("two SELECT statements", () => {
      expect(isSingleStatement("SELECT 1; SELECT 2")).toBe(false);
    });

    it("injection after comment trick (newline after --)", () => {
      expect(isSingleStatement("SELECT 1; -- comment\nDROP TABLE users")).toBe(false);
    });

    it("whitespace between statements", () => {
      expect(isSingleStatement("SELECT 1;   SELECT 2")).toBe(false);
    });

    it("semicolon with tab then next statement", () => {
      expect(isSingleStatement("SELECT 1;\tSELECT 2")).toBe(false);
    });

    it("semicolon with newline then next statement", () => {
      expect(isSingleStatement("SELECT 1;\nSELECT 2")).toBe(false);
    });

    it("three statements chained", () => {
      expect(isSingleStatement("SELECT 1; SELECT 2; SELECT 3")).toBe(false);
    });

    it("INSERT then DELETE", () => {
      expect(
        isSingleStatement("INSERT INTO t VALUES (1); DELETE FROM t WHERE id = 1")
      ).toBe(false);
    });
  });

  // ─── Edge cases ───────────────────────────────────────────────────

  describe("edge cases", () => {
    it("only whitespace", () => {
      expect(isSingleStatement("   ")).toBe(true);
    });

    it("only a semicolon", () => {
      expect(isSingleStatement(";")).toBe(true);
    });

    it("semicolon followed by only whitespace and newline", () => {
      expect(isSingleStatement(";\n  \t  ")).toBe(true);
    });

    it("multiple trailing semicolons with no content between", () => {
      // ";;" has a second semicolon after the first — the rest is ";" which is non-empty
      // but is itself just a semicolon with nothing after it
      // Let's check what the function does: after first ;, rest = ";", trim => ";"
      // length > 0 => returns false
      expect(isSingleStatement(";;")).toBe(false);
    });

    it("dollar sign not starting a dollar-quote", () => {
      expect(isSingleStatement("SELECT $1")).toBe(true);
    });

    it("dollar sign as parameter placeholder is not a quote", () => {
      expect(isSingleStatement("SELECT * FROM t WHERE id = $1 AND name = $2")).toBe(true);
    });

    it("mixed: safe content with all quote types", () => {
      expect(
        isSingleStatement(
          `SELECT 'semi;colon', "col;name", $$body;here$$ FROM t -- trailing; comment`
        )
      ).toBe(true);
    });

    it("semicolon after closing all quoted contexts is still detected", () => {
      expect(isSingleStatement("SELECT 'safe;string'; DROP TABLE users")).toBe(false);
    });

    it("semicolon after dollar-quoted string is still detected", () => {
      expect(isSingleStatement("SELECT $$safe;body$$; DROP TABLE users")).toBe(false);
    });

    it("semicolon after block comment is still detected", () => {
      expect(isSingleStatement("SELECT /* comment */ 1; DROP TABLE users")).toBe(false);
    });
  });
});
