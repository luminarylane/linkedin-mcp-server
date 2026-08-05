/**
 * Pure SENSE/insights functions for the LinkedIn API.
 *
 * Same single-source pattern as Facebook and Instagram — these are the
 * functions both the MCP server's `linkedin_get_*_analytics` handlers AND
 * the web app's `platform-insights.ts` (via `@linkedin-mcp/lib`) call.
 *
 * Note: LinkedIn's analytics endpoints (`/v2/organizationalEntity*`) require
 * an admin-of-organization access token with `r_organization_social` scope.
 * Personal/Sign-In With LinkedIn tokens 403 on these endpoints — the web
 * orchestrator gates these calls on a `metadata.organizationId` being set.
 */
import { type LinkedInClient, orgUrn } from "../client.js";
import { withRetry } from "../rate-limiter.js";

// ---------------------------------------------------------------------------
// linkedin_get_org_analytics
// ---------------------------------------------------------------------------

export interface OrgAnalyticsArgs {
  /** Numeric organization id (the digits in `urn:li:organization:<id>`). */
  organizationId: string;
  /** Time range start in epoch ms (e.g. "1709251200000"). */
  timeRange?: string;
}

export interface OrgAnalyticsResult {
  organizationId: string;
  analytics: unknown;
}

export async function fetchOrgAnalytics(
  client: LinkedInClient,
  args: OrgAnalyticsArgs,
): Promise<OrgAnalyticsResult> {
  if (!args.organizationId) throw new Error("organizationId is required");
  const entityUrn = orgUrn(args.organizationId);
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
  return { organizationId: args.organizationId, analytics: data };
}

// ---------------------------------------------------------------------------
// linkedin_get_post_analytics
// ---------------------------------------------------------------------------

export interface PostAnalyticsArgs {
  postUrn: string;
}

export interface PostAnalyticsResult {
  postUrn: string;
  metrics: { likes: number; comments: number };
  raw: unknown;
}

export async function fetchPostAnalytics(
  client: LinkedInClient,
  args: PostAnalyticsArgs,
): Promise<PostAnalyticsResult> {
  if (!args.postUrn.trim()) throw new Error("postUrn cannot be empty");
  const encodedUrn = encodeURIComponent(args.postUrn);
  const response = await withRetry(() =>
    client.get(`/v2/socialActions/${encodedUrn}`),
  );
  const data = (await response.json()) as {
    likesSummary?: { totalLikes?: number };
    commentsSummary?: { totalFirstLevelComments?: number };
    sharesSummary?: unknown;
  };
  return {
    postUrn: args.postUrn,
    metrics: {
      likes: data.likesSummary?.totalLikes ?? 0,
      comments: data.commentsSummary?.totalFirstLevelComments ?? 0,
    },
    raw: data,
  };
}

// ---------------------------------------------------------------------------
// linkedin_get_follower_stats
// ---------------------------------------------------------------------------

export interface FollowerStatsArgs {
  organizationId: string;
}

export interface FollowerStatsResult {
  organizationId: string;
  followerStats: unknown;
}

export async function fetchFollowerStats(
  client: LinkedInClient,
  args: FollowerStatsArgs,
): Promise<FollowerStatsResult> {
  if (!args.organizationId) throw new Error("organizationId is required");
  const entityUrn = orgUrn(args.organizationId);
  const response = await withRetry(() =>
    client.get("/v2/organizationalEntityFollowerStatistics", {
      q: "organizationalEntity",
      organizationalEntity: entityUrn,
    }),
  );
  const data = await response.json();
  return { organizationId: args.organizationId, followerStats: data };
}

// ---------------------------------------------------------------------------
// linkedin_get_share_stats
// ---------------------------------------------------------------------------

export interface ShareStatsArgs {
  organizationId: string;
  shareUrns: string[];
}

export interface ShareStatsResult {
  organizationId: string;
  shareStats: unknown;
}

export async function fetchShareStats(
  client: LinkedInClient,
  args: ShareStatsArgs,
): Promise<ShareStatsResult> {
  if (!args.organizationId) throw new Error("organizationId is required");
  if (!args.shareUrns.length) throw new Error("shareUrns array cannot be empty");
  const entityUrn = orgUrn(args.organizationId);
  const shares = args.shareUrns.map(encodeURIComponent).join(",");
  const response = await withRetry(() =>
    client.get("/v2/organizationalEntityShareStatistics", {
      q: "organizationalEntity",
      organizationalEntity: entityUrn,
      "shares[]": shares,
    }),
  );
  const data = await response.json();
  return { organizationId: args.organizationId, shareStats: data };
}
