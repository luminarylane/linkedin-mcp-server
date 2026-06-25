# Contributing to LinkedIn MCP Server

Thank you for your interest in contributing! This guide will help you get started.

## Development Setup

### Prerequisites

- Node.js 18+
- npm 9+
- Git

### Installation

```bash
git clone https://github.com/luminarylane/linkedin-mcp-server.git
cd linkedin-mcp-server
npm install
```

### Environment Setup

```bash
cp .env.example .env
# Add your LinkedIn access token to .env
```

## Development Workflow

### 1. Create an Issue

Before starting work, create or find an issue describing the feature or bug.

### 2. Create a Branch

```bash
gh issue develop <issue-number> --checkout
# Or manually:
git checkout -b feat/<issue-number>-description
```

### 3. Make Changes

Follow the existing TypeScript code style and conventions.

### 4. Test Locally

```bash
# Type check
npx tsc --noEmit

# Run tests
npm test

# Format code
npx prettier --write .

# Run all checks
make check
```

### 5. Commit and Push

```bash
git add src/
git commit -m "feat(#123): description"
git push origin your-branch-name
```

### 6. Create a PR

```bash
gh pr create --title "Fix #<issue>: Description" --body "Details..."
```

## Code Style

- **Formatter**: Prettier
- **Type checker**: TypeScript strict mode
- **Commits**: Conventional commits — `feat:`, `fix:`, `chore:`, `docs:`
- **No comments** unless the WHY is non-obvious

## Testing

Tests live in `src/*.test.ts` alongside the source files.

```bash
# Run all tests
npm test

# Watch mode
npx vitest

# Run a specific file
npx vitest src/rate-limiter.test.ts
```

## Pull Request Process

1. `npx tsc --noEmit` passes
2. `npm test` passes
3. `npx prettier --check .` passes
4. PR description explains what changed and why
5. Link to issue with `Closes #123`

## Project Structure

```
linkedin-mcp-server/
├── src/
│   ├── index.ts              # MCP server + all tool definitions
│   ├── client.ts             # LinkedIn API client + upload helpers
│   ├── rate-limiter.ts       # Token-bucket rate limiter + retry logic
│   ├── rate-limiter.test.ts
│   ├── response.ts           # MCP response helpers
│   └── response.test.ts
├── .github/
│   └── workflows/            # CI/CD workflows
├── .claude-plugin/           # Claude Code plugin definition
├── package.json
├── tsconfig.json
└── Makefile
```

## Getting Help

- Check [existing issues](https://github.com/luminarylane/linkedin-mcp-server/issues)
- Read the [README](README.md)
- Ask in PR comments
