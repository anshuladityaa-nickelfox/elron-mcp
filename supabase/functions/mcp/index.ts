import { createClient } from "npm:@supabase/supabase-js@2"
import { validateAuth } from "./auth.ts"
import { loadUserContext } from "./permissions.ts"
import { buildAllTools } from "./tools/index.ts"
import { MCPRequest, MCPResponse, MCPTool } from "./types.ts"
import {
  handleMetadata,
  handleProtectedResource,
  handleAuthorizeGet,
  handleAuthorizePost,
  handleToken,
} from "./oauth.ts"

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "https://vqbawakmcbnotxfltrws.supabase.co"
const SERVER_INFO = { name: "elron-mcp", version: "1.0.0" }
const PROTOCOL_VERSION = "2024-11-05"

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, Accept",
  "Access-Control-Expose-Headers": "WWW-Authenticate",
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  })
}

function mcpError(id: string | number | undefined, code: number, message: string): MCPResponse {
  return { jsonrpc: "2.0", id, error: { code, message } }
}

async function handleMessage(msg: MCPRequest, tools: MCPTool[]): Promise<MCPResponse> {
  const { id, method, params } = msg

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0", id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        },
      }

    case "notifications/initialized":
    case "initialized":
      return { jsonrpc: "2.0", id }

    case "ping":
      return { jsonrpc: "2.0", id, result: {} }

    case "tools/list":
      return {
        jsonrpc: "2.0", id,
        result: {
          tools: tools.map(t => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        },
      }

    case "tools/call": {
      const toolName = (params as any)?.name as string
      const args = ((params as any)?.arguments ?? {}) as Record<string, unknown>
      const tool = tools.find(t => t.name === toolName)
      if (!tool) return mcpError(id, -32601, `Tool not found: ${toolName}`)
      try {
        const result = await tool.handler(args)
        return {
          jsonrpc: "2.0", id,
          result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] },
        }
      } catch (err: any) {
        return mcpError(id, -32000, err.message ?? "Tool execution failed")
      }
    }

    default:
      return mcpError(id, -32601, `Method not found: ${method}`)
  }
}

// ── Main request handler ──────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const url = new URL(req.url)

  // Base URL of this function — force https (Supabase terminates TLS before the function)
  const baseUrl = `https://${url.hostname}/functions/v1/mcp`

  // Normalize path: strip /functions/v1/mcp prefix if present, or use as-is
  const rawPath = url.pathname
  const subPath = rawPath.replace(/^\/functions\/v1\/mcp/, "") || "/"

  // Preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  // ── OAuth 2.1 discovery endpoints ────────────────────────────────────────
  if (rawPath.includes("/.well-known/oauth-authorization-server")) {
    return handleMetadata(baseUrl)
  }

  if (rawPath.includes("/.well-known/oauth-protected-resource")) {
    return handleProtectedResource(baseUrl)
  }

  // ── OAuth consent + token endpoints ──────────────────────────────────────
  if (rawPath.endsWith("/authorize")) {
    if (req.method === "GET")  return handleAuthorizeGet(url)
    if (req.method === "POST") return handleAuthorizePost(req)
    return new Response("Method Not Allowed", { status: 405 })
  }

  if (rawPath.endsWith("/token") && req.method === "POST") {
    return handleToken(req)
  }

  // ── Health check ──────────────────────────────────────────────────────────
  if (req.method === "GET") {
    return jsonResponse({ status: "ok", server: SERVER_INFO })
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405)
  }

  // ── MCP endpoint (POST /) ─────────────────────────────────────────────────

  // Validate Bearer token — if missing, return 401 with discovery hint
  const authResult = await validateAuth(req)
  if (!authResult.success) {
    return new Response(
      JSON.stringify(mcpError(undefined, -32001, authResult.error)),
      {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "WWW-Authenticate": `Bearer realm="Elron MCP", resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
          ...CORS_HEADERS,
        },
      }
    )
  }

  const { userId, token } = authResult

  // Create Supabase client scoped to this user — RLS is enforced on every query
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!
  const userClient = createClient(SUPABASE_URL, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  })

  const ctx = await loadUserContext(userClient, userId)

  if (ctx.businessUnitIds.length === 0) {
    return jsonResponse(
      mcpError(undefined, -32002, "No accepted business unit memberships found for this user"),
      403
    )
  }

  // Build the tool list for this specific user (permission-gated)
  const tools = buildAllTools(userClient, ctx)

  // Parse MCP request body (single message or batch array)
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return jsonResponse(mcpError(undefined, -32700, "Parse error: invalid JSON"), 400)
  }

  if (Array.isArray(body)) {
    const responses = await Promise.all(body.map((msg: MCPRequest) => handleMessage(msg, tools)))
    return jsonResponse(responses)
  }

  const response = await handleMessage(body as MCPRequest, tools)
  return jsonResponse(response)
})
