import { Langfuse } from "langfuse";
import type { LangfuseTraceClient } from "langfuse";
import logger from "./logger.js";

let langfuse: Langfuse | null = null;
let sessionTrace: LangfuseTraceClient | null = null;

/** Return a shared Langfuse client, or null when credentials are missing. */
export function getLangfuse(): Langfuse | null {
  if (langfuse) return langfuse;
  if (!process.env.LANGFUSE_SECRET_KEY) return null;
  langfuse = new Langfuse();
  logger.info("[Langfuse] Tracing enabled");
  return langfuse;
}

/** Get or create a long-lived trace for this stdio session. */
export function getSessionTrace(serverName: string): LangfuseTraceClient | null {
  if (sessionTrace) return sessionTrace;
  const lf = getLangfuse();
  if (!lf) return null;
  sessionTrace = lf.trace({
    name: "mcp-session",
    tags: [process.env.APP_ENV || process.env.NODE_ENV || "development"],
    metadata: { server: serverName },
  });
  return sessionTrace;
}

/** Flush pending spans. */
export async function flushLangfuse(): Promise<void> {
  if (langfuse) await langfuse.flushAsync();
}

/** Shut down the Langfuse client. */
export async function shutdownLangfuse(): Promise<void> {
  if (langfuse) await langfuse.shutdownAsync();
}
