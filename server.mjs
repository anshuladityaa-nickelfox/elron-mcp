#!/usr/bin/env node
/**
 * Elron MCP Server
 * All tools always visible. Auth checked at call time.
 * All writes use user JWT — RLS enforced by Supabase.
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

// ── Shared auth state ─────────────────────────────────────────────────────────
const state = { client: null, ctx: null }

function requireAuth() {
  if (!state.client || !state.ctx)
    throw new Error("Not authenticated. Use send_otp then verify_otp to log in.")
  return { client: state.client, ctx: state.ctx }
}

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
    userId:          user.id,
    email:           user.email,
    businessUnitIds: buIds,
    permissions:     [...permMap.values()].filter(p => p.moduleEnabled),
  }
}

function can(ctx, parent, sub, action) {
  const p = ctx.permissions.find(p => p.parentModule === parent && p.subModule === sub)
  if (!p || !p.moduleEnabled) return false
  return { view: p.canView, create: p.canCreate, update: p.canUpdate, delete: p.canDelete }[action] ?? false
}

// Strip undefined values from an object (for partial updates)
function defined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined))
}

// ── All tools ─────────────────────────────────────────────────────────────────
const tools = [

  // ── Auth ─────────────────────────────────────────────────────────────────────
  {
    name: "send_otp",
    description: "Send a one-time password to your Elron email address. Call this first to authenticate.",
    inputSchema: { type: "object", required: ["email"], properties: {
      email: { type: "string", description: "Your Elron email address" },
    }},
    handler: async (a) => {
      const client = anonClient()
      const { error } = await client.auth.signInWithOtp({ email: a.email, options: { shouldCreateUser: false } })
      if (error) throw new Error(error.message)
      return { message: `OTP sent to ${a.email}. Check your email then call verify_otp with the 6-digit code.` }
    },
  },

  {
    name: "verify_otp",
    description: "Verify the OTP code from your email to authenticate.",
    inputSchema: { type: "object", required: ["email", "otp"], properties: {
      email: { type: "string" },
      otp:   { type: "string", description: "6-digit code from your email" },
    }},
    handler: async (a) => {
      const client = anonClient()
      const { data, error } = await client.auth.verifyOtp({ email: a.email, token: a.otp, type: "email" })
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
      state.client = uc
      state.ctx    = ctx
      process.stderr.write(`[elron-mcp] Authenticated: ${ctx.email}\n`)
      return {
        message:            `Authenticated as ${ctx.email}. You can now use all data tools.`,
        accessible_modules: ctx.permissions.filter(p => p.canView).map(p => `${p.parentModule}:${p.subModule}`),
        business_units:     ctx.businessUnitIds.length,
      }
    },
  },

  // ── My Access ────────────────────────────────────────────────────────────────
  {
    name: "get_my_access",
    description: "Show your business units and what modules you have access to.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const { ctx } = requireAuth()
      return {
        user: ctx.email,
        business_unit_ids: ctx.businessUnitIds,
        permissions: ctx.permissions.map(p => ({
          module:     `${p.parentModule}:${p.subModule}`,
          can_view:   p.canView, can_create: p.canCreate,
          can_update: p.canUpdate, can_delete: p.canDelete,
        })),
      }
    },
  },

  // ── Clients ───────────────────────────────────────────────────────────────────
  {
    name: "list_clients",
    description: "List clients. Filter by status or search by name.",
    inputSchema: { type: "object", properties: {
      status: { type: "string" }, search: { type: "string" }, limit: { type: "number" },
    }},
    handler: async (a) => {
      const { client, ctx } = requireAuth()
      if (!can(ctx, "clients", "clients", "view")) throw new Error("No permission to view clients.")
      let q = client.from("clients")
        .select("id,client_name,legal_name,country,status,default_billing_currency")
        .in("business_unit_id", ctx.businessUnitIds).limit(a.limit || 50)
      if (a.status) q = q.eq("status", a.status)
      if (a.search) q = q.ilike("client_name", `%${a.search}%`)
      const { data, error } = await q
      if (error) throw new Error(error.message)
      return data
    },
  },

  {
    name: "get_client",
    description: "Get full client details including contacts.",
    inputSchema: { type: "object", required: ["client_id"], properties: {
      client_id: { type: "string" },
    }},
    handler: async (a) => {
      const { client, ctx } = requireAuth()
      if (!can(ctx, "clients", "clients", "view")) throw new Error("No permission to view clients.")
      const { data, error } = await client.from("clients")
        .select("*, client_contacts(*), client_tax_config(*)")
        .eq("id", a.client_id).in("business_unit_id", ctx.businessUnitIds).single()
      if (error) throw new Error(error.message)
      return data
    },
  },

  {
    name: "create_client",
    description: "Create a new client.",
    inputSchema: { type: "object", required: ["business_unit_id", "client_name"], properties: {
      business_unit_id:          { type: "string" },
      client_name:               { type: "string" },
      legal_name:                { type: "string" },
      country:                   { type: "string" },
      status:                    { type: "string" },
      default_billing_currency:  { type: "string" },
    }},
    handler: async (a) => {
      const { client, ctx } = requireAuth()
      if (!can(ctx, "clients", "clients", "create")) throw new Error("No permission to create clients.")
      if (!ctx.businessUnitIds.includes(a.business_unit_id)) throw new Error("No access to this business unit.")
      const { data, error } = await client.from("clients").insert(a).select().single()
      if (error) throw new Error(error.message)
      return data
    },
  },

  {
    name: "update_client",
    description: "Update an existing client.",
    inputSchema: { type: "object", required: ["client_id"], properties: {
      client_id:                { type: "string" },
      client_name:              { type: "string" },
      legal_name:               { type: "string" },
      country:                  { type: "string" },
      status:                   { type: "string" },
      default_billing_currency: { type: "string" },
    }},
    handler: async (a) => {
      const { client, ctx } = requireAuth()
      if (!can(ctx, "clients", "clients", "update")) throw new Error("No permission to update clients.")
      const { client_id, ...fields } = a
      const updates = defined(fields)
      if (!Object.keys(updates).length) throw new Error("No fields provided to update.")
      const { data, error } = await client.from("clients")
        .update(updates).eq("id", client_id).in("business_unit_id", ctx.businessUnitIds).select().single()
      if (error) throw new Error(error.message)
      return data
    },
  },

  {
    name: "delete_client",
    description: "Delete a client by ID.",
    inputSchema: { type: "object", required: ["client_id"], properties: {
      client_id: { type: "string" },
    }},
    handler: async (a) => {
      const { client, ctx } = requireAuth()
      if (!can(ctx, "clients", "clients", "delete")) throw new Error("No permission to delete clients.")
      const { error } = await client.from("clients")
        .delete().eq("id", a.client_id).in("business_unit_id", ctx.businessUnitIds)
      if (error) throw new Error(error.message)
      return { message: `Client ${a.client_id} deleted.` }
    },
  },

  // ── Invoices ──────────────────────────────────────────────────────────────────
  {
    name: "list_invoices",
    description: "List invoices. Filter by status, client, or date range.",
    inputSchema: { type: "object", properties: {
      status:    { type: "string", enum: ["unpaid","paid","partial","overdue","void"] },
      client_id: { type: "string" },
      from_date: { type: "string", description: "YYYY-MM-DD" },
      to_date:   { type: "string", description: "YYYY-MM-DD" },
      limit:     { type: "number" },
    }},
    handler: async (a) => {
      const { client, ctx } = requireAuth()
      if (!can(ctx, "finance", "invoices", "view")) throw new Error("No permission to view invoices.")
      let q = client.from("invoices")
        .select("id,invoice_number,invoice_date,due_date,currency,invoice_amount_fc,status,clients(client_name)")
        .in("business_unit_id", ctx.businessUnitIds).order("invoice_date", { ascending: false }).limit(a.limit || 50)
      if (a.status)    q = q.eq("status", a.status)
      if (a.client_id) q = q.eq("client_id", a.client_id)
      if (a.from_date) q = q.gte("invoice_date", a.from_date)
      if (a.to_date)   q = q.lte("invoice_date", a.to_date)
      const { data, error } = await q
      if (error) throw new Error(error.message)
      return data
    },
  },

  {
    name: "get_outstanding_invoices",
    description: "Get all unpaid and overdue invoices.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const { client, ctx } = requireAuth()
      if (!can(ctx, "finance", "invoices", "view")) throw new Error("No permission to view invoices.")
      const { data, error } = await client.from("invoices")
        .select("id,invoice_number,due_date,currency,invoice_amount_fc,status,clients(client_name)")
        .in("business_unit_id", ctx.businessUnitIds).in("status", ["unpaid","partial","overdue"]).order("due_date")
      if (error) throw new Error(error.message)
      return data
    },
  },

  {
    name: "create_invoice",
    description: "Create a new invoice.",
    inputSchema: { type: "object", required: ["business_unit_id","client_id","project_id","invoice_date","due_date","currency","invoice_amount_fc"], properties: {
      business_unit_id:  { type: "string" },
      client_id:         { type: "string" },
      project_id:        { type: "string" },
      invoice_date:      { type: "string", description: "YYYY-MM-DD" },
      due_date:          { type: "string", description: "YYYY-MM-DD" },
      currency:          { type: "string" },
      invoice_amount_fc: { type: "number" },
      exchange_rate:     { type: "number" },
      remarks:           { type: "string" },
    }},
    handler: async (a) => {
      const { client, ctx } = requireAuth()
      if (!can(ctx, "finance", "invoices", "create")) throw new Error("No permission to create invoices.")
      if (!ctx.businessUnitIds.includes(a.business_unit_id)) throw new Error("No access to this business unit.")
      const { data, error } = await client.from("invoices").insert({ ...a, created_by: ctx.userId }).select().single()
      if (error) throw new Error(error.message)
      return data
    },
  },

  {
    name: "update_invoice",
    description: "Update an existing invoice.",
    inputSchema: { type: "object", required: ["invoice_id"], properties: {
      invoice_id:        { type: "string" },
      invoice_date:      { type: "string", description: "YYYY-MM-DD" },
      due_date:          { type: "string", description: "YYYY-MM-DD" },
      currency:          { type: "string" },
      invoice_amount_fc: { type: "number" },
      exchange_rate:     { type: "number" },
      status:            { type: "string", enum: ["unpaid","paid","partial","overdue","void"] },
      remarks:           { type: "string" },
    }},
    handler: async (a) => {
      const { client, ctx } = requireAuth()
      if (!can(ctx, "finance", "invoices", "update")) throw new Error("No permission to update invoices.")
      const { invoice_id, ...fields } = a
      const updates = defined(fields)
      if (!Object.keys(updates).length) throw new Error("No fields provided to update.")
      const { data, error } = await client.from("invoices")
        .update(updates).eq("id", invoice_id).in("business_unit_id", ctx.businessUnitIds).select().single()
      if (error) throw new Error(error.message)
      return data
    },
  },

  {
    name: "delete_invoice",
    description: "Delete an invoice by ID.",
    inputSchema: { type: "object", required: ["invoice_id"], properties: {
      invoice_id: { type: "string" },
    }},
    handler: async (a) => {
      const { client, ctx } = requireAuth()
      if (!can(ctx, "finance", "invoices", "delete")) throw new Error("No permission to delete invoices.")
      const { error } = await client.from("invoices")
        .delete().eq("id", a.invoice_id).in("business_unit_id", ctx.businessUnitIds)
      if (error) throw new Error(error.message)
      return { message: `Invoice ${a.invoice_id} deleted.` }
    },
  },

  // ── Payments ──────────────────────────────────────────────────────────────────
  {
    name: "list_payments",
    description: "List payment records. Filter by date range.",
    inputSchema: { type: "object", properties: {
      from_date: { type: "string" }, to_date: { type: "string" }, limit: { type: "number" },
    }},
    handler: async (a) => {
      const { client, ctx } = requireAuth()
      if (!can(ctx, "finance", "payments", "view")) throw new Error("No permission to view payments.")
      let q = client.from("payments")
        .select("*, invoices(invoice_number, clients(client_name))")
        .in("business_unit_id", ctx.businessUnitIds).order("payment_date", { ascending: false }).limit(a.limit || 50)
      if (a.from_date) q = q.gte("payment_date", a.from_date)
      if (a.to_date)   q = q.lte("payment_date", a.to_date)
      const { data, error } = await q
      if (error) throw new Error(error.message)
      return data
    },
  },

  {
    name: "create_payment",
    description: "Record a new payment against an invoice.",
    inputSchema: { type: "object", required: ["business_unit_id","invoice_id","payment_date","amount_fc","currency"], properties: {
      business_unit_id: { type: "string" },
      invoice_id:       { type: "string" },
      payment_date:     { type: "string", description: "YYYY-MM-DD" },
      amount_fc:        { type: "number" },
      currency:         { type: "string" },
      exchange_rate:    { type: "number" },
      remarks:          { type: "string" },
    }},
    handler: async (a) => {
      const { client, ctx } = requireAuth()
      if (!can(ctx, "finance", "payments", "create")) throw new Error("No permission to create payments.")
      if (!ctx.businessUnitIds.includes(a.business_unit_id)) throw new Error("No access to this business unit.")
      const { data, error } = await client.from("payments").insert(a).select().single()
      if (error) throw new Error(error.message)
      return data
    },
  },

  {
    name: "delete_payment",
    description: "Delete a payment record by ID.",
    inputSchema: { type: "object", required: ["payment_id"], properties: {
      payment_id: { type: "string" },
    }},
    handler: async (a) => {
      const { client, ctx } = requireAuth()
      if (!can(ctx, "finance", "payments", "delete")) throw new Error("No permission to delete payments.")
      const { error } = await client.from("payments")
        .delete().eq("id", a.payment_id).in("business_unit_id", ctx.businessUnitIds)
      if (error) throw new Error(error.message)
      return { message: `Payment ${a.payment_id} deleted.` }
    },
  },

  // ── Forecasts ─────────────────────────────────────────────────────────────────
  {
    name: "list_forecasts",
    description: "List revenue forecasts. Filter by status or date range.",
    inputSchema: { type: "object", properties: {
      status: { type: "string" }, from_month: { type: "string" }, to_month: { type: "string" }, limit: { type: "number" },
    }},
    handler: async (a) => {
      const { client, ctx } = requireAuth()
      if (!can(ctx, "finance", "forecasts", "view")) throw new Error("No permission to view forecasts.")
      let q = client.from("forecasts")
        .select("*, clients(client_name), projects(project_name)")
        .in("business_unit_id", ctx.businessUnitIds).order("forecast_month", { ascending: false }).limit(a.limit || 50)
      if (a.status)     q = q.eq("status", a.status)
      if (a.from_month) q = q.gte("forecast_month", a.from_month)
      if (a.to_month)   q = q.lte("forecast_month", a.to_month)
      const { data, error } = await q
      if (error) throw new Error(error.message)
      return data
    },
  },

  {
    name: "create_forecast",
    description: "Create a new revenue forecast.",
    inputSchema: { type: "object", required: ["business_unit_id","client_id","forecast_month","currency","forecast_amount"], properties: {
      business_unit_id: { type: "string" },
      client_id:        { type: "string" },
      project_id:       { type: "string" },
      forecast_month:   { type: "string", description: "YYYY-MM-DD" },
      currency:         { type: "string" },
      forecast_amount:  { type: "number" },
      status:           { type: "string" },
      remarks:          { type: "string" },
    }},
    handler: async (a) => {
      const { client, ctx } = requireAuth()
      if (!can(ctx, "finance", "forecasts", "create")) throw new Error("No permission to create forecasts.")
      if (!ctx.businessUnitIds.includes(a.business_unit_id)) throw new Error("No access to this business unit.")
      const { data, error } = await client.from("forecasts").insert(a).select().single()
      if (error) throw new Error(error.message)
      return data
    },
  },

  {
    name: "update_forecast",
    description: "Update an existing forecast.",
    inputSchema: { type: "object", required: ["forecast_id"], properties: {
      forecast_id:     { type: "string" },
      forecast_month:  { type: "string" },
      currency:        { type: "string" },
      forecast_amount: { type: "number" },
      status:          { type: "string" },
      remarks:         { type: "string" },
    }},
    handler: async (a) => {
      const { client, ctx } = requireAuth()
      if (!can(ctx, "finance", "forecasts", "update")) throw new Error("No permission to update forecasts.")
      const { forecast_id, ...fields } = a
      const updates = defined(fields)
      if (!Object.keys(updates).length) throw new Error("No fields provided to update.")
      const { data, error } = await client.from("forecasts")
        .update(updates).eq("id", forecast_id).in("business_unit_id", ctx.businessUnitIds).select().single()
      if (error) throw new Error(error.message)
      return data
    },
  },

  {
    name: "delete_forecast",
    description: "Delete a forecast by ID.",
    inputSchema: { type: "object", required: ["forecast_id"], properties: {
      forecast_id: { type: "string" },
    }},
    handler: async (a) => {
      const { client, ctx } = requireAuth()
      if (!can(ctx, "finance", "forecasts", "delete")) throw new Error("No permission to delete forecasts.")
      const { error } = await client.from("forecasts")
        .delete().eq("id", a.forecast_id).in("business_unit_id", ctx.businessUnitIds)
      if (error) throw new Error(error.message)
      return { message: `Forecast ${a.forecast_id} deleted.` }
    },
  },

  // ── Booked Expenses ───────────────────────────────────────────────────────────
  {
    name: "list_booked_expenses",
    description: "List booked expenses. Filter by category or date range.",
    inputSchema: { type: "object", properties: {
      category: { type: "string" }, from_date: { type: "string" }, to_date: { type: "string" }, limit: { type: "number" },
    }},
    handler: async (a) => {
      const { client, ctx } = requireAuth()
      if (!can(ctx, "finance", "booked_expenses", "view")) throw new Error("No permission to view expenses.")
      let q = client.from("booked_expenses").select("*")
        .in("business_unit_id", ctx.businessUnitIds).order("booked_on_date", { ascending: false }).limit(a.limit || 50)
      if (a.category)  q = q.eq("category", a.category)
      if (a.from_date) q = q.gte("booked_on_date", a.from_date)
      if (a.to_date)   q = q.lte("booked_on_date", a.to_date)
      const { data, error } = await q
      if (error) throw new Error(error.message)
      return data
    },
  },

  {
    name: "create_booked_expense",
    description: "Create a new booked expense.",
    inputSchema: { type: "object", required: ["business_unit_id","category","amount","booked_on_date"], properties: {
      business_unit_id: { type: "string" },
      category:         { type: "string" },
      amount:           { type: "number" },
      currency:         { type: "string" },
      booked_on_date:   { type: "string", description: "YYYY-MM-DD" },
      description:      { type: "string" },
    }},
    handler: async (a) => {
      const { client, ctx } = requireAuth()
      if (!can(ctx, "finance", "booked_expenses", "create")) throw new Error("No permission to create expenses.")
      if (!ctx.businessUnitIds.includes(a.business_unit_id)) throw new Error("No access to this business unit.")
      const { data, error } = await client.from("booked_expenses").insert(a).select().single()
      if (error) throw new Error(error.message)
      return data
    },
  },

  {
    name: "update_booked_expense",
    description: "Update an existing booked expense.",
    inputSchema: { type: "object", required: ["expense_id"], properties: {
      expense_id:     { type: "string" },
      category:       { type: "string" },
      amount:         { type: "number" },
      currency:       { type: "string" },
      booked_on_date: { type: "string" },
      description:    { type: "string" },
    }},
    handler: async (a) => {
      const { client, ctx } = requireAuth()
      if (!can(ctx, "finance", "booked_expenses", "update")) throw new Error("No permission to update expenses.")
      const { expense_id, ...fields } = a
      const updates = defined(fields)
      if (!Object.keys(updates).length) throw new Error("No fields provided to update.")
      const { data, error } = await client.from("booked_expenses")
        .update(updates).eq("id", expense_id).in("business_unit_id", ctx.businessUnitIds).select().single()
      if (error) throw new Error(error.message)
      return data
    },
  },

  {
    name: "delete_booked_expense",
    description: "Delete a booked expense by ID.",
    inputSchema: { type: "object", required: ["expense_id"], properties: {
      expense_id: { type: "string" },
    }},
    handler: async (a) => {
      const { client, ctx } = requireAuth()
      if (!can(ctx, "finance", "booked_expenses", "delete")) throw new Error("No permission to delete expenses.")
      const { error } = await client.from("booked_expenses")
        .delete().eq("id", a.expense_id).in("business_unit_id", ctx.businessUnitIds)
      if (error) throw new Error(error.message)
      return { message: `Expense ${a.expense_id} deleted.` }
    },
  },

  // ── Finance Accounts ──────────────────────────────────────────────────────────
  {
    name: "list_finance_accounts",
    description: "List bank/finance accounts and current balances.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const { client, ctx } = requireAuth()
      if (!can(ctx, "finance", "finance_accounts", "view")) throw new Error("No permission to view finance accounts.")
      const { data, error } = await client.from("finance_accounts")
        .select("id,account_name,account_type,bank_name,current_balance,currency,status")
        .in("business_unit_id", ctx.businessUnitIds).order("account_name")
      if (error) throw new Error(error.message)
      return data
    },
  },

  {
    name: "create_finance_account",
    description: "Create a new finance/bank account.",
    inputSchema: { type: "object", required: ["business_unit_id","account_name","account_type","currency"], properties: {
      business_unit_id: { type: "string" },
      account_name:     { type: "string" },
      account_type:     { type: "string" },
      bank_name:        { type: "string" },
      currency:         { type: "string" },
      current_balance:  { type: "number" },
    }},
    handler: async (a) => {
      const { client, ctx } = requireAuth()
      if (!can(ctx, "finance", "finance_accounts", "create")) throw new Error("No permission to create finance accounts.")
      if (!ctx.businessUnitIds.includes(a.business_unit_id)) throw new Error("No access to this business unit.")
      const { data, error } = await client.from("finance_accounts").insert(a).select().single()
      if (error) throw new Error(error.message)
      return data
    },
  },

  {
    name: "update_finance_account",
    description: "Update an existing finance/bank account.",
    inputSchema: { type: "object", required: ["account_id"], properties: {
      account_id:      { type: "string" },
      account_name:    { type: "string" },
      bank_name:       { type: "string" },
      current_balance: { type: "number" },
      status:          { type: "string" },
    }},
    handler: async (a) => {
      const { client, ctx } = requireAuth()
      if (!can(ctx, "finance", "finance_accounts", "update")) throw new Error("No permission to update finance accounts.")
      const { account_id, ...fields } = a
      const updates = defined(fields)
      if (!Object.keys(updates).length) throw new Error("No fields provided to update.")
      const { data, error } = await client.from("finance_accounts")
        .update(updates).eq("id", account_id).in("business_unit_id", ctx.businessUnitIds).select().single()
      if (error) throw new Error(error.message)
      return data
    },
  },

  // ── CRM Leads ─────────────────────────────────────────────────────────────────
  {
    name: "list_leads",
    description: "List CRM leads. Filter by stage, priority, or search by company name.",
    inputSchema: { type: "object", properties: {
      stage: { type: "string" }, priority: { type: "string" }, search: { type: "string" }, limit: { type: "number" },
    }},
    handler: async (a) => {
      const { client, ctx } = requireAuth()
      if (!can(ctx, "crm", "leads", "view")) throw new Error("No permission to view leads.")
      let q = client.from("leads")
        .select("id,company_name,contact_name,stage,priority,deal_value,deal_currency,expected_close_date")
        .in("business_unit_id", ctx.businessUnitIds).order("created_at", { ascending: false }).limit(a.limit || 50)
      if (a.stage)    q = q.eq("stage", a.stage)
      if (a.priority) q = q.eq("priority", a.priority)
      if (a.search)   q = q.ilike("company_name", `%${a.search}%`)
      const { data, error } = await q
      if (error) throw new Error(error.message)
      return data
    },
  },

  {
    name: "get_pipeline_summary",
    description: "Summary of CRM leads by stage with total deal values.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const { client, ctx } = requireAuth()
      if (!can(ctx, "crm", "leads", "view")) throw new Error("No permission to view leads.")
      const { data, error } = await client.from("leads")
        .select("stage,deal_value").in("business_unit_id", ctx.businessUnitIds)
      if (error) throw new Error(error.message)
      return (data || []).reduce((acc, l) => {
        if (!acc[l.stage]) acc[l.stage] = { count: 0, total_value: 0 }
        acc[l.stage].count++
        acc[l.stage].total_value += l.deal_value || 0
        return acc
      }, {})
    },
  },

  {
    name: "create_lead",
    description: "Create a new CRM lead.",
    inputSchema: { type: "object", required: ["business_unit_id","company_name"], properties: {
      business_unit_id:    { type: "string" },
      company_name:        { type: "string" },
      contact_name:        { type: "string" },
      stage:               { type: "string" },
      priority:            { type: "string" },
      deal_value:          { type: "number" },
      deal_currency:       { type: "string" },
      expected_close_date: { type: "string", description: "YYYY-MM-DD" },
    }},
    handler: async (a) => {
      const { client, ctx } = requireAuth()
      if (!can(ctx, "crm", "leads", "create")) throw new Error("No permission to create leads.")
      if (!ctx.businessUnitIds.includes(a.business_unit_id)) throw new Error("No access to this business unit.")
      const { data, error } = await client.from("leads").insert(a).select().single()
      if (error) throw new Error(error.message)
      return data
    },
  },

  {
    name: "update_lead",
    description: "Update an existing CRM lead.",
    inputSchema: { type: "object", required: ["lead_id"], properties: {
      lead_id:             { type: "string" },
      company_name:        { type: "string" },
      contact_name:        { type: "string" },
      stage:               { type: "string" },
      priority:            { type: "string" },
      deal_value:          { type: "number" },
      deal_currency:       { type: "string" },
      expected_close_date: { type: "string", description: "YYYY-MM-DD" },
    }},
    handler: async (a) => {
      const { client, ctx } = requireAuth()
      if (!can(ctx, "crm", "leads", "update")) throw new Error("No permission to update leads.")
      const { lead_id, ...fields } = a
      const updates = defined(fields)
      if (!Object.keys(updates).length) throw new Error("No fields provided to update.")
      const { data, error } = await client.from("leads")
        .update(updates).eq("id", lead_id).in("business_unit_id", ctx.businessUnitIds).select().single()
      if (error) throw new Error(error.message)
      return data
    },
  },

  {
    name: "delete_lead",
    description: "Delete a CRM lead by ID.",
    inputSchema: { type: "object", required: ["lead_id"], properties: {
      lead_id: { type: "string" },
    }},
    handler: async (a) => {
      const { client, ctx } = requireAuth()
      if (!can(ctx, "crm", "leads", "delete")) throw new Error("No permission to delete leads.")
      const { error } = await client.from("leads")
        .delete().eq("id", a.lead_id).in("business_unit_id", ctx.businessUnitIds)
      if (error) throw new Error(error.message)
      return { message: `Lead ${a.lead_id} deleted.` }
    },
  },

  // ── Projects ──────────────────────────────────────────────────────────────────
  {
    name: "list_projects",
    description: "List projects. Filter by status or client.",
    inputSchema: { type: "object", properties: {
      status: { type: "string" }, client_id: { type: "string" }, limit: { type: "number" },
    }},
    handler: async (a) => {
      const { client, ctx } = requireAuth()
      if (!can(ctx, "pm", "pm_projects", "view")) throw new Error("No permission to view projects.")
      let q = client.from("projects")
        .select("id,project_name,status,engagement_type,clients(client_name)")
        .in("business_unit_id", ctx.businessUnitIds).limit(a.limit || 50)
      if (a.status)    q = q.eq("status", a.status)
      if (a.client_id) q = q.eq("client_id", a.client_id)
      const { data, error } = await q
      if (error) throw new Error(error.message)
      return data
    },
  },

  {
    name: "create_project",
    description: "Create a new project.",
    inputSchema: { type: "object", required: ["business_unit_id","project_name","client_id"], properties: {
      business_unit_id: { type: "string" },
      project_name:     { type: "string" },
      client_id:        { type: "string" },
      status:           { type: "string" },
      engagement_type:  { type: "string" },
    }},
    handler: async (a) => {
      const { client, ctx } = requireAuth()
      if (!can(ctx, "pm", "pm_projects", "create")) throw new Error("No permission to create projects.")
      if (!ctx.businessUnitIds.includes(a.business_unit_id)) throw new Error("No access to this business unit.")
      const { data, error } = await client.from("projects").insert(a).select().single()
      if (error) throw new Error(error.message)
      return data
    },
  },

  {
    name: "update_project",
    description: "Update an existing project.",
    inputSchema: { type: "object", required: ["project_id"], properties: {
      project_id:      { type: "string" },
      project_name:    { type: "string" },
      status:          { type: "string" },
      engagement_type: { type: "string" },
    }},
    handler: async (a) => {
      const { client, ctx } = requireAuth()
      if (!can(ctx, "pm", "pm_projects", "update")) throw new Error("No permission to update projects.")
      const { project_id, ...fields } = a
      const updates = defined(fields)
      if (!Object.keys(updates).length) throw new Error("No fields provided to update.")
      const { data, error } = await client.from("projects")
        .update(updates).eq("id", project_id).in("business_unit_id", ctx.businessUnitIds).select().single()
      if (error) throw new Error(error.message)
      return data
    },
  },

  {
    name: "delete_project",
    description: "Delete a project by ID.",
    inputSchema: { type: "object", required: ["project_id"], properties: {
      project_id: { type: "string" },
    }},
    handler: async (a) => {
      const { client, ctx } = requireAuth()
      if (!can(ctx, "pm", "pm_projects", "delete")) throw new Error("No permission to delete projects.")
      const { error } = await client.from("projects")
        .delete().eq("id", a.project_id).in("business_unit_id", ctx.businessUnitIds)
      if (error) throw new Error(error.message)
      return { message: `Project ${a.project_id} deleted.` }
    },
  },

  // ── HR Team Members ───────────────────────────────────────────────────────────
  {
    name: "list_team_members",
    description: "List team members. Filter by team or search by name.",
    inputSchema: { type: "object", properties: {
      team_id: { type: "string" }, search: { type: "string" }, limit: { type: "number" },
    }},
    handler: async (a) => {
      const { client, ctx } = requireAuth()
      if (!can(ctx, "hr", "hr_team_members", "view")) throw new Error("No permission to view team members.")
      let q = client.from("team_members")
        .select("id,name,email,employee_id,date_of_joining,designations(title),teams(name)")
        .in("business_unit_id", ctx.businessUnitIds).eq("is_archived", false).limit(a.limit || 100)
      if (a.team_id) q = q.eq("team_id", a.team_id)
      if (a.search)  q = q.or(`name.ilike.%${a.search}%,email.ilike.%${a.search}%`)
      const { data, error } = await q
      if (error) throw new Error(error.message)
      return data
    },
  },

  {
    name: "create_team_member",
    description: "Add a new team member.",
    inputSchema: { type: "object", required: ["business_unit_id","name","email"], properties: {
      business_unit_id: { type: "string" },
      name:             { type: "string" },
      email:            { type: "string" },
      employee_id:      { type: "string" },
      team_id:          { type: "string" },
      designation_id:   { type: "string" },
      date_of_joining:  { type: "string", description: "YYYY-MM-DD" },
    }},
    handler: async (a) => {
      const { client, ctx } = requireAuth()
      if (!can(ctx, "hr", "hr_team_members", "create")) throw new Error("No permission to create team members.")
      if (!ctx.businessUnitIds.includes(a.business_unit_id)) throw new Error("No access to this business unit.")
      const { data, error } = await client.from("team_members").insert(a).select().single()
      if (error) throw new Error(error.message)
      return data
    },
  },

  {
    name: "update_team_member",
    description: "Update an existing team member.",
    inputSchema: { type: "object", required: ["member_id"], properties: {
      member_id:       { type: "string" },
      name:            { type: "string" },
      email:           { type: "string" },
      employee_id:     { type: "string" },
      team_id:         { type: "string" },
      designation_id:  { type: "string" },
      date_of_joining: { type: "string" },
      is_archived:     { type: "boolean" },
    }},
    handler: async (a) => {
      const { client, ctx } = requireAuth()
      if (!can(ctx, "hr", "hr_team_members", "update")) throw new Error("No permission to update team members.")
      const { member_id, ...fields } = a
      const updates = defined(fields)
      if (!Object.keys(updates).length) throw new Error("No fields provided to update.")
      const { data, error } = await client.from("team_members")
        .update(updates).eq("id", member_id).in("business_unit_id", ctx.businessUnitIds).select().single()
      if (error) throw new Error(error.message)
      return data
    },
  },

  {
    name: "delete_team_member",
    description: "Archive a team member by ID.",
    inputSchema: { type: "object", required: ["member_id"], properties: {
      member_id: { type: "string" },
    }},
    handler: async (a) => {
      const { client, ctx } = requireAuth()
      if (!can(ctx, "hr", "hr_team_members", "delete")) throw new Error("No permission to delete team members.")
      const { error } = await client.from("team_members")
        .update({ is_archived: true }).eq("id", a.member_id).in("business_unit_id", ctx.businessUnitIds)
      if (error) throw new Error(error.message)
      return { message: `Team member ${a.member_id} archived.` }
    },
  },

  // ── Timesheets ────────────────────────────────────────────────────────────────
  {
    name: "list_timesheets",
    description: "List timesheets. Filter by status or date range.",
    inputSchema: { type: "object", properties: {
      status: { type: "string" }, from_date: { type: "string" }, to_date: { type: "string" }, limit: { type: "number" },
    }},
    handler: async (a) => {
      const { client, ctx } = requireAuth()
      if (!can(ctx, "pm", "pm_timesheets", "view")) throw new Error("No permission to view timesheets.")
      let q = client.from("timesheets")
        .select("id,week_start_date,status,submitted_at,team_members(name,email)")
        .in("business_unit_id", ctx.businessUnitIds).order("week_start_date", { ascending: false }).limit(a.limit || 50)
      if (a.status)    q = q.eq("status", a.status)
      if (a.from_date) q = q.gte("week_start_date", a.from_date)
      if (a.to_date)   q = q.lte("week_start_date", a.to_date)
      const { data, error } = await q
      if (error) throw new Error(error.message)
      return data
    },
  },

  {
    name: "update_timesheet",
    description: "Update a timesheet status (e.g. approve or reject).",
    inputSchema: { type: "object", required: ["timesheet_id", "status"], properties: {
      timesheet_id: { type: "string" },
      status:       { type: "string", enum: ["draft","submitted","approved","rejected"] },
      remarks:      { type: "string" },
    }},
    handler: async (a) => {
      const { client, ctx } = requireAuth()
      if (!can(ctx, "pm", "pm_timesheets", "update")) throw new Error("No permission to update timesheets.")
      const { timesheet_id, ...fields } = a
      const updates = defined(fields)
      const { data, error } = await client.from("timesheets")
        .update(updates).eq("id", timesheet_id).in("business_unit_id", ctx.businessUnitIds).select().single()
      if (error) throw new Error(error.message)
      return data
    },
  },
]

// ── MCP stdio server ──────────────────────────────────────────────────────────
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n") }

async function main() {
  const saved = loadSession()
  if (saved) {
    try {
      const ac = anonClient()
      const { data, error } = await ac.auth.refreshSession({ refresh_token: saved.refresh_token })
      if (!error && data.session) {
        saveSession({ ...saved, access_token: data.session.access_token, refresh_token: data.session.refresh_token, saved_at: new Date().toISOString() })
        const uc  = userClient(data.session.access_token)
        const ctx = await loadUserContext(uc)
        state.client = uc
        state.ctx    = ctx
        process.stderr.write(`[elron-mcp] Session restored: ${ctx.email}\n`)
      } else {
        process.stderr.write("[elron-mcp] Session expired — authenticate via send_otp\n")
      }
    } catch (e) {
      process.stderr.write(`[elron-mcp] Session restore failed: ${e.message}\n`)
    }
  } else {
    process.stderr.write("[elron-mcp] No session — authenticate via send_otp\n")
  }

  const rl = createInterface({ input: process.stdin })

  rl.on("line", async (line) => {
    let msg
    try { msg = JSON.parse(line) } catch { return }
    const { id, method, params } = msg

    switch (method) {
      case "initialize":
        send({ jsonrpc: "2.0", id, result: {
          protocolVersion: "2024-11-05",
          capabilities:    { tools: {} },
          serverInfo:      { name: "elron-mcp", version: "1.0.0" },
        }})
        break

      case "notifications/initialized":
      case "initialized":
      case "ping":
        if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} })
        break

      case "tools/list":
        send({ jsonrpc: "2.0", id, result: {
          tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        }})
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
