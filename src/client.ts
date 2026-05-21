/**
 * Fetch-based LinkedIn API client with multi-step upload helpers.
 *
 * No SDK — uses raw fetch against the LinkedIn REST API.
 *
 * Two different APIs:
 *   - UGC API (/v2/ugcPosts) — text, image, and video posts
 *   - Posts API (/rest/posts) — document posts (requires LinkedIn-Version header)
 */

import { createHash } from "node:crypto";

const API_BASE = "https://api.linkedin.com";
const LINKEDIN_VERSION = "202503"; // YYYYMM format, updated monthly
const REQUEST_TIMEOUT = 30_000; // 30s for standard requests
const UPLOAD_TIMEOUT = 60_000; // 60s for binary uploads
const VIDEO_UPLOAD_TIMEOUT = 300_000; // 5 min for video uploads

// --- Client cache ---

export const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const MAX_CACHE_SIZE = 50;

interface CachedClient {
  client: LinkedInClient;
  createdAt: number;
}

const clientCache = new Map<string, CachedClient>();

export function credentialHash(accessToken: string): string {
  return createHash("sha256").update(accessToken).digest("hex").slice(0, 16);
}

// --- URN helpers ---

export function personUrn(id: string): string {
  return `urn:li:person:${id}`;
}

export function orgUrn(id: string): string {
  return `urn:li:organization:${id}`;
}

// --- LinkedIn API client ---

export class LinkedInClient {
  constructor(private readonly accessToken: string) {}

  private headers(usePostsApi = false): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.accessToken}`,
      "Content-Type": "application/json",
      "X-Restli-Protocol-Version": "2.0.0",
    };
    if (usePostsApi) {
      h["LinkedIn-Version"] = LINKEDIN_VERSION;
    }
    return h;
  }

  async get(
    path: string,
    params?: Record<string, string>,
    usePostsApi = false,
  ): Promise<Response> {
    const url = new URL(`${API_BASE}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: this.headers(usePostsApi),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });
    if (!response.ok) {
      await this.throwApiError(response, `GET ${path}`);
    }
    return response;
  }

  async post(
    path: string,
    body: unknown,
    usePostsApi = false,
  ): Promise<Response> {
    const response = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: this.headers(usePostsApi),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });
    if (!response.ok) {
      await this.throwApiError(response, `POST ${path}`);
    }
    return response;
  }

  async delete(path: string, usePostsApi = false): Promise<Response> {
    const response = await fetch(`${API_BASE}${path}`, {
      method: "DELETE",
      headers: this.headers(usePostsApi),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });
    if (!response.ok) {
      await this.throwApiError(response, `DELETE ${path}`);
    }
    return response;
  }

  /** GET /v2/userinfo — returns { sub, name, email, picture } */
  async getMe(): Promise<{ id: string; name: string }> {
    const response = await this.get("/v2/userinfo");
    const data = (await response.json()) as Record<string, unknown>;
    if (!data.sub || typeof data.sub !== "string") {
      throw new Error(
        "LinkedIn /v2/userinfo did not return a 'sub' field. " +
          "Ensure the access token has the 'openid' scope.",
      );
    }
    return { id: data.sub, name: String(data.name ?? "Unknown") };
  }

  /** Post a comment on a LinkedIn post. Returns comment ID from x-restli-id header. */
  async postComment(
    postUrn: string,
    actorUrn: string,
    text: string,
  ): Promise<string> {
    const encodedUrn = encodeURIComponent(postUrn);
    const response = await fetch(
      `${API_BASE}/v2/socialActions/${encodedUrn}/comments`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          actor: actorUrn,
          message: { text },
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      },
    );

    if (!response.ok) {
      await this.throwApiError(response, "Post comment");
    }

    const commentId = response.headers.get("x-restli-id");

    if (!commentId) {
      throw new Error(
        `Comment may have been posted (HTTP ${response.status}) but x-restli-id header is missing. ` +
          `Cannot confirm comment creation.`,
      );
    }

    return commentId;
  }

  /** React (like) a LinkedIn post. */
  async react(postUrn: string, actorUrn: string): Promise<void> {
    const encodedUrn = encodeURIComponent(postUrn);
    const response = await fetch(
      `${API_BASE}/v2/socialActions/${encodedUrn}/likes`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          actor: actorUrn,
          object: postUrn,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      },
    );

    if (!response.ok) {
      await this.throwApiError(response, "React to post");
    }
  }

  /**
   * Upload image to LinkedIn (3-step flow).
   * Returns the assetUrn for use in UGC post payload.
   */
  async uploadImage(imageUrl: string, ownerUrn: string): Promise<string> {
    const buffer = await this.downloadMedia(imageUrl, 10, REQUEST_TIMEOUT);
    const { uploadUrl, assetUrn } = await this.registerMediaUpload(
      "feedshare-image",
      ownerUrn,
    );
    await this.putBinary(
      uploadUrl,
      buffer,
      "application/octet-stream",
      UPLOAD_TIMEOUT,
    );
    return assetUrn;
  }

  /**
   * Upload video to LinkedIn (3-step flow, same as image but different recipe).
   * Returns the assetUrn.
   */
  async uploadVideo(videoUrl: string, ownerUrn: string): Promise<string> {
    const buffer = await this.downloadMedia(videoUrl, 200, 120_000);
    const { uploadUrl, assetUrn } = await this.registerMediaUpload(
      "feedshare-video",
      ownerUrn,
    );
    await this.putBinary(
      uploadUrl,
      buffer,
      "application/octet-stream",
      VIDEO_UPLOAD_TIMEOUT,
    );
    return assetUrn;
  }

  /**
   * Upload document (PDF) to LinkedIn.
   * Uses the Posts API (/rest/documents) — different from UGC API.
   */
  async uploadDocument(documentUrl: string, ownerUrn: string): Promise<string> {
    const pdfBuffer = await this.downloadMedia(
      documentUrl,
      100,
      UPLOAD_TIMEOUT,
    );

    // Initialize upload (Posts API — needs LinkedIn-Version header)
    const initResponse = await fetch(
      `${API_BASE}/rest/documents?action=initializeUpload`,
      {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify({
          initializeUploadRequest: { owner: ownerUrn },
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      },
    );

    if (!initResponse.ok) {
      await this.throwApiError(initResponse, "Initialize document upload");
    }

    const initResult = (await initResponse.json()) as Record<string, unknown>;
    const initValue = initResult?.value as
      | { uploadUrl?: string; document?: string }
      | undefined;
    if (!initValue?.uploadUrl || !initValue?.document) {
      throw new Error(
        `LinkedIn document upload init returned unexpected structure. ` +
          `Expected value.uploadUrl and value.document. Got keys: ${Object.keys(initValue ?? {}).join(", ")}`,
      );
    }

    await this.putBinary(
      initValue.uploadUrl,
      pdfBuffer,
      "application/pdf",
      UPLOAD_TIMEOUT,
    );
    return initValue.document;
  }

  // --- Private helpers ---

  private validateMediaUrl(url: string): void {
    const parsed = new URL(url);
    if (!["https:", "http:"].includes(parsed.protocol)) {
      throw new Error(`Unsupported protocol: ${parsed.protocol}`);
    }
    const hostname = parsed.hostname;

    // Block well-known internal hostnames
    const blocked = [
      "169.254.169.254",
      "metadata.google.internal",
      "127.0.0.1",
      "localhost",
      "[::1]",
      "0.0.0.0",
    ];
    if (blocked.includes(hostname)) {
      throw new Error(`Blocked host: ${hostname}`);
    }

    // Block RFC 1918 private IP ranges + link-local
    const ipMatch = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (ipMatch) {
      const [a, b] = [Number(ipMatch[1]), Number(ipMatch[2])];
      if (
        a === 10 ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        a === 0 ||
        (a === 169 && b === 254)
      ) {
        throw new Error(`Blocked private IP: ${hostname}`);
      }
    }

    // Block IPv6 private/loopback (bracketed in URLs)
    if (hostname.startsWith("[")) {
      const ipv6 = hostname.slice(1, -1).toLowerCase();
      if (
        ipv6 === "::" ||
        ipv6.startsWith("fc") ||
        ipv6.startsWith("fd") ||
        ipv6.startsWith("fe80")
      ) {
        throw new Error(`Blocked private IPv6: ${hostname}`);
      }
    }
  }

  private async downloadMedia(
    url: string,
    maxSizeMB: number,
    timeoutMs: number,
  ): Promise<Buffer> {
    this.validateMediaUrl(url);
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(
        `Failed to download media from ${url}: HTTP ${response.status}`,
      );
    }
    // Early reject via Content-Length before buffering the full body
    const maxBytes = maxSizeMB * 1024 * 1024;
    const contentLength = response.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > maxBytes) {
      await response.body?.cancel();
      throw Object.assign(
        new Error(
          `File too large: ${contentLength} bytes (max ${maxSizeMB}MB)`,
        ),
        { status: 413 },
      );
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw Object.assign(
        new Error(
          `File too large: ${buffer.length} bytes (max ${maxSizeMB}MB)`,
        ),
        { status: 413 },
      );
    }
    return buffer;
  }

  private async registerMediaUpload(
    recipe: string,
    ownerUrn: string,
  ): Promise<{ uploadUrl: string; assetUrn: string }> {
    const registerResponse = await fetch(
      `${API_BASE}/v2/assets?action=registerUpload`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          registerUploadRequest: {
            recipes: [`urn:li:digitalmediaRecipe:${recipe}`],
            owner: ownerUrn,
            serviceRelationships: [
              {
                relationshipType: "OWNER",
                identifier: "urn:li:userGeneratedContent",
              },
            ],
          },
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      },
    );

    if (!registerResponse.ok) {
      await this.throwApiError(registerResponse, `Register ${recipe} upload`);
    }

    const result = (await registerResponse.json()) as Record<string, unknown>;
    const value = result?.value as Record<string, unknown> | undefined;
    if (!value?.uploadMechanism || !value.asset) {
      throw new Error(
        `LinkedIn register upload returned unexpected response. ` +
          `Expected value.uploadMechanism and value.asset. Got keys: ${Object.keys(value ?? {}).join(", ")}`,
      );
    }

    const mechanisms = value.uploadMechanism as Record<string, unknown>;
    const mechanism = mechanisms[
      "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"
    ] as { uploadUrl?: string } | undefined;
    if (!mechanism?.uploadUrl) {
      throw new Error(
        `LinkedIn register upload missing uploadUrl. ` +
          `Available mechanisms: ${Object.keys(mechanisms).join(", ")}`,
      );
    }

    return {
      uploadUrl: mechanism.uploadUrl,
      assetUrn: String(value.asset),
    };
  }

  private validateUploadUrl(url: string): void {
    const parsed = new URL(url);
    const allowed = [".linkedin.com", ".licdn.com"];
    if (!allowed.some((d) => parsed.hostname.endsWith(d))) {
      throw new Error(
        `Upload URL points to unexpected host: ${parsed.hostname}`,
      );
    }
  }

  private async putBinary(
    uploadUrl: string,
    body: Buffer,
    contentType: string,
    timeoutMs: number,
  ): Promise<void> {
    this.validateUploadUrl(uploadUrl);
    const response = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": contentType,
      },
      body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength) as unknown as BodyInit,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      let detail: string;
      try {
        detail = await response.text();
      } catch {
        detail = "(could not read error body)";
      }
      throw Object.assign(
        new Error(
          `Binary upload failed at PUT ${uploadUrl.split("?")[0]}: HTTP ${response.status} — ${detail.slice(0, 500)}`,
        ),
        { status: response.status, detail },
      );
    }
  }

  private async throwApiError(
    response: Response,
    context: string,
  ): Promise<never> {
    let detail: string;
    try {
      detail = await response.text();
    } catch {
      detail = "(could not read error body)";
    }
    const err = new Error(
      `LinkedIn API error ${response.status} (${context}): ${detail}`,
    );
    (err as Error & { status: number }).status = response.status;
    (err as Error & { detail: string }).detail = detail;
    throw err;
  }
}

// --- Factory ---

function evictStale(cache: Map<string, { createdAt: number }>): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.createdAt >= CACHE_TTL_MS) {
      cache.delete(key);
    }
  }
}

export function createClient(accessToken: string): LinkedInClient {
  const key = credentialHash(accessToken);

  // Check cache
  const cached = clientCache.get(key);
  if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
    return cached.client;
  }

  // Evict stale entries before adding
  evictStale(clientCache);
  if (clientCache.size >= MAX_CACHE_SIZE) {
    const oldest = clientCache.keys().next().value!;
    clientCache.delete(oldest);
  }

  const client = new LinkedInClient(accessToken);
  clientCache.set(key, { client, createdAt: Date.now() });
  return client;
}
