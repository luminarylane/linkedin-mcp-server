import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { checkRateLimit, withRetry, WRITE_TOOL_NAMES } from "./rate-limiter.js";

describe("checkRateLimit", () => {
  it("allows read requests under the global limit", () => {
    const result = checkRateLimit("linkedin_get_post_analytics");
    expect(result.allowed).toBe(true);
  });

  it("allows SENSE tool requests", () => {
    const result = checkRateLimit("linkedin_get_org_analytics");
    expect(result.allowed).toBe(true);
  });

  it("allows write requests and consumes write bucket tokens", () => {
    const result = checkRateLimit("linkedin_create_post");
    expect(result.allowed).toBe(true);
  });

  it("allows comment requests", () => {
    const result = checkRateLimit("linkedin_comment");
    expect(result.allowed).toBe(true);
  });

  it("allows react requests", () => {
    const result = checkRateLimit("linkedin_react");
    expect(result.allowed).toBe(true);
  });

  it("treats unknown tool names as global reads", () => {
    const result = checkRateLimit("linkedin_unknown_tool");
    expect(result.allowed).toBe(true);
  });

  it("denies requests when write short bucket is exhausted", () => {
    // writeShortBucket has 10 tokens; linkedin_delete_post costs 1 each
    for (let i = 0; i < 10; i++) {
      const r = checkRateLimit("linkedin_delete_post");
      expect(r.allowed).toBe(true);
    }
    const denied = checkRateLimit("linkedin_delete_post");
    expect(denied.allowed).toBe(false);
    expect(!denied.allowed && denied.retryAfterMs).toBeGreaterThan(0);
  });

  it("denies requests when global bucket is exhausted", () => {
    // global bucket has 100 tokens; exhaust via unknown tool (only hits global)
    for (let i = 0; i < 100; i++) {
      checkRateLimit("linkedin_unknown_tool");
    }
    const denied = checkRateLimit("linkedin_unknown_tool");
    expect(denied.allowed).toBe(false);
    expect(!denied.allowed && denied.retryAfterMs).toBeGreaterThan(0);
  });
});

describe("WRITE_TOOL_NAMES", () => {
  it("contains exactly 5 write tools", () => {
    expect(WRITE_TOOL_NAMES.size).toBe(5);
  });

  it("contains all expected write tools", () => {
    expect(WRITE_TOOL_NAMES.has("linkedin_create_post")).toBe(true);
    expect(WRITE_TOOL_NAMES.has("linkedin_comment")).toBe(true);
    expect(WRITE_TOOL_NAMES.has("linkedin_react")).toBe(true);
    expect(WRITE_TOOL_NAMES.has("linkedin_share")).toBe(true);
    expect(WRITE_TOOL_NAMES.has("linkedin_delete_post")).toBe(true);
  });

  it("does not contain read tools", () => {
    expect(WRITE_TOOL_NAMES.has("linkedin_get_org_analytics")).toBe(false);
    expect(WRITE_TOOL_NAMES.has("linkedin_get_post_analytics")).toBe(false);
    expect(WRITE_TOOL_NAMES.has("linkedin_get_comments")).toBe(false);
    expect(WRITE_TOOL_NAMES.has("linkedin_get_mentions")).toBe(false);
    expect(WRITE_TOOL_NAMES.has("linkedin_get_follower_stats")).toBe(false);
    expect(WRITE_TOOL_NAMES.has("linkedin_get_share_stats")).toBe(false);
  });
});

describe("withRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the result on first success", async () => {
    const result = await withRetry(() => Promise.resolve("ok"));
    expect(result).toBe("ok");
  });

  it("throws non-429 errors immediately", async () => {
    await expect(
      withRetry(() => Promise.reject(new Error("Bad Request"))),
    ).rejects.toThrow("Bad Request");
  });

  it("retries on 429 status errors", async () => {
    let attempt = 0;
    const fn = () => {
      attempt++;
      if (attempt === 1) {
        const err = new Error("rate limited") as Error & { status: number };
        err.status = 429;
        return Promise.reject(err);
      }
      return Promise.resolve("success");
    };

    const promise = withRetry(fn);
    await vi.advanceTimersByTimeAsync(2500);
    const result = await promise;
    expect(result).toBe("success");
    expect(attempt).toBe(2);
  });

  it("does not retry on errors without status 429", async () => {
    const fn = () => {
      return Promise.reject(new Error("HTTP 429 Too Many Requests"));
    };

    await expect(withRetry(fn)).rejects.toThrow("HTTP 429 Too Many Requests");
  });

  it("throws after exhausting all retries on 429", async () => {
    let attempts = 0;
    const fn = () => {
      attempts++;
      const err = new Error("rate limited") as Error & { status: number };
      err.status = 429;
      return Promise.reject(err);
    };

    const promise = withRetry(fn).catch((e: Error) => e);
    // Advance through all 3 retry backoffs: 2s + 4s + 8s
    await vi.advanceTimersByTimeAsync(2500);
    await vi.advanceTimersByTimeAsync(4500);
    await vi.advanceTimersByTimeAsync(8500);
    const result = await promise;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe("rate limited");
    expect(attempts).toBe(4); // 1 initial + 3 retries
  });
});
