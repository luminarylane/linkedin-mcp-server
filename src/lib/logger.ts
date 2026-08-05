/**
 * Lightweight console-based logger for the LinkedIn MCP server.
 *
 * Lives in `lib/` because rate-limiter and other shared modules use it; that
 * path is also imported by the web app via the `@linkedin-mcp` alias, so it
 * must stay free of heavy server-only deps (e.g. pino) to keep the web
 * bundle slim and avoid forcing every consumer to install transitive deps.
 */

const service = "linkedin-mcp-server";
const environment = process.env.NODE_ENV || "development";

type LogFn = (msg: string | Record<string, unknown>, ...rest: unknown[]) => void;

function emit(level: "info" | "warn" | "error" | "debug"): LogFn {
  return (msg, ...rest) => {
    const base = { service, environment, level };
    const payload = typeof msg === "string" ? { ...base, msg } : { ...base, ...msg };
    const line = JSON.stringify(payload);
    if (level === "error") console.error(line, ...rest);
    else if (level === "warn") console.warn(line, ...rest);
    else console.log(line, ...rest);
  };
}

const logger = {
  info: emit("info"),
  warn: emit("warn"),
  error: emit("error"),
  debug: emit("debug"),
};

export default logger;
