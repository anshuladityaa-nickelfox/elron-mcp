import { createClient } from "npm:@supabase/supabase-js@2"

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "https://vqbawakmcbnotxfltrws.supabase.co"

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, Accept",
  "Access-Control-Expose-Headers": "WWW-Authenticate",
}

// ── Crypto helpers ────────────────────────────────────────────────────────────

function generateCode(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("")
}

async function verifyPKCE(verifier: string, challenge: string): Promise<boolean> {
  const data = new TextEncoder().encode(verifier)
  const hashBuf = await crypto.subtle.digest("SHA-256", data)
  const b64 = btoa(String.fromCharCode(...new Uint8Array(hashBuf)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
  return b64 === challenge
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;").replace(/'/g, "&#039;")
}

// ── GET /.well-known/oauth-authorization-server ───────────────────────────────

export function handleMetadata(baseUrl: string): Response {
  return new Response(JSON.stringify({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  }), { headers: { "Content-Type": "application/json", ...CORS } })
}

// ── GET /.well-known/oauth-protected-resource ─────────────────────────────────

export function handleProtectedResource(baseUrl: string): Response {
  return new Response(JSON.stringify({
    resource: baseUrl,
    authorization_servers: [baseUrl],
  }), { headers: { "Content-Type": "application/json", ...CORS } })
}

// ── GET /authorize — show email form ─────────────────────────────────────────

export function handleAuthorizeGet(url: URL): Response {
  const p = {
    redirectUri:    url.searchParams.get("redirect_uri") || "",
    codeChallenge:  url.searchParams.get("code_challenge") || "",
    state:          url.searchParams.get("state") || "",
    clientId:       url.searchParams.get("client_id") || "",
  }
  return new Response(emailFormHtml(p), {
    headers: { "Content-Type": "text/html; charset=utf-8", ...CORS },
  })
}

// ── POST /authorize — send OTP or verify OTP ─────────────────────────────────

export async function handleAuthorizePost(req: Request): Promise<Response> {
  const form = await req.formData()
  const action        = form.get("action")        as string
  const email         = form.get("email")         as string
  const redirectUri   = form.get("redirect_uri")  as string
  const codeChallenge = form.get("code_challenge") as string
  const state         = form.get("state")         as string
  const clientId      = form.get("client_id")     as string

  const anon = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
    auth: { persistSession: false },
  })

  // ── Step 1: send OTP ────────────────────────────────────────────────────────
  if (action === "send_otp") {
    const { error } = await anon.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false },
    })
    if (error) {
      return html(emailFormHtml({ redirectUri, codeChallenge, state, clientId, error: error.message }))
    }
    return html(otpFormHtml({ email, redirectUri, codeChallenge, state, clientId, error: "" }))
  }

  // ── Step 2: verify OTP ──────────────────────────────────────────────────────
  if (action === "verify_otp") {
    const otp = form.get("otp") as string
    const { data, error } = await anon.auth.verifyOtp({ email, token: otp, type: "email" })

    if (error || !data.session) {
      return html(otpFormHtml({
        email, redirectUri, codeChallenge, state, clientId,
        error: error?.message || "Invalid code. Please try again.",
      }))
    }

    // Store a one-time auth code tied to the user's tokens
    const svc = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false },
    })

    const code = generateCode()
    const { error: dbErr } = await svc.from("mcp_auth_codes").insert({
      code,
      user_id:       data.user!.id,
      access_token:  data.session.access_token,
      refresh_token: data.session.refresh_token,
      code_challenge: codeChallenge,
      expires_at:    new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    })

    if (dbErr) {
      return html(otpFormHtml({
        email, redirectUri, codeChallenge, state, clientId,
        error: "Internal error saving session. Please try again.",
      }))
    }

    // Redirect back to Claude with the auth code
    const dest = new URL(redirectUri)
    dest.searchParams.set("code", code)
    if (state) dest.searchParams.set("state", state)

    return new Response(null, { status: 302, headers: { Location: dest.toString() } })
  }

  return new Response("Bad Request", { status: 400 })
}

// ── POST /token — exchange code + PKCE verifier for tokens ───────────────────

export async function handleToken(req: Request): Promise<Response> {
  // Accept both form-encoded and JSON bodies
  let body: Record<string, string>
  const ct = req.headers.get("content-type") || ""
  if (ct.includes("application/x-www-form-urlencoded")) {
    body = Object.fromEntries(new URLSearchParams(await req.text())) as Record<string, string>
  } else {
    try { body = await req.json() } catch {
      return tokenError(400, "invalid_request", "Could not parse request body")
    }
  }

  const { grant_type, code, code_verifier } = body

  if (grant_type !== "authorization_code") {
    return tokenError(400, "unsupported_grant_type")
  }
  if (!code || !code_verifier) {
    return tokenError(400, "invalid_request", "Missing code or code_verifier")
  }

  const svc = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  })

  const { data: row, error: lookupErr } = await svc
    .from("mcp_auth_codes")
    .select("*")
    .eq("code", code)
    .single()

  if (lookupErr || !row) {
    return tokenError(400, "invalid_grant", "Code not found")
  }

  if (new Date(row.expires_at) < new Date()) {
    await svc.from("mcp_auth_codes").delete().eq("code", code)
    return tokenError(400, "invalid_grant", "Code expired")
  }

  if (!await verifyPKCE(code_verifier, row.code_challenge)) {
    return tokenError(400, "invalid_grant", "PKCE verification failed")
  }

  // One-time use — delete after exchange
  await svc.from("mcp_auth_codes").delete().eq("code", code)

  return new Response(JSON.stringify({
    access_token:  row.access_token,
    refresh_token: row.refresh_token,
    token_type:    "bearer",
    expires_in:    3600,
  }), { headers: { "Content-Type": "application/json", ...CORS } })
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function html(body: string): Response {
  return new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" } })
}

function tokenError(status: number, error: string, description?: string): Response {
  return new Response(
    JSON.stringify({ error, ...(description ? { error_description: description } : {}) }),
    { status, headers: { "Content-Type": "application/json", ...CORS } }
  )
}

// ── HTML templates ────────────────────────────────────────────────────────────

const sharedStyles = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .card { background: white; border-radius: 12px; padding: 40px; width: 100%; max-width: 400px; box-shadow: 0 2px 16px rgba(0,0,0,0.08); }
  .logo { font-size: 24px; font-weight: 700; color: #1a1a1a; margin-bottom: 8px; }
  .subtitle { color: #666; font-size: 14px; margin-bottom: 32px; }
  label { display: block; font-size: 13px; font-weight: 500; color: #444; margin-bottom: 6px; }
  button { width: 100%; padding: 11px; background: #6366f1; color: white; border: none; border-radius: 8px; font-size: 15px; font-weight: 500; cursor: pointer; margin-top: 16px; }
  button:hover { background: #4f46e5; }
  .error { background: #fef2f2; color: #dc2626; font-size: 13px; padding: 10px 14px; border-radius: 8px; margin-bottom: 16px; }
  .info  { background: #f0fdf4; color: #166534; font-size: 13px; padding: 10px 14px; border-radius: 8px; margin-bottom: 20px; }
`

interface EmailFormProps {
  redirectUri: string; codeChallenge: string; state: string; clientId: string; error?: string
}

function emailFormHtml(p: EmailFormProps): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Elron — Sign In</title><style>${sharedStyles}
  input[type="email"] { width: 100%; padding: 10px 14px; border: 1px solid #ddd; border-radius: 8px; font-size: 15px; outline: none; }
  input[type="email"]:focus { border-color: #6366f1; }
</style></head><body><div class="card">
  <div class="logo">Elron</div>
  <p class="subtitle">Sign in to connect Claude to your workspace</p>
  ${p.error ? `<div class="error">${escapeHtml(p.error)}</div>` : ""}
  <form method="POST">
    <input type="hidden" name="action" value="send_otp">
    <input type="hidden" name="redirect_uri" value="${escapeHtml(p.redirectUri)}">
    <input type="hidden" name="code_challenge" value="${escapeHtml(p.codeChallenge)}">
    <input type="hidden" name="state" value="${escapeHtml(p.state)}">
    <input type="hidden" name="client_id" value="${escapeHtml(p.clientId)}">
    <label for="email">Email address</label>
    <input type="email" id="email" name="email" placeholder="you@company.com" required autofocus>
    <button type="submit">Send OTP</button>
  </form>
</div></body></html>`
}

interface OtpFormProps {
  email: string; redirectUri: string; codeChallenge: string; state: string; clientId: string; error: string
}

function otpFormHtml(p: OtpFormProps): string {
  const backHref = `?response_type=code&redirect_uri=${encodeURIComponent(p.redirectUri)}&code_challenge=${encodeURIComponent(p.codeChallenge)}&state=${encodeURIComponent(p.state)}&client_id=${encodeURIComponent(p.clientId)}`
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Elron — Enter Code</title><style>${sharedStyles}
  input[type="text"] { width: 100%; padding: 10px 14px; border: 1px solid #ddd; border-radius: 8px; font-size: 22px; letter-spacing: 10px; text-align: center; outline: none; }
  input[type="text"]:focus { border-color: #6366f1; }
  .back { text-align: center; margin-top: 16px; font-size: 13px; color: #666; }
  .back a { color: #6366f1; text-decoration: none; }
</style></head><body><div class="card">
  <div class="logo">Elron</div>
  <p class="subtitle">Sign in to connect Claude to your workspace</p>
  <div class="info">OTP sent to <strong>${escapeHtml(p.email)}</strong></div>
  ${p.error ? `<div class="error">${escapeHtml(p.error)}</div>` : ""}
  <form method="POST">
    <input type="hidden" name="action" value="verify_otp">
    <input type="hidden" name="email" value="${escapeHtml(p.email)}">
    <input type="hidden" name="redirect_uri" value="${escapeHtml(p.redirectUri)}">
    <input type="hidden" name="code_challenge" value="${escapeHtml(p.codeChallenge)}">
    <input type="hidden" name="state" value="${escapeHtml(p.state)}">
    <input type="hidden" name="client_id" value="${escapeHtml(p.clientId)}">
    <label for="otp">6-digit code from your email</label>
    <input type="text" id="otp" name="otp" placeholder="000000" maxlength="6" pattern="[0-9]{6}" inputmode="numeric" required autofocus>
    <button type="submit">Verify</button>
  </form>
  <p class="back"><a href="${backHref}">← Use a different email</a></p>
</div></body></html>`
}
