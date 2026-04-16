#!/usr/bin/env node
/**
 * Elron MCP Server
 * Authentication happens directly in Claude chat via OTP.
 * No browser, no consent page, no terminal setup needed.
 */

import { createClient } from "@supabase/supabase-js"
import { readFileSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { createInterface } from "readline"

const SUPABASE_URL  = "https://vqbawakmcbnotxfltrws.supabase.co"
const SUPABASE_ANON = "sb_publishable_FfAQQJezc2qaWAixOvtzvQ_ld3vU-7m"

const SESSION_DIR  = join(homedir(), ".elron-mcp")
const SESSION_FILE = join(SESSION_DIR, "session.json")

// ── Session helpers ───────────────────────────────────────────────────────────
function loadSession() {
  try { return JSON.parse(readFileSync(SESSION_FILE, "utf8")) } catch { return null }
}

function saveSession(s) {
  mkdirSync(SESSION_DIR, { recursive: true })
  writeFileSync(SESSION_FILE, JSON.stringify(s, null, 2), { mode: 0o600 })
}

function anonClient() {
  return createClient(SUPABASE_URL, SUPABASE_ANON, { auth: { persistSession: false } })
}

function userClient(accessToken) {
  return createClient(SUPABASE_URL, SUPABASE_ANON, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false },
  })
}

// ── Permission loader ─────────────────────────────────────────────────────────
async function loadUserContext(client) {
  const { data: { user } } = await client.auth.getUser()
  if (!user) throw new Error("Could not get user")

  const { data: memberships, error } = await client
    .from("business_unit_members")
    .select(`
      business_unit_id, invite_status,
      custom_roles (
        custom_role_permissions (
          parent_module, sub_module,
          module_enabled, can_view, can_create, can_update, can_delete
        )
      )
    `)
    .eq("user_id", user.id)
    .eq("invite_status", "accepted")

  if (error) throw new Error("Failed to load permissions: " + error.message)

  const buIds   = (memberships || []).map(m => m.business_unit_id)
  const permMap = new Map()

  for (const m of (memberships || [])) {
    for (const p of (m.custom_roles?.custom_role_permissions || [])) {
      const key = `${p.parent_module}:${p.sub_module}`
      const ex  = permMap.get(key) || {}
      permMap.set(key, {
        parentModule:  p.parent_module,
        subModule:     p.sub_module,
        moduleEnabled: p.module_enabled || ex.moduleEnabled || false,
        canView:       p.can_view       || ex.canView       || false,
        canCreate:     p.can_create     || ex.canCreate     || false,
        canUpdate:     p.can_update     || ex.canUpdate     || false,
        canDelete:     p.can_delete     || ex.canDelete     || false,
      })
    }
  }

  return {
    userId:         user.id,
    email:          user.email,
    businessUnitIds: buIds,
    permissions:    [...permMap.values()].filter(p => p.moduleEnabled),
  }
}

function can(ctx, parent, sub, action) {
  const p = ctx.permissions.find(p => p.parentModule === parent && p.subModule === sub)
  if (!p || !p.moduleEnabled) return false
  return { view: p.canView, create: p.canCreate, update: p.canUpdate, delete: p.canDelete }[action] ?? false
}

// ── Tool builder ──────────────────────────────────────────────────────────────
function buildDataTools(client, ctx) {
  const tools = []
  const bu    = ctx.businessUnitIds

  tools.push({
    name: "get_my_access",
    description: "Show your business units and what modules you have access to.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => ({
      user: ctx.email,
      business_unit_ids: bu,
      permissions: ctx.permissions.map(p => ({
        module: `${p.parentModule}:${p.subModule}`,
        can_view: p.canView, can_create: p.canCreate,
        can_update: p.canUpdate, can_delete: p.canDelete,
      })),
    }),
  })

  // ── Clients ──────────────────────────────────────────────────────────────
  if (can(ctx, "clients", "clients", "view")) {
    tools.push({
      name: "list_clients",
      description: "List clients. Filter by status or search by name.",
      inputSchema: { type: "object", properties: {
        status: { type: "string" }, search: { type: "string" }, limit: { type: "number" }
      }},
      handler: async (a) => {
        let q = client.from("clients")
          .select("id,client_name,legal_name,country,status,default_billing_currency")
          .in("business_unit_id", bu).limit(a.limit || 50)
        if (a.status) q = q.eq("status", a.status)
        if (a.search) q = q.ilike("client_name", `%${a.search}%`)
        const { data, error } = await q
        if (error) throw new Error(error.message)
        return data
      },
    })

    tools.push({
      name: "get_client",
      description: "Get full client details including contacts.",
      inputSchema: { type: "object", required: ["client_id"], properties: { client_id: { type: "string" } } },
      handler: async (a) => {
        const { data, error } = await client.from("clients")
          .select("*, client_contacts(*), client_tax_config(*)")
          .eq("id", a.client_id).in("business_unit_id", bu).single()
        if (error) throw new Error(error.message)
        return data
      },
    })
  }

  // ── Invoices ─────────────────────────────────────────────────────────────
  if (can(ctx, "finance", "invoices", "view")) {
    tools.push({
      name: "list_invoices",
      description: "List invoices. Filter by status, client, or date range.",
      inputSchema: { type: "object", properties: {
        status: { type: "string", enum: ["unpaid","paid","partial","overdue","void"] },
        client_id: { type: "string" },
        from_date: { type: "string", description: "YYYY-MM-DD" },
        to_date:   { type: "string", description: "YYYY-MM-DD" },
        limit:     { type: "number" },
      }},
      handler: async (a) => {
        let q = client.from("invoices")
          .select("id,invoice_number,invoice_date,due_date,currency,invoice_amount_fc,status,clients(client_name)")
          .in("business_unit_id", bu).order("invoice_date", { ascending: false }).limit(a.limit || 50)
        if (a.status)    q = q.eq("status", a.status)
        if (a.client_id) q = q.eq("client_id", a.client_id)
        if (a.from_date) q = q.gte("invoice_date", a.from_date)
        if (a.to_date)   q = q.lte("invoice_date", a.to_date)
        const { data, error } = await q
        if (error) throw new Error(error.message)
        return data
      },
    })

    tools.push({
      name: "get_outstanding_invoices",
      description: "Get all unpaid and overdue invoices.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const { data, error } = await client.from("invoices")
          .select("id,invoice_number,due_date,currency,invoice_amount_fc,status,clients(client_name)")
          .in("business_unit_id", bu).in("status", ["unpaid","partial","overdue"]).order("due_date")
        if (error) throw new Error(error.message)
        return data
      },
    })
  }

  if (can(ctx, "finance", "invoices", "create")) {
    tools.push({
      name: "create_invoice",
      description: "Create a new invoice.",
      inputSchema: { type: "object", required: ["business_unit_id","client_id","project_id","invoice_date","due_date","currency","invoice_amount_fc"], properties: {
        business_unit_id: { type: "string" }, client_id: { type: "string" },
        project_id: { type: "string" }, invoice_date: { type: "string" },
        due_date: { type: "string" }, currency: { type: "string" },
        invoice_amount_fc: { type: "number" }, exchange_rate: { type: "number" }, remarks: { type: "string" },
      }},
      handler: async (a) => {
        if (!bu.includes(a.business_unit_id)) throw new Error("No access to this business unit")
        const { data, error } = await client.from("invoices").insert({ ...a, created_by: ctx.userId }).select().single()
        if (error) throw new Error(error.message)
        return data
      },
    })
  }

  // ── Payments ──────────────────────────────────────────────────────────────
  if (can(ctx, "finance", "payments", "view")) {
    tools.push({
      name: "list_payments",
      description: "List payment records. Filter by date range.",
      inputSchema: { type: "object", properties: {
        from_date: { type: "string" }, to_date: { type: "string" }, limit: { type: "number" }
      }},
      handler: async (a) => {
        let q = client.from("payments")
          .select("*, invoices(invoice_number, clients(client_name))")
          .in("business_unit_id", bu).order("payment_date", { ascending: false }).limit(a.limit || 50)
        if (a.from_date) q = q.gte("payment_date", a.from_date)
        if (a.to_date)   q = q.lte("payment_date", a.to_date)
        const { data, error } = await q
        if (error) throw new Error(error.message)
        return data
      },
    })
  }

  // ── Forecasts ─────────────────────────────────────────────────────────────
  if (can(ctx, "finance", "forecasts", "view")) {
    tools.push({
      name: "list_forecasts",
      description: "List revenue forecasts. Filter by status or date range.",
      inputSchema: { type: "object", properties: {
        status: { type: "string" }, from_month: { type: "string" }, to_month: { type: "string" }, limit: { type: "number" }
      }},
      handler: async (a) => {
        let q = client.from("forecasts")
          .select("*, clients(client_name), projects(project_name)")
          .in("business_unit_id", bu).order("forecast_month", { ascending: false }).limit(a.limit || 50)
        if (a.status)     q = q.eq("status", a.status)
        if (a.from_month) q = q.gte("forecast_month", a.from_month)
        if (a.to_month)   q = q.lte("forecast_month", a.to_month)
        const { data, error } = await q
        if (error) throw new Error(error.message)
        return data
      },
    })
  }

  // ── Expenses ──────────────────────────────────────────────────────────────
  if (can(ctx, "finance", "booked_expenses", "view")) {
    tools.push({
      name: "list_booked_expenses",
      description: "List booked expenses. Filter by category or date range.",
      inputSchema: { type: "object", properties: {
        category: { type: "string" }, from_date: { type: "string" }, to_date: { type: "string" }, limit: { type: "number" }
      }},
      handler: async (a) => {
        let q = client.from("booked_expenses").select("*").in("business_unit_id", bu)
          .order("booked_on_date", { ascending: false }).limit(a.limit || 50)
        if (a.category)  q = q.eq("category", a.category)
        if (a.from_date) q = q.gte("booked_on_date", a.from_date)
        if (a.to_date)   q = q.lte("booked_on_date", a.to_date)
        const { data, error } = await q
        if (error) throw new Error(error.message)
        return data
      },
    })
  }

  if (can(ctx, "finance", "finance_accounts", "view")) {
    tools.push({
      name: "list_finance_accounts",
      description: "List bank/finance accounts and current balances.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const { data, error } = await client.from("finance_accounts")
          .select("id,account_name,account_type,bank_name,current_balance,currency,status")
          .in("business_unit_id", bu).order("account_name")
        if (error) throw new Error(error.message)
        return data
      },
    })
  }

  // ── CRM ───────────────────────────────────────────────────────────────────
  if (can(ctx, "crm", "leads", "view")) {
    tools.push({
      name: "list_leads",
      description: "List CRM leads. Filter by stage, priority, or search by company.",
      inputSchema: { type: "object", properties: {
        stage: { type: "string" }, priority: { type: "string" },
        search: { type: "string" }, limit: { type: "number" }
      }},
      handler: async (a) => {
        let q = client.from("leads")
          .select("id,company_name,contact_name,stage,priority,deal_value,deal_currency,expected_close_date")
          .in("business_unit_id", bu).order("created_at", { ascending: false }).limit(a.limit || 50)
        if (a.stage)    q = q.eq("stage", a.stage)
        if (a.priority) q = q.eq("priority", a.priority)
        if (a.search)   q = q.ilike("company_name", `%${a.search}%`)
        const { data, error } = await q
        if (error) throw new Error(error.message)
        return data
      },
    })

    tools.push({
      name: "get_pipeline_summary",
      description: "Summary of leads by stage with total deal values.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const { data, error } = await client.from("leads")
          .select("stage,deal_value").in("business_unit_id", bu)
        if (error) throw new Error(error.message)
        return (data || []).reduce((acc, l) => {
          if (!acc[l.stage]) acc[l.stage] = { count: 0, total_value: 0 }
          acc[l.stage].count++
          acc[l.stage].total_value += l.deal_value || 0
          return acc
        }, {})
      },
    })
  }

  // ── Projects ──────────────────────────────────────────────────────────────
  if (can(ctx, "pm", "pm_projects", "view")) {
    tools.push({
      name: "list_projects",
      description: "List projects. Filter by status or client.",
      inputSchema: { type: "object", properties: {
        status: { type: "string" }, client_id: { type: "string" }, limit: { type: "number" }
      }},
      handler: async (a) => {
        let q = client.from("projects")
          .select("id,project_name,status,engagement_type,clients(client_name)")
          .in("business_unit_id", bu).limit(a.limit || 50)
        if (a.status)    q = q.eq("status", a.status)
        if (a.client_id) q = q.eq("client_id", a.client_id)
        const { data, error } = await q
        if (error) throw new Error(error.message)
        return data
      },
    })
  }

  // ── HR ────────────────────────────────────────────────────────────────────
  if (can(ctx, "hr", "hr_team_members", "view")) {
    tools.push({
      name: "list_team_members",
      description: "List team members. Filter by team or search by name.",
      inputSchema: { type: "object", properties: {
        team_id: { type: "string" }, search: { type: "string" }, limit: { type: "number" }
      }},
      handler: async (a) => {
        let q = client.from("team_members")
          .select("id,name,email,employee_id,date_of_joining,designations(title),teams(name)")
          .in("business_unit_id", bu).eq("is_archived", false).limit(a.limit || 100)
        if (a.team_id) q = q.eq("team_id", a.team_id)
        if (a.search)  q = q.or(`name.ilike.%${a.search}%,email.ilike.%${a.search}%`)
        const { data, error } = await q
        if (error) throw new Error(error.message)
        return data
      },
    })
  }

  // ── Timesheets ────────────────────────────────────────────────────────────
  if (can(ctx, "pm", "pm_timesheets", "view")) {
    tools.push({
      name: "list_timesheets",
      description: "List timesheets. Filter by status or date range.",
      inputSchema: { type: "object", properties: {
        status: { type: "string" }, from_date: { type: "string" }, to_date: { type: "string" }, limit: { type: "number" }
      }},
      handler: async (a) => {
        let q = client.from("timesheets")
          .select("id,week_start_date,status,submitted_at,team_members(name,email)")
          .in("business_unit_id", bu).order("week_start_date", { ascending: false }).limit(a.limit || 50)
        if (a.status)    q = q.eq("status", a.status)
        if (a.from_date) q = q.gte("week_start_date", a.from_date)
        if (a.to_date)   q = q.lte("week_start_date", a.to_date)
        const { data, error } = await q
        if (error) throw new Error(error.message)
        return data
      },
    })
  }

  return tools
}

// ── Auth tools (shown when not authenticated) ─────────────────────────────────
function buildAuthTools(onAuthenticated) {
  return [
    {
      name: "send_otp",
      description: "Send a one-time password to your Elron email address. Call this first to authenticate.",
      inputSchema: {
        type: "object",
        required: ["email"],
        properties: {
          email: { type: "string", description: "Your Elron email address" },
        },
      },
      handler: async (a) => {
        const client = anonClient()
        const { error } = await client.auth.signInWithOtp({
          email: a.email,
          options: { shouldCreateUser: false },
        })
        if (error) throw new Error(error.message)
        return {
          message: `OTP sent to ${a.email}. Check your email and call verify_otp with the 6-digit code.`,
        }
      },
    },
    {
      name: "verify_otp",
      description: "Verify the OTP code from your email to complete authentication and unlock all tools.",
      inputSchema: {
        type: "object",
        required: ["email", "otp"],
        properties: {
          email: { type: "string", description: "Your Elron email address" },
          otp:   { type: "string", description: "6-digit code from your email" },
        },
      },
      handler: async (a) => {
        const client = anonClient()
        const { data, error } = await client.auth.verifyOtp({
          email: a.email,
          token: a.otp,
          type:  "email",
        })
        if (error || !data.session) throw new Error("Invalid OTP: " + (error?.message ?? "no session"))

        saveSession({
          access_token:  data.session.access_token,
          refresh_token: data.session.refresh_token,
          email:         data.user.email,
          user_id:       data.user.id,
          saved_at:      new Date().toISOString(),
        })

        const uc  = userClient(data.session.access_token)
        const ctx = await loadUserContext(uc)

        // Hand off to main server state
        await onAuthenticated(uc, ctx)

        return {
          message:    `Authenticated as ${data.user.email}. All your permitted tools are now available.`,
          modules:    ctx.permissions.filter(p => p.canView).map(p => `${p.parentModule}:${p.subModule}`),
          business_units: ctx.businessUnitIds.length,
        }
      },
    },
  ]
}

// ── MCP stdio server ──────────────────────────────────────────────────────────
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n") }

async function main() {
  let tools = []

  // Called after successful auth — rebuilds tool list and notifies Claude
  async function onAuthenticated(uc, ctx) {
    tools = buildDataTools(uc, ctx)
    // Tell Claude Desktop the tool list has changed
    send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })
    process.stderr.write(`[elron-mcp] Authenticated: ${ctx.email} | ${tools.length} tools unlocked\n`)
  }

  // Try to restore a saved session
  const saved = loadSession()
  if (saved) {
    try {
      const ac = anonClient()
      const { data, error } = await ac.auth.refreshSession({ refresh_token: saved.refresh_token })
      if (!error && data.session) {
        saveSession({ ...saved, access_token: data.session.access_token, refresh_token: data.session.refresh_token, saved_at: new Date().toISOString() })
        const uc  = userClient(data.session.access_token)
        const ctx = await loadUserContext(uc)
        tools = buildDataTools(uc, ctx)
        process.stderr.write(`[elron-mcp] Session restored: ${ctx.email} | ${tools.length} tools\n`)
      } else {
        tools = buildAuthTools(onAuthenticated)
        process.stderr.write("[elron-mcp] Session expired — waiting for authentication in chat\n")
      }
    } catch {
      tools = buildAuthTools(onAuthenticated)
    }
  } else {
    tools = buildAuthTools(onAuthenticated)
    process.stderr.write("[elron-mcp] No session — waiting for authentication in chat\n")
  }

  const rl = createInterface({ input: process.stdin })

  rl.on("line", async (line) => {
    let msg
    try { msg = JSON.parse(line) } catch { return }
    const { id, method, params } = msg

    switch (method) {
      case "initialize":
        send({
          jsonrpc: "2.0", id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: "elron-mcp", version: "1.0.0" },
          },
        })
        break

      case "notifications/initialized":
      case "initialized":
      case "ping":
        if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} })
        break

      case "tools/list":
        send({
          jsonrpc: "2.0", id,
          result: {
            tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
          },
        })
        break

      case "tools/call": {
        const name = params?.name
        const args = params?.arguments ?? {}
        const tool = tools.find(t => t.name === name)
        if (!tool) {
          send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Tool not found: ${name}` } })
          break
        }
        try {
          const result = await tool.handler(args)
          send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] } })
        } catch (err) {
          send({ jsonrpc: "2.0", id, error: { code: -32000, message: err.message } })
        }
        break
      }

      default:
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } })
    }
  })
}

main().catch(err => { process.stderr.write(`[elron-mcp] Fatal: ${err.message}\n`); process.exit(1) })
