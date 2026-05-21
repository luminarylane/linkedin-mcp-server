# CHANGELOG

<!-- version list -->

## v1.0.0 (2025-05-21)

### Features

- Initial open-source release
- 15 MCP tools: 2 Discovery + 6 SENSE (read) + 7 ACT (write)
- OAuth 2.0 Bearer Token authentication
- Per-call credential support for multi-account setups
- Rich post types: text, image, video, document/carousel, link preview
- First comment support (auto-posted 3–5 s after creation)
- Token-bucket rate limiter (conservative LinkedIn limits)
- Auto-retry with exponential backoff on HTTP 429
- SSRF protection for media URL downloads
- Upload URL pinning to `*.linkedin.com` / `*.licdn.com`
- Prompt injection protection via randomised `EXTCONTENT` markers
- In-memory client and identity cache with 4-hour TTL
- Structured error responses with agent-actionable hints
