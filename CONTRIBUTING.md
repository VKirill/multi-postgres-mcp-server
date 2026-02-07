# Contributing to multi-postgres-mcp-server

Thank you for your interest in contributing! This document provides guidelines
and instructions for contributing to the project.

## Table of Contents

- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Development Workflow](#development-workflow)
- [Code Style](#code-style)
- [Testing](#testing)
- [Pull Requests](#pull-requests)
- [Reporting Issues](#reporting-issues)

---

## Development Setup

### Prerequisites

- **Node.js** >= 18
- **npm** >= 9
- **PostgreSQL** (for integration testing)

### Getting Started

1. Clone the repository:
   ```bash
   git clone https://github.com/VKirill/multi-postgres-mcp-server.git
   cd multi-postgres-mcp-server
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the project:
   ```bash
   npm run build
   ```

4. Run in development mode (with auto-reload):
   ```bash
   npm run dev
   ```

## Project Structure

```
├── src/
│   ├── index.ts              # Main MCP server implementation
│   └── __tests__/
│       └── index.test.ts     # Test suite
├── dist/                     # Compiled JavaScript (generated)
├── config.example.json       # Example configuration
├── tsconfig.json             # TypeScript configuration
├── vitest.config.ts          # Test configuration
├── eslint.config.js          # ESLint configuration
├── .prettierrc               # Prettier configuration
├── Dockerfile                # Container image
└── .github/
    └── workflows/
        └── ci.yml            # GitHub Actions CI/CD
```

## Development Workflow

1. Create a feature branch from `master`:
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. Make your changes in `src/index.ts`

3. Run the linter:
   ```bash
   npm run lint
   ```

4. Run tests:
   ```bash
   npm test
   ```

5. Build to verify compilation:
   ```bash
   npm run build
   ```

6. Commit and push your changes

## Code Style

This project uses **ESLint** and **Prettier** for consistent code formatting.

- **TypeScript** strict mode is enabled
- **ES modules** (`"type": "module"` in package.json)
- **Single file architecture**: The main server logic is in `src/index.ts`
- Follow existing patterns for new MCP tools

### Formatting

```bash
# Check formatting
npx prettier --check "src/**/*.ts"

# Fix formatting
npx prettier --write "src/**/*.ts"
```

## Testing

Tests are written with [vitest](https://vitest.dev/) and located in `src/__tests__/`.

```bash
# Run tests once
npm test

# Run tests in watch mode
npm run test:watch
```

### Writing Tests

- Test pure functions (like `isSingleStatement()`) thoroughly
- Cover edge cases: empty strings, Unicode, nested quotes, etc.
- Group related tests with `describe()` blocks
- Use descriptive test names

## Pull Requests

1. **Keep PRs focused**: One feature or fix per PR
2. **Include tests**: Add tests for new functionality
3. **Update docs**: Update README.md if adding new features or changing behavior
4. **Describe changes**: Write a clear PR description explaining what and why

### PR Checklist

- [ ] Code compiles without errors (`npm run build`)
- [ ] All tests pass (`npm test`)
- [ ] Linter passes (`npm run lint`)
- [ ] New features have tests
- [ ] README updated (if applicable)
- [ ] CHANGELOG.md updated

## Reporting Issues

When reporting issues, please include:

1. **Node.js version** (`node -v`)
2. **OS and version**
3. **Steps to reproduce**
4. **Expected behavior**
5. **Actual behavior**
6. **Error messages** (if any)

For security vulnerabilities, see [SECURITY.md](SECURITY.md).

---

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE).
