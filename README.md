# 💼 LinkedIn MCP Server

[![CI](https://github.com/luminarylane/linkedin-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/luminarylane/linkedin-mcp-server/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/linkedin-mcp-server)](https://www.npmjs.com/package/linkedin-mcp-server)
[![MCP](https://img.shields.io/badge/MCP-1.0-blue)](https://modelcontextprotocol.io)
[![GitHub Release](https://img.shields.io/github/v/release/luminarylane/linkedin-mcp-server)](https://github.com/luminarylane/linkedin-mcp-server/releases)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green)](https://nodejs.org)
[![License](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)

A Model Context Protocol (MCP) server that enables Claude Desktop (and other MCP clients) to interact with LinkedIn — publish posts, upload media, comment, react, and analyse your organisation's performance.

## ✨ Features

### 🔐 Authentication

- **OAuth 2.0 Bearer Token** — Single `LINKEDIN_ACCESS_TOKEN` for all operations
- **Per-call credentials** — Pass `accessToken` as a tool argument for multi-account setups
- **Optional org context** — Set `LINKEDIN_ORG_ID` once for all organisation analytics tools

### 📝 Rich Content Publishing

- **Text posts** — Up to 3,000 characters with optional hashtags
- **Image posts** — JPG/PNG/GIF up to 10 MB, uploaded directly from URL
- **Video posts** — MP4/MOV up to 200 MB, uploaded directly from URL
- **Document / carousel posts** — PDF up to 100 MB; renders as a swipeable carousel on LinkedIn
- **Link preview posts** — Renders Open Graph cards from any URL (no image upload needed)
- **First comment** — Auto-post a follow-up comment 3–5 s after creation for engagement

### 🛡️ Security

- **SSRF protection** — Blocks private/internal IP ranges and loopback addresses during media downloads
- **Upload URL pinning** — Binary uploads only accepted to `*.linkedin.com` / `*.licdn.com` hosts
- **Prompt injection protection** — External content wrapped in randomised `EXTCONTENT` markers

### ⚡ Performance

- **In-memory client cache** — Reuses authenticated clients (4 h TTL)
- **Authenticated user cache** — Resolves `me` once per credential key (4 h TTL)
- **Token-bucket rate limiter** — Conservative limits enforced before hitting the API
- **Auto-retry on 429** — Exponential backoff up to 3 retries

### 🧰 15 Tools (6 SENSE + 2 Discovery + 7 ACT)

**Discovery:**
| Tool | Description |
|------|-------------|
| `linkedin_whoami` | Verify which account this token belongs to — always call before writes |
| `linkedin_list_capabilities` | List all supported content types, limits, and caveats |

**SENSE — Read from LinkedIn:**
| Tool | Description |
|------|-------------|
| `linkedin_get_org_analytics` | Page views and visitor demographics for your organisation |
| `linkedin_get_post_analytics` | Likes, comments, and shares for a specific post |
| `linkedin_get_comments` | Comments on a post |
| `linkedin_get_mentions` | Social actions where your organisation is mentioned |
| `linkedin_get_follower_stats` | Follower demographics — seniority, industry, company size |
| `linkedin_get_share_stats` | Share statistics for specific posts |

**ACT — Write to LinkedIn:**
| Tool | Description |
|------|-------------|
| `linkedin_create_post` | Publish text, image, video, document, or link preview posts |
| `linkedin_comment` | Comment on a post (max 1,250 chars) |
| `linkedin_react` | Like a post |
| `linkedin_share` | Reshare a post with optional commentary |
| `linkedin_delete_post` | Delete a post by URN |
| `linkedin_get_media_specs` | Media format specs (dimensions, size limits) |

## 🚀 Quick Start

### Prerequisites

- Node.js 18 or higher
- A [LinkedIn Developer app](https://developer.linkedin.com) with OAuth 2.0 configured
- Claude Desktop (or any MCP-compatible client)

### Get Your LinkedIn Access Token

1. Go to the [LinkedIn Developer Portal](https://developer.linkedin.com/apps)
2. Create or open an app
3. Under **Auth**, add the required OAuth 2.0 scopes:
   - `openid` + `profile` — required for identity resolution
   - `w_member_social` — required for creating posts, comments, and reactions
4. Generate an access token (valid for 60 days)

For organisation analytics, note your **LinkedIn Organization ID** (numeric, from your company page URL).

## 📦 Installation

### Option 0: Claude Code Plugin (Simplest for Claude Code Users) 🔌

```bash
# Add the Luminary Lane Tools marketplace
/plugin marketplace add luminarylane/linkedin-mcp-server

# Install the plugin
/plugin install linkedin@luminary-lane-tools
```

Or install directly:

```bash
/plugin install linkedin@luminarylane/linkedin-mcp-server
```

### Option 1: npx (Recommended — Zero Install) ⚡

```bash
# Test it works
LINKEDIN_ACCESS_TOKEN=your-token npx -y linkedin-mcp-server
```

**Claude Desktop configuration:**

```json
{
  "mcpServers": {
    "linkedin": {
      "command": "npx",
      "args": ["-y", "linkedin-mcp-server"],
      "env": {
        "LINKEDIN_ACCESS_TOKEN": "your-access-token",
        "LINKEDIN_ORG_ID": "your-org-id"
      }
    }
  }
}
```

> `LINKEDIN_ORG_ID` is optional — only needed for organisation analytics tools.

### Option 2: Install from npm

```bash
npm install -g linkedin-mcp-server
```

```json
{
  "mcpServers": {
    "linkedin": {
      "command": "linkedin-mcp-server",
      "env": {
        "LINKEDIN_ACCESS_TOKEN": "your-access-token",
        "LINKEDIN_ORG_ID": "your-org-id"
      }
    }
  }
}
```

### Option 3: Install from Source

```bash
git clone https://github.com/luminarylane/linkedin-mcp-server.git
cd linkedin-mcp-server
npm install
npm run build
```

```json
{
  "mcpServers": {
    "linkedin": {
      "command": "node",
      "args": ["/path/to/linkedin-mcp-server/dist/index.js"],
      "env": {
        "LINKEDIN_ACCESS_TOKEN": "your-access-token"
      }
    }
  }
}
```

## 🔑 Authentication

| Env Var                 | Required      | Description                                   |
| ----------------------- | ------------- | --------------------------------------------- |
| `LINKEDIN_ACCESS_TOKEN` | Yes           | OAuth 2.0 bearer token (60-day lifetime)      |
| `LINKEDIN_ORG_ID`       | For org tools | Numeric organisation ID from company page URL |

**Per-call credentials** — pass `accessToken` and/or `organizationId` directly as tool arguments to manage multiple accounts from one server instance.

**Always call `linkedin_whoami` first** to verify the token is valid and confirm which account you're acting on before any write operation.

## 💬 Usage Examples

Once configured, ask Claude to:

- "Who am I authenticated as on LinkedIn?"
- "What content types can I post on LinkedIn?"
- "Post to LinkedIn: Excited to share our latest product update!"
- "Post with hashtags: #AI #ProductUpdate #Innovation"
- "Create a LinkedIn post with this image: https://example.com/image.jpg"
- "Upload this PDF as a carousel post: https://example.com/deck.pdf"
- "Create a post with a link preview for https://example.com/blog"
- "Comment on post urn:li:share:1234 with 'Great insights!'"
- "Like post urn:li:share:1234"
- "Get analytics for my LinkedIn organisation"
- "How many followers does our LinkedIn page have by seniority?"

## 📊 Rate Limits

The server enforces conservative rate limits client-side:

| Category                          | Limit        | Window   |
| --------------------------------- | ------------ | -------- |
| Global                            | 100 requests | 24 hours |
| Reads                             | 60 requests  | 1 hour   |
| Writes (posts/comments/reactions) | 25 actions   | 24 hours |
| Delete                            | 10 actions   | 1 hour   |

LinkedIn does not publish exact rate limits — these are conservative estimates for the basic tier. When a limit is reached the server returns a structured error with `retryAfterSeconds` and an `action` hint.

## 🔧 Troubleshooting

### 401 — Token expired

```
AUTH_EXPIRED: Token may have expired (60-day lifetime). Re-authenticate via OAuth.
```

LinkedIn access tokens expire after 60 days. Generate a new token in the [Developer Portal](https://developer.linkedin.com/apps).

### 403 — Missing scope

```
SCOPE_MISSING: App may lack required OAuth scope (w_member_social for writes).
```

Ensure your LinkedIn app has `w_member_social` scope and re-generate the token.

### 403 — Carousel returns 403

```
CAROUSEL_UNSUPPORTED: Organic carousels return 403.
```

LinkedIn disables organic native carousels via API. Use `documentUrl` with a PDF instead — it renders as a swipeable carousel.

### 403 — Organisation permission

```
ORG_PERMISSION: User may not have admin access to this organization.
```

The authenticated user needs at least **Community Manager** role on the LinkedIn Company Page.

### 413 — File too large

```
FILE_TOO_LARGE: Image max 10MB, video max 200MB, document max 100MB.
```

Compress the file or use a smaller variant before uploading.

### Document post — no post ID returned

LinkedIn's Posts API sometimes returns 201 with an empty body. The server reads the `x-restli-id` response header. If it's missing, the post was likely created — check the LinkedIn feed.

### Reporting Issues

1. Check [existing issues](https://github.com/luminarylane/linkedin-mcp-server/issues)
2. Open a new issue with the full error, tool name, and Node.js version

[📝 Open an Issue](https://github.com/luminarylane/linkedin-mcp-server/issues/new)

## 🤝 Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

```bash
npm install       # Install dependencies
npm run dev       # Run in dev mode (no build needed)
npx tsc --noEmit  # Type check
npm test          # Run tests
npx prettier --write .  # Format
```

## 📝 License

MIT License — see [LICENSE](LICENSE) for details.

## 🙏 Acknowledgments

- [Anthropic](https://anthropic.com) for the MCP specification
- [LinkedIn Developer Platform](https://developer.linkedin.com) for the REST API
