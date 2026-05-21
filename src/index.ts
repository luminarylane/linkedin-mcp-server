#!/usr/bin/env node
/**
 * Standalone LinkedIn MCP Server
 *
 * Pure LinkedIn API wrapper over stdio. No database, no auth layer.
 * Credentials passed directly per tool call or via env vars.
 *
 * Auth: OAuth 2.0 bearer token (single accessToken).
 * Set LINKEDIN_ACCESS_TOKEN env var or pass accessToken per call.
 * Scopes: openid, profile, w_member_social
 *
 * Two different post APIs:
 *   - UGC API (/v2/ugcPosts) for text/image/video
 *   - Posts API (/rest/posts) for documents — different headers and payload
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createClient,
  credentialHash,
  LinkedInClient,
  CACHE_TTL_MS,
  personUrn,
  orgUrn,
} from "./client.js";
import { textResult, errorResult, senseResult } from "./response.js";
import { waitForRateLimit, withRetry } from "./rate-limiter.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

// Env-based defaults
const DEFAULT_ACCESS_TOKEN = process.env.LINKEDIN_ACCESS_TOKEN;
const DEFAULT_ORG_ID = process.env.LINKEDIN_ORG_ID;

// --- Credential resolution ---

interface CredentialArgs {
  accessToken?: string;
  organizationId?: string;
}

function resolveAccessToken(args: CredentialArgs): string | null {
  return args.accessToken || DEFAULT_ACCESS_TOKEN || null;
}

function resolveOrgId(args: CredentialArgs): string | null {
  return args.organizationId || DEFAULT_ORG_ID || null;
}

// --- Discriminated union for client result ---

type ClientResult =
  | { ok: true; client: LinkedInClient; credKey: string }
  | { ok: false; error: ReturnType<typeof errorResult> };

async function getClient(
  args: CredentialArgs,
  toolName?: string,
  overrideCost?: number,
): Promise<ClientResult> {
  const token = resolveAccessToken(args);
  if (!token) {
    return {
      ok: false,
      error: errorResult(
        "Missing credentials",
        "Provide accessToken as argument, or set LINKEDIN_ACCESS_TOKEN env var.",
      ),
    };
  }

  // Check rate limit
  const limit = await waitForRateLimit(toolName, overrideCost);
  if (!limit.allowed) {
    const retryAfterSeconds = Math.ceil(limit.retryAfterMs / 1000);
    return {
      ok: false,
      error: errorResult(
        "Rate limited",
        `LinkedIn API rate limit reached. Wait ${retryAfterSeconds}s then retry this exact tool call with the same arguments.`,
        {
          retryAfterSeconds,
          action:
            retryAfterSeconds <= 120
              ? `RETRY_AFTER_WAIT: Sleep ${retryAfterSeconds}s then retry this tool call.`
              : `DEFER: Rate limit cooldown is ${retryAfterSeconds}s. Queue this operation for later or switch to a different task.`,
        },
      ),
    };
  }

  try {
    const client = createClient(token);
    return { ok: true, client, credKey: credentialHash(token) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return {
      ok: false,
      error: errorResult(
        "Client error",
        `Failed to create LinkedIn client: ${msg}`,
      ),
    };
  }
}

// --- Safe handler wrapper ---

function extractApiDetail(e: unknown): string | undefined {
  if (typeof e === "object" && e !== null && "detail" in e) {
    return String((e as { detail: string }).detail);
  }
  if (typeof e === "object" && e !== null && "message" in e) {
    const msg = (e as { message: string }).message;
    // Try to extract JSON detail from error message
    const jsonMatch = msg.match(/:\s*(\{.*\})/s);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]) as {
          message?: string;
          status?: number;
        };
        return parsed.message || jsonMatch[1];
      } catch {
        return jsonMatch[1];
      }
    }
  }
  return undefined;
}

/** Suggest a workaround the agent can act on for common LinkedIn API errors. */
function suggestAction(
  _toolName: string,
  statusCode: number | undefined,
  detail: string | undefined,
): string | undefined {
  const d = (detail || "").toLowerCase();

  if (statusCode === 401) {
    return "AUTH_EXPIRED: Token may have expired (60-day lifetime). Re-authenticate via OAuth.";
  }

  if (statusCode === 403) {
    if (d.includes("access_denied")) {
      return "SCOPE_MISSING: App may lack required OAuth scope (w_member_social for writes).";
    }
    if (d.includes("not_enough_permissions")) {
      return "ORG_PERMISSION: User may not have admin access to this organization.";
    }
    if (d.includes("carousel") || d.includes("document")) {
      return "CAROUSEL_UNSUPPORTED: Organic carousels return 403. Use document post with PDF instead.";
    }
    return "FORBIDDEN: LinkedIn rejected this action. Check the error message for details.";
  }

  if (statusCode === 404) {
    return "NOT_FOUND: Resource not found. Verify the URN format (urn:li:{type}:{id}).";
  }

  if (statusCode === 413) {
    return "FILE_TOO_LARGE: Image max 10MB, video max 200MB, document max 100MB.";
  }

  if (statusCode === 422) {
    if (d.includes("duplicate")) {
      return "DUPLICATE: Similar post recently published. Wait or modify content.";
    }
  }

  if (statusCode === 429) {
    return "RATE_LIMITED: LinkedIn rate limit hit. The rate limiter will handle backoff.";
  }

  return undefined;
}

function safeHandler<T>(
  toolName: string,
  handler: (
    args: T,
  ) => Promise<ReturnType<typeof textResult | typeof senseResult>>,
): (
  args: T,
) => Promise<
  ReturnType<typeof textResult | typeof senseResult | typeof errorResult>
> {
  return async (args: T) => {
    const start = Date.now();
    console.error(`[${toolName}] ← called`);
    try {
      const result = await handler(args);
      console.error(`[${toolName}] → ok (${Date.now() - start}ms)`);
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const detail = extractApiDetail(e);
      const statusCode =
        typeof e === "object" && e !== null && "status" in e
          ? (e as { status: number }).status
          : undefined;
      const action = suggestAction(toolName, statusCode, detail);
      console.error(
        `[${toolName}] → error (${Date.now() - start}ms): ${msg}${detail ? ` — ${detail}` : ""}`,
      );
      return errorResult("API error", `${toolName} failed: ${detail || msg}`, {
        ...(statusCode && { statusCode }),
        ...(detail && detail !== msg && { rawError: msg }),
        ...(action && { action }),
      });
    }
  };
}

// --- Me cache ---

const MAX_ME_CACHE_SIZE = 100;
const meCache = new Map<
  string,
  { id: string; name: string; createdAt: number }
>();

async function resolveMe(
  client: LinkedInClient,
  credKey: string,
): Promise<{ id: string; name: string }> {
  const cached = meCache.get(credKey);
  if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
    return { id: cached.id, name: cached.name };
  }

  // Evict stale entries (same pattern as client.ts evictStale)
  const now = Date.now();
  for (const [key, entry] of meCache) {
    if (now - entry.createdAt >= CACHE_TTL_MS) meCache.delete(key);
  }
  if (meCache.size >= MAX_ME_CACHE_SIZE) {
    meCache.delete(meCache.keys().next().value!);
  }

  const me = await withRetry(() => client.getMe());
  meCache.set(credKey, { ...me, createdAt: now });
  return me;
}

// --- Tool Definitions ---

const credentialFields = {
  accessToken: z
    .string()
    .optional()
    .describe(
      "LinkedIn OAuth 2.0 access token. Falls back to LINKEDIN_ACCESS_TOKEN env var.",
    ),
  organizationId: z
    .string()
    .optional()
    .describe(
      "LinkedIn organization ID (numeric, e.g. '12345'). Falls back to LINKEDIN_ORG_ID env var. Required for org-level analytics tools.",
    ),
};

// --- Server Setup ---

const server = new McpServer({
  name: "linkedin-mcp-server",
  version,
});

// =====================
// Identity
// =====================

server.registerTool(
  "linkedin_whoami",
  {
    description:
      "Verify which LinkedIn account this token belongs to. " +
      "ALWAYS call this before any write operation to confirm you're acting on the correct account. " +
      "Returns the authenticated user's name and person URN.",
    inputSchema: {
      ...credentialFields,
    },
  },
  safeHandler("linkedin_whoami", async (args) => {
    const result = await getClient(args, "linkedin_whoami");
    if (!result.ok) return result.error;
    const { client, credKey } = result;

    const me = await resolveMe(client, credKey);
    const orgId = resolveOrgId(args);

    return textResult({
      personUrn: personUrn(me.id),
      name: me.name,
      ...(orgId && { organizationId: orgId, organizationUrn: orgUrn(orgId) }),
      message: `Authenticated as: ${me.name}`,
    });
  }),
);

// =====================
// Discovery Tools
// =====================

server.registerTool(
  "linkedin_list_capabilities",
  {
    description:
      "List all content types this server can publish to LinkedIn. " +
      "Call this FIRST when planning content strategy — it returns supported formats, " +
      "size limits, and what is NOT supported, so you can choose the best content type.",
    inputSchema: {},
  },
  safeHandler("linkedin_list_capabilities", async () => {
    return textResult({
      supportedContentTypes: [
        {
          type: "text",
          tool: "linkedin_create_post",
          description: "Text-only post with optional hashtags",
          limits: { maxLength: "3000 characters" },
          supportsComments: true,
          supportsFirstComment: true,
          bestFor:
            "Quick updates, thought leadership, questions, polls-as-text",
        },
        {
          type: "image",
          tool: "linkedin_create_post",
          param: "imageUrl",
          description:
            "Post with a single image attachment (JPG, PNG, GIF). Provide a publicly accessible URL.",
          limits: { maxFileSize: "10MB", formats: "JPG, PNG, GIF" },
          supportsComments: true,
          supportsFirstComment: true,
          bestFor:
            "Infographics, brand visuals, team photos, data visualizations",
        },
        {
          type: "video",
          tool: "linkedin_create_post",
          param: "videoUrl",
          description:
            "Post with a single video attachment. Provide a publicly accessible URL.",
          limits: {
            maxFileSize: "200MB",
            formats: "MP4, MOV",
            uploadTimeout: "5 minutes",
          },
          supportsComments: true,
          supportsFirstComment: true,
          bestFor:
            "Product demos, event highlights, interviews, behind-the-scenes",
        },
        {
          type: "document",
          tool: "linkedin_create_post",
          param: "documentUrl",
          description:
            "Post with a PDF document (rendered as a swipeable carousel on LinkedIn). Provide a publicly accessible URL to a PDF file.",
          limits: { maxFileSize: "100MB", formats: "PDF only" },
          supportsComments: false,
          supportsFirstComment: false,
          bestFor:
            "Slide decks, whitepapers, multi-page guides, carousel-style content",
          caveats: [
            "Uses LinkedIn Posts API (different from text/image/video)",
            "Does not support commenting (including first comment) — automatically skipped",
            "Response may be empty (201 with no body) — this is normal",
          ],
        },
        {
          type: "link_preview",
          tool: "linkedin_create_post",
          param: "linkUrl",
          description:
            "Post with a rich link preview card. LinkedIn scrapes the page's Open Graph meta tags (og:image, og:title, og:description) to render the card. Just provide the URL — no image upload needed.",
          limits: { formats: "Any publicly accessible URL with OG tags" },
          supportsComments: true,
          supportsFirstComment: true,
          bestFor:
            "Blog posts, landing pages, product launches, event pages — anything with a URL you want to drive traffic to",
        },
      ],
      unsupportedContentTypes: [
        {
          type: "carousel (native)",
          reason:
            "LinkedIn returns 403 for organic native carousels. Use document (PDF) instead — PDFs render as swipeable carousels.",
        },
        {
          type: "poll",
          reason:
            "LinkedIn API does not support creating polls programmatically",
        },
        {
          type: "article/newsletter",
          reason:
            "LinkedIn articles and newsletters require the Publishing API which has separate access requirements",
        },
        {
          type: "audio",
          reason: "LinkedIn does not support audio attachments on posts",
        },
      ],
      otherActions: [
        {
          tool: "linkedin_comment",
          description:
            "Comment on a post (max 1250 chars). Not supported on document posts.",
        },
        {
          tool: "linkedin_react",
          description:
            "Like a post. Only LIKE is supported (typed reactions need Reactions API).",
        },
        {
          tool: "linkedin_share",
          description: "Reshare a post with optional commentary",
        },
        {
          tool: "linkedin_delete_post",
          description: "Delete a post by URN",
        },
      ],
      tip: "Only one media type per post. To combine media, create multiple posts or use a PDF carousel.",
    });
  }),
);

// =====================
// Media Specs
// =====================

server.registerTool(
  "linkedin_get_media_specs",
  {
    description:
      "Get LinkedIn platform media specifications — supported formats, dimensions, " +
      "file size limits, and duration caps. Call this BEFORE generating media assets " +
      "to ensure they conform to LinkedIn API requirements.",
    inputSchema: {},
  },
  safeHandler("linkedin_get_media_specs", async () => {
    return textResult({
      platform: "LinkedIn (REST API)",
      mediaFormats: [
        {
          type: "image",
          formats: ["JPG", "PNG", "GIF"],
          maxFileSize: "10MB",
          maxDimensions: "1200x627 (link share), 1080x1080 (feed post)",
          recommendedDimensions: "1200x627 (landscape), 1080x1080 (square)",
          notes: "Single image per post. GIFs are static only on LinkedIn.",
        },
        {
          type: "video",
          formats: ["MP4", "MOV"],
          maxFileSize: "200MB",
          maxDuration: "10 minutes",
          maxDimensions: "1920x1080",
          recommendedDimensions: "1920x1080 (landscape), 1080x1920 (vertical)",
          notes: "Upload may take several minutes for large files. H.264 codec recommended.",
        },
        {
          type: "document",
          formats: ["PDF"],
          maxFileSize: "100MB",
          notes:
            "PDFs render as swipeable carousels on LinkedIn. Best way to create carousel content. " +
            "Does not support commenting (including first comment).",
        },
      ],
      unsupportedFormats: [
        {
          type: "carousel (native)",
          reason:
            "LinkedIn returns 403 for organic native carousels. Use PDF document instead — renders as swipeable carousel.",
        },
        { type: "audio", reason: "LinkedIn does not support audio attachments on posts" },
      ],
      tip: "For carousel-style content, create a PDF and upload as a document — it renders as a swipeable carousel on LinkedIn.",
    });
  }),
);

// =====================
// SENSE Tools (read)
// =====================

server.registerTool(
  "linkedin_get_org_analytics",
  {
    description:
      "Get LinkedIn organization analytics — page views, visitor demographics. Requires organizationId.",
    inputSchema: {
      ...credentialFields,
      timeRange: z
        .string()
        .optional()
        .describe(
          "Time range start in epoch ms (e.g. '1709251200000'). Defaults to last 30 days.",
        ),
    },
  },
  safeHandler("linkedin_get_org_analytics", async (args) => {
    const orgId = resolveOrgId(args);
    if (!orgId) {
      return errorResult(
        "Missing organizationId",
        "Provide organizationId as argument, or set LINKEDIN_ORG_ID env var.",
      );
    }
    const result = await getClient(args, "linkedin_get_org_analytics");
    if (!result.ok) return result.error;
    const { client } = result;

    const entityUrn = orgUrn(orgId);
    const params: Record<string, string> = {
      q: "organizationalEntity",
      organizationalEntity: entityUrn,
    };
    if (args.timeRange) {
      params["timeIntervals.timeGranularityType"] = "DAY";
      params["timeIntervals.timeRange.start"] = args.timeRange;
      params["timeIntervals.timeRange.end"] = String(Date.now());
    }

    const response = await withRetry(() =>
      client.get("/v2/organizationalEntityShareStatistics", params),
    );
    const data = await response.json();

    return senseResult(
      {
        organizationId: orgId,
        analytics: data,
      },
      "LinkedIn",
    );
  }),
);

server.registerTool(
  "linkedin_get_post_analytics",
  {
    description:
      "Get analytics for a specific LinkedIn post — likes, comments, shares count.",
    inputSchema: {
      ...credentialFields,
      postUrn: z
        .string()
        .describe(
          "LinkedIn post URN (e.g. 'urn:li:share:7012345678901234567' or 'urn:li:ugcPost:7012345678901234567')",
        ),
    },
  },
  safeHandler("linkedin_get_post_analytics", async (args) => {
    if (!args.postUrn.trim())
      return errorResult("Invalid input", "postUrn cannot be empty");
    const result = await getClient(args, "linkedin_get_post_analytics");
    if (!result.ok) return result.error;
    const { client } = result;

    const encodedUrn = encodeURIComponent(args.postUrn);
    const response = await withRetry(() =>
      client.get(`/v2/socialActions/${encodedUrn}`),
    );
    const data = (await response.json()) as {
      likesSummary?: { totalLikes?: number };
      commentsSummary?: { totalFirstLevelComments?: number };
      sharesSummary?: unknown;
    };

    return senseResult(
      {
        postUrn: args.postUrn,
        metrics: {
          likes: data.likesSummary?.totalLikes ?? 0,
          comments: data.commentsSummary?.totalFirstLevelComments ?? 0,
        },
        raw: data,
      },
      "LinkedIn",
    );
  }),
);

server.registerTool(
  "linkedin_get_comments",
  {
    description:
      "Get comments on a LinkedIn post. URN must be URL-encoded. Returns comment threads.",
    inputSchema: {
      ...credentialFields,
      postUrn: z
        .string()
        .describe(
          "LinkedIn post URN (e.g. 'urn:li:share:7012345678901234567')",
        ),
      count: z
        .number()
        .optional()
        .describe("Number of comments to retrieve (default: 10, max: 100)"),
    },
  },
  safeHandler("linkedin_get_comments", async (args) => {
    if (!args.postUrn.trim())
      return errorResult("Invalid input", "postUrn cannot be empty");
    const result = await getClient(args, "linkedin_get_comments");
    if (!result.ok) return result.error;
    const { client } = result;

    const encodedUrn = encodeURIComponent(args.postUrn);
    const params: Record<string, string> = {};
    if (args.count) {
      params.count = String(Math.min(args.count, 100));
    }

    const response = await withRetry(() =>
      client.get(`/v2/socialActions/${encodedUrn}/comments`, params),
    );
    const data = (await response.json()) as {
      elements?: Array<{
        actor: string;
        message?: { text: string };
        created?: { time: number };
        $URN?: string;
      }>;
    };

    const comments = (data.elements ?? []).map((c) => ({
      authorUrn: c.actor,
      text: c.message?.text ?? "",
      createdAt: c.created?.time
        ? new Date(c.created.time).toISOString()
        : undefined,
      id: c["$URN"],
    }));

    return senseResult(
      {
        postUrn: args.postUrn,
        comments,
        count: comments.length,
      },
      "LinkedIn",
    );
  }),
);

server.registerTool(
  "linkedin_get_mentions",
  {
    description:
      "Get social actions where an organization is mentioned. Requires organizationId.",
    inputSchema: {
      ...credentialFields,
    },
  },
  safeHandler("linkedin_get_mentions", async (args) => {
    const orgId = resolveOrgId(args);
    if (!orgId) {
      return errorResult(
        "Missing organizationId",
        "Provide organizationId as argument, or set LINKEDIN_ORG_ID env var.",
      );
    }
    const result = await getClient(args, "linkedin_get_mentions");
    if (!result.ok) return result.error;
    const { client } = result;

    const entityUrn = orgUrn(orgId);
    const response = await withRetry(() =>
      client.get("/v2/socialActions", {
        q: "organizationalEntity",
        organizationalEntity: entityUrn,
      }),
    );
    const data = await response.json();

    return senseResult(
      {
        organizationId: orgId,
        mentions: data,
      },
      "LinkedIn",
    );
  }),
);

server.registerTool(
  "linkedin_get_follower_stats",
  {
    description:
      "Get follower demographics for a LinkedIn organization — seniority, industry, company size. Requires organizationId.",
    inputSchema: {
      ...credentialFields,
    },
  },
  safeHandler("linkedin_get_follower_stats", async (args) => {
    const orgId = resolveOrgId(args);
    if (!orgId) {
      return errorResult(
        "Missing organizationId",
        "Provide organizationId as argument, or set LINKEDIN_ORG_ID env var.",
      );
    }
    const result = await getClient(args, "linkedin_get_follower_stats");
    if (!result.ok) return result.error;
    const { client } = result;

    const entityUrn = orgUrn(orgId);
    const response = await withRetry(() =>
      client.get("/v2/organizationalEntityFollowerStatistics", {
        q: "organizationalEntity",
        organizationalEntity: entityUrn,
      }),
    );
    const data = await response.json();

    return senseResult(
      {
        organizationId: orgId,
        followerStats: data,
      },
      "LinkedIn",
    );
  }),
);

server.registerTool(
  "linkedin_get_share_stats",
  {
    description:
      "Get share statistics for specific posts — how content is shared/reshared. Requires organizationId and shareUrns.",
    inputSchema: {
      ...credentialFields,
      shareUrns: z
        .array(z.string())
        .describe(
          "Array of share URNs to get stats for (e.g. ['urn:li:share:123', 'urn:li:share:456'])",
        ),
    },
  },
  safeHandler("linkedin_get_share_stats", async (args) => {
    const orgId = resolveOrgId(args);
    if (!orgId) {
      return errorResult(
        "Missing organizationId",
        "Provide organizationId as argument, or set LINKEDIN_ORG_ID env var.",
      );
    }
    if (!args.shareUrns.length) {
      return errorResult("Invalid input", "shareUrns array cannot be empty");
    }
    const result = await getClient(args, "linkedin_get_share_stats");
    if (!result.ok) return result.error;
    const { client } = result;

    const entityUrn = orgUrn(orgId);
    const shares = args.shareUrns.map(encodeURIComponent).join(",");
    const response = await withRetry(() =>
      client.get("/v2/organizationalEntityShareStatistics", {
        q: "organizationalEntity",
        organizationalEntity: entityUrn,
        "shares[]": shares,
      }),
    );
    const data = await response.json();

    return senseResult(
      {
        organizationId: orgId,
        shareStats: data,
      },
      "LinkedIn",
    );
  }),
);

// =====================
// ACT Tools (write)
// =====================

server.registerTool(
  "linkedin_create_post",
  {
    description:
      "Create a LinkedIn post with rich content. " +
      "SUPPORTED FORMATS: (1) Text-only — just provide text. " +
      "(2) Image — provide imageUrl (JPG/PNG/GIF, max 10MB). " +
      "(3) Video — provide videoUrl (MP4/MOV, max 200MB). " +
      "(4) Document/Carousel — provide documentUrl (PDF only, max 100MB, renders as swipeable carousel). " +
      "(5) Link preview — provide linkUrl to render an OG card (image, title, description scraped from the page). " +
      "Only ONE media type per post. Supports optional firstComment for engagement (auto-skipped for documents). " +
      "Call linkedin_list_capabilities for full details.",
    inputSchema: {
      ...credentialFields,
      text: z.string().describe("Post text content"),
      hashtags: z
        .array(z.string())
        .optional()
        .describe("Hashtags to append (without # prefix)"),
      visibility: z
        .enum(["PUBLIC", "CONNECTIONS"])
        .optional()
        .describe("Post visibility (default: PUBLIC)"),
      imageUrl: z
        .string()
        .optional()
        .describe(
          "URL of image to attach (max 10MB). Mutually exclusive with videoUrl and documentUrl.",
        ),
      videoUrl: z
        .string()
        .optional()
        .describe(
          "URL of video to attach (max 200MB). Mutually exclusive with imageUrl and documentUrl.",
        ),
      documentUrl: z
        .string()
        .optional()
        .describe(
          "URL of PDF document to attach (max 100MB). Uses Posts API instead of UGC API. Mutually exclusive with imageUrl and videoUrl.",
        ),
      linkUrl: z
        .string()
        .optional()
        .describe(
          "URL to attach as a link preview card (renders OG image, title, description). " +
            "LinkedIn scrapes the page's Open Graph meta tags to generate the preview. " +
            "Can be combined with text but NOT with imageUrl, videoUrl, or documentUrl.",
        ),
      firstComment: z
        .string()
        .optional()
        .describe(
          "Optional first comment to post immediately after creation (max 1250 chars). " +
            "Used as an engagement strategy — adds a follow-up question or call-to-action. " +
            "Automatically skipped for document posts (not supported by LinkedIn API). " +
            "The comment is posted by the same author as the post.",
        ),
    },
  },
  safeHandler("linkedin_create_post", async (args) => {
    if (!args.text.trim())
      return errorResult("Invalid input", "Text cannot be empty");

    // Validate mutual exclusivity
    const mediaCount = [
      args.imageUrl,
      args.videoUrl,
      args.documentUrl,
      args.linkUrl,
    ].filter(Boolean).length;
    if (mediaCount > 1) {
      return errorResult(
        "Invalid input",
        "Only one media type allowed per post. Provide imageUrl OR videoUrl OR documentUrl OR linkUrl.",
      );
    }

    const result = await getClient(args, "linkedin_create_post");
    if (!result.ok) return result.error;
    const { client, credKey } = result;

    const me = await resolveMe(client, credKey);
    const authorUrn = personUrn(me.id);

    // Format text with hashtags
    const hashtagText = args.hashtags?.length
      ? args.hashtags.map((h) => `#${h.replace(/^#/, "")}`).join(" ")
      : "";
    const fullText = hashtagText ? `${args.text}\n\n${hashtagText}` : args.text;
    const visibility =
      args.visibility === "CONNECTIONS" ? "CONNECTIONS" : "PUBLIC";

    // --- Document post (Posts API) ---
    if (args.documentUrl) {
      const documentUrn = await withRetry(() =>
        client.uploadDocument(args.documentUrl!, authorUrn),
      );

      const postPayload = {
        author: authorUrn,
        commentary: fullText,
        visibility,
        distribution: {
          feedDistribution: "MAIN_FEED",
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        content: {
          media: {
            title: "Document",
            id: documentUrn,
          },
        },
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
      };

      const postResponse = await withRetry(() =>
        client.post("/rest/posts", postPayload, true),
      );

      // Posts API returns post URN in x-restli-id header (body is often empty)
      const postId = postResponse.headers.get("x-restli-id");

      if (!postId) {
        console.error(
          `[linkedin_create_post] Posts API x-restli-id header missing — cannot determine post URN`,
        );
        return errorResult(
          "Partial failure",
          `Document uploaded and post likely created, but LinkedIn did not return the post ID. ` +
            `The post may be visible on the feed. Document URN: ${documentUrn}`,
        );
      }

      return textResult({
        postId,
        postUrl: `https://www.linkedin.com/feed/update/${postId}/`,
        shareUrn: postId,
        supportsComments: false,
        firstCommentSkipped: args.firstComment
          ? "Document posts do not support commenting on LinkedIn"
          : undefined,
        message: "Document post created successfully",
      });
    }

    // --- Image, Video, or Link post (UGC API) ---
    let shareMediaCategory: "NONE" | "IMAGE" | "VIDEO" | "ARTICLE" = "NONE";
    let media: Array<Record<string, unknown>> = [];

    if (args.imageUrl) {
      const assetUrn = await withRetry(() =>
        client.uploadImage(args.imageUrl!, authorUrn),
      );
      shareMediaCategory = "IMAGE";
      media = [
        {
          status: "READY",
          description: { text: "Image" },
          media: assetUrn,
          title: { text: "Image" },
        },
      ];
    } else if (args.videoUrl) {
      const assetUrn = await withRetry(() =>
        client.uploadVideo(args.videoUrl!, authorUrn),
      );
      shareMediaCategory = "VIDEO";
      media = [
        {
          status: "READY",
          description: { text: "Video" },
          media: assetUrn,
          title: { text: "Video" },
        },
      ];
    } else if (args.linkUrl) {
      shareMediaCategory = "ARTICLE";
      media = [
        {
          status: "READY",
          originalUrl: args.linkUrl,
        },
      ];
    }

    // Build UGC Post payload
    const ugcPayload = {
      author: authorUrn,
      lifecycleState: "PUBLISHED",
      specificContent: {
        "com.linkedin.ugc.ShareContent": {
          shareCommentary: { text: fullText },
          shareMediaCategory,
          ...(media.length > 0 && { media }),
        },
      },
      visibility: {
        "com.linkedin.ugc.MemberNetworkVisibility": visibility,
      },
    };

    const ugcResponse = await withRetry(() =>
      client.post("/v2/ugcPosts", ugcPayload),
    );
    const ugcResult = (await ugcResponse.json()) as Record<string, unknown>;
    if (!ugcResult.id || typeof ugcResult.id !== "string") {
      throw new Error(
        `UGC post created but response missing 'id'. Response keys: ${Object.keys(ugcResult).join(", ")}`,
      );
    }

    // --- First comment (if provided) ---
    let firstCommentId: string | undefined;
    if (args.firstComment?.trim()) {
      const commentText = args.firstComment.trim().slice(0, 1250);
      try {
        const delayMs = 3000 + Math.random() * 2000;
        console.error(
          `[linkedin_create_post] Posting first comment in ${Math.round(delayMs / 1000)}s...`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));

        firstCommentId = await withRetry(() =>
          client.postComment(ugcResult.id as string, authorUrn, commentText),
        );
      } catch (commentError) {
        const errMsg =
          commentError instanceof Error
            ? commentError.message
            : String(commentError);
        console.error(`[linkedin_create_post] First comment failed: ${errMsg}`);
        // Return partial success — post was created but comment failed
        return errorResult(
          "Partial failure",
          `Post created (${ugcResult.id}) but first comment failed: ${errMsg}. ` +
            `Use linkedin_comment to retry.`,
          {
            postId: ugcResult.id,
            postUrl: `https://www.linkedin.com/feed/update/${ugcResult.id}/`,
            shareUrn: ugcResult.id,
            supportsComments: true,
          },
        );
      }
    }

    return textResult({
      postId: ugcResult.id,
      postUrl: `https://www.linkedin.com/feed/update/${ugcResult.id}/`,
      shareUrn: ugcResult.id,
      supportsComments: true,
      ...(firstCommentId && { firstCommentId }),
      message: firstCommentId
        ? "Post created with first comment"
        : "Post created successfully",
    });
  }),
);

server.registerTool(
  "linkedin_comment",
  {
    description:
      "Post a comment on a LinkedIn post. Max 1250 characters. " +
      "Use the shareUrn returned by linkedin_create_post as the postUrn. " +
      "Can be used for delayed first comments — create post first, then comment later for engagement. " +
      "Document posts (created with documentUrl) do not support commenting.",
    inputSchema: {
      ...credentialFields,
      postUrn: z
        .string()
        .describe(
          "LinkedIn post/share URN to comment on (e.g. 'urn:li:share:7012345678901234567')",
        ),
      text: z.string().describe("Comment text (max 1250 characters)"),
    },
  },
  safeHandler("linkedin_comment", async (args) => {
    if (!args.postUrn.trim())
      return errorResult("Invalid input", "postUrn cannot be empty");
    if (!args.text.trim())
      return errorResult("Invalid input", "Text cannot be empty");
    if (args.text.length > 1250)
      return errorResult(
        "Invalid input",
        `${args.text.length} chars exceeds 1250 limit`,
      );

    const result = await getClient(args, "linkedin_comment");
    if (!result.ok) return result.error;
    const { client, credKey } = result;

    const me = await resolveMe(client, credKey);
    const actorUrn = personUrn(me.id);

    const commentId = await withRetry(() =>
      client.postComment(args.postUrn, actorUrn, args.text.trim()),
    );

    return textResult({
      commentId,
      postUrn: args.postUrn,
      commentUrl: `https://www.linkedin.com/feed/update/${args.postUrn}/?commentUrn=${commentId}`,
      message: "Comment posted successfully",
    });
  }),
);

server.registerTool(
  "linkedin_react",
  {
    description:
      "Like a LinkedIn post. Uses the Social Actions likes endpoint. " +
      "Only supports LIKE (typed reactions like CELEBRATE require the Reactions API with r_member_social scope).",
    inputSchema: {
      ...credentialFields,
      postUrn: z.string().describe("LinkedIn post URN to like"),
    },
  },
  safeHandler("linkedin_react", async (args) => {
    if (!args.postUrn.trim())
      return errorResult("Invalid input", "postUrn cannot be empty");

    const result = await getClient(args, "linkedin_react");
    if (!result.ok) return result.error;
    const { client, credKey } = result;

    const me = await resolveMe(client, credKey);
    const actorUrn = personUrn(me.id);

    await withRetry(() => client.react(args.postUrn, actorUrn));

    return textResult({
      postUrn: args.postUrn,
      reactionType: "LIKE",
      message: "Post liked successfully",
    });
  }),
);

server.registerTool(
  "linkedin_share",
  {
    description:
      "Reshare a LinkedIn post to your feed with optional commentary.",
    inputSchema: {
      ...credentialFields,
      postUrn: z.string().describe("LinkedIn post URN to reshare"),
      text: z
        .string()
        .optional()
        .describe("Optional commentary to add to the reshare"),
    },
  },
  safeHandler("linkedin_share", async (args) => {
    if (!args.postUrn.trim())
      return errorResult("Invalid input", "postUrn cannot be empty");

    const result = await getClient(args, "linkedin_share");
    if (!result.ok) return result.error;
    const { client, credKey } = result;

    const me = await resolveMe(client, credKey);
    const authorUrn = personUrn(me.id);

    const ugcPayload = {
      author: authorUrn,
      lifecycleState: "PUBLISHED",
      specificContent: {
        "com.linkedin.ugc.ShareContent": {
          shareCommentary: { text: args.text || "" },
          shareMediaCategory: "NONE" as const,
        },
      },
      visibility: {
        "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC",
      },
      resharedShare: args.postUrn,
    };

    const response = await withRetry(() =>
      client.post("/v2/ugcPosts", ugcPayload),
    );
    const responseData = (await response.json()) as Record<string, unknown>;

    if (!responseData.id || typeof responseData.id !== "string") {
      throw new Error(
        `Reshare created but response missing 'id'. Response keys: ${Object.keys(responseData).join(", ")}`,
      );
    }

    return textResult({
      postId: responseData.id,
      postUrl: `https://www.linkedin.com/feed/update/${responseData.id}/`,
      resharedUrn: args.postUrn,
      message: "Post reshared successfully",
    });
  }),
);

server.registerTool(
  "linkedin_delete_post",
  {
    description:
      "Delete a LinkedIn post. Routes to the correct API based on URN type.",
    inputSchema: {
      ...credentialFields,
      postUrn: z.string().describe("LinkedIn post URN to delete"),
    },
  },
  safeHandler("linkedin_delete_post", async (args) => {
    if (!args.postUrn.trim())
      return errorResult("Invalid input", "postUrn cannot be empty");

    const result = await getClient(args, "linkedin_delete_post");
    if (!result.ok) return result.error;
    const { client } = result;

    const encodedUrn = encodeURIComponent(args.postUrn);

    // Route by URN type to avoid speculative round-trips
    if (args.postUrn.startsWith("urn:li:ugcPost:")) {
      await withRetry(() => client.delete(`/v2/ugcPosts/${encodedUrn}`));
    } else {
      // urn:li:share:* and other types → Posts API, fall back to UGC on 404
      try {
        await withRetry(() => client.delete(`/rest/posts/${encodedUrn}`, true));
      } catch (postsApiError) {
        const status =
          typeof postsApiError === "object" &&
          postsApiError !== null &&
          "status" in postsApiError
            ? (postsApiError as { status: number }).status
            : undefined;

        if (status !== 404) throw postsApiError;

        console.error(
          `[linkedin_delete_post] Posts API returned 404, falling back to UGC API`,
        );
        try {
          await withRetry(() => client.delete(`/v2/ugcPosts/${encodedUrn}`));
        } catch (ugcError) {
          console.error(
            `[linkedin_delete_post] UGC API also failed after Posts API 404`,
          );
          throw ugcError;
        }
      }
    }

    return textResult({
      postUrn: args.postUrn,
      message: "Post deleted successfully",
    });
  }),
);

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("LinkedIn MCP Server running on stdio");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
