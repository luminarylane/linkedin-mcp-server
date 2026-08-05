/**
 * Public surface for non-MCP consumers (web app importing via the
 * `@linkedin-mcp/lib` webpack alias).
 */
export * from "./insights.js";
export {
  LinkedInClient,
  createClient,
  personUrn,
  orgUrn,
} from "../client.js";
