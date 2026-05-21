/**
 * Token-bucket rate limiter for LinkedIn API.
 *
 * LinkedIn doesn't publish exact rate limits. Conservative estimates:
 *   - Global: ~100 requests per 24 hours (basic tier)
 *   - Read: ~60 requests per hour
 *   - Write daily: ~25 creates/comments/reactions per 24 hours
 *   - Write short: ~10 burst writes per hour
 *
 * This is a simple in-memory implementation — no external dependencies.
 */

interface BucketConfig {
  maxTokens: number;
  refillRate: number; // tokens per millisecond
}

class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number;

  constructor(config: BucketConfig) {
    this.maxTokens = config.maxTokens;
    this.refillRate = config.refillRate;
    this.tokens = config.maxTokens;
    this.lastRefill = Date.now();
  }

  tryConsume(cost = 1): boolean {
    this.refill();
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return true;
    }
    return false;
  }

  msUntilAvailable(cost = 1): number {
    this.refill();
    if (this.tokens >= cost) return 0;
    const deficit = cost - this.tokens;
    return Math.ceil(deficit / this.refillRate);
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const newTokens = elapsed * this.refillRate;
    this.tokens = Math.min(this.maxTokens, this.tokens + newTokens);
    this.lastRefill = now;
  }
}

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const globalBucket = new TokenBucket({
  maxTokens: 100,
  refillRate: 100 / ONE_DAY_MS,
});
const readShortBucket = new TokenBucket({
  maxTokens: 60,
  refillRate: 60 / ONE_HOUR_MS,
});
const writeDailyBucket = new TokenBucket({
  maxTokens: 25,
  refillRate: 25 / ONE_DAY_MS,
});
const writeShortBucket = new TokenBucket({
  maxTokens: 10,
  refillRate: 10 / ONE_HOUR_MS,
});

type WriteBucket = "writeDaily" | "writeShort" | "global";

const WRITE_COSTS: Record<string, { bucket: WriteBucket; cost: number }> = {
  linkedin_create_post: { bucket: "writeDaily", cost: 1 },
  linkedin_comment: { bucket: "writeDaily", cost: 1 },
  linkedin_react: { bucket: "writeDaily", cost: 1 },
  linkedin_share: { bucket: "writeDaily", cost: 1 },
  linkedin_delete_post: { bucket: "writeShort", cost: 1 },
};

/** Set of tool names classified as write operations. Derived from WRITE_COSTS. */
export const WRITE_TOOL_NAMES = new Set(Object.keys(WRITE_COSTS));

const READ_TOOLS = new Set([
  "linkedin_get_org_analytics",
  "linkedin_get_post_analytics",
  "linkedin_get_comments",
  "linkedin_get_mentions",
  "linkedin_get_follower_stats",
  "linkedin_get_share_stats",
]);

const writeBuckets: Record<WriteBucket, TokenBucket> = {
  writeDaily: writeDailyBucket,
  writeShort: writeShortBucket,
  global: globalBucket,
};

const MAX_WAIT_MS = 60_000;
const MAX_429_RETRIES = 3;

/**
 * Check if a request is allowed under rate limits.
 * Uses peek-then-consume: checks all required buckets first, only consumes
 * tokens when all buckets have capacity.
 */
export function checkRateLimit(
  toolName?: string,
  overrideCost?: number,
): { allowed: true } | { allowed: false; retryAfterMs: number } {
  const isWrite = toolName ? WRITE_TOOL_NAMES.has(toolName) : false;

  const cost = overrideCost ?? (isWrite && toolName ? WRITE_COSTS[toolName].cost : 1);
  const globalWait = globalBucket.msUntilAvailable(cost);
  if (globalWait > 0) return { allowed: false, retryAfterMs: globalWait };

  if (isWrite && toolName) {
    const entry = WRITE_COSTS[toolName];
    const bucket = writeBuckets[entry.bucket];

    const writeWait = bucket.msUntilAvailable(cost);
    if (writeWait > 0) return { allowed: false, retryAfterMs: writeWait };

    globalBucket.tryConsume(cost);
    if (bucket !== globalBucket) bucket.tryConsume(cost);
    return { allowed: true };
  }

  // Read path: use readShort bucket
  const readBucket =
    toolName && READ_TOOLS.has(toolName) ? readShortBucket : globalBucket;

  if (readBucket !== globalBucket) {
    const readWait = readBucket.msUntilAvailable();
    if (readWait > 0) return { allowed: false, retryAfterMs: readWait };
    readBucket.tryConsume();
  }

  globalBucket.tryConsume();
  return { allowed: true };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for rate limit to clear (up to 60s), then consume the token.
 */
export async function waitForRateLimit(
  toolName?: string,
  overrideCost?: number,
): Promise<{ allowed: true } | { allowed: false; retryAfterMs: number }> {
  const result = checkRateLimit(toolName, overrideCost);
  if (result.allowed) return result;

  if (result.retryAfterMs > MAX_WAIT_MS) {
    return result;
  }

  console.error(
    `[rate-limit] Waiting ${Math.ceil(result.retryAfterMs / 1000)}s for ${toolName ?? "read"} bucket...`,
  );
  await sleep(result.retryAfterMs);
  return checkRateLimit(toolName, overrideCost);
}

/**
 * Execute an API call with automatic retry on HTTP 429 from LinkedIn.
 * Detects 429 status from fetch Response or Error objects.
 */
export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (e: unknown) {
      const is429 =
        typeof e === "object" &&
        e !== null &&
        "status" in e &&
        (e as { status: number }).status === 429;

      if (!is429 || attempt === MAX_429_RETRIES) throw e;

      const backoffMs = 2000 * Math.pow(2, attempt);
      console.error(
        `[rate-limit] LinkedIn 429 — backing off ${backoffMs / 1000}s (attempt ${attempt + 1}/${MAX_429_RETRIES})...`,
      );
      await sleep(backoffMs);
    }
  }
  throw new Error("Unreachable");
}
