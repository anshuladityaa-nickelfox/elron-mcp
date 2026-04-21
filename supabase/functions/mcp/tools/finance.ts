import { SupabaseClient } from "npm:@supabase/supabase-js@2"
import { MCPTool, UserContext } from "../types.ts"
import { hasPermission } from "../permissions.ts"

export function buildFinanceTools(client: SupabaseClient, ctx: UserContext): MCPTool[] {
  const tools: MCPTool[] = []

  // ── INVOICES ──────────────────────────────────────────────────────────────
  if (hasPermission(ctx, "finance", "invoices", "view")) {
    tools.push({
      name: "list_invoices",
      description: "List invoices. Filter by status, date range, or client.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["unpaid", "paid", "partial", "overdue", "void"], description: "Invoice status" },
          client_id: { type: "string", description: "Filter by client ID" },
          from_date: { type: "string", description: "Start date (YYYY-MM-DD)" },
          to_date: { type: "string", description: "End date (YYYY-MM-DD)" },
          business_unit_id: { type: "string", description: "Filter by business unit" },
          limit: { type: "number", description: "Max records (default 50)" },
        },
      },
      handler: async (args) => {
        let query = client
          .from("invoices")
          .select("id, invoice_number, invoice_date, due_date, currency, invoice_amount_fc, status, client_id, clients(client_name)")
          .in("business_unit_id", ctx.businessUnitIds)
          .order("invoice_date", { ascending: false })
          .limit((args.limit as number) || 50)

        if (args.status) query = query.eq("status", args.status)
        if (args.client_id) query = query.eq("client_id", args.client_id)
        if (args.from_date) query = query.gte("invoice_date", args.from_date)
        if (args.to_date) query = query.lte("invoice_date", args.to_date)
        if (args.business_unit_id) query = query.eq("business_unit_id", args.business_unit_id)

        const { data, error } = await query
        if (error) throw new Error(error.message)
        return data
      },
    })

    tools.push({
      name: "get_invoice",
      description: "Get full invoice details including line items, taxes, and payment history.",
      inputSchema: {
        type: "object",
        required: ["invoice_id"],
        properties: {
          invoice_id: { type: "string", description: "Invoice UUID" },
        },
      },
      handler: async (args) => {
        const { data, error } = await client
          .from("invoices")
          .select(`*, invoice_line_items(*), invoice_tax_applicable(*), invoice_tax_deductible(*), payments(*)`)
          .eq("id", args.invoice_id)
          .in("business_unit_id", ctx.businessUnitIds)
          .single()
        if (error) throw new Error(error.message)
        return data
      },
    })

    tools.push({
      name: "get_outstanding_invoices",
      description: "Get a summary of all unpaid and overdue invoices.",
      inputSchema: { type: "object", properties: { business_unit_id: { type: "string" } } },
      handler: async (args) => {
        let query = client
          .from("invoices")
          .select("id, invoice_number, due_date, currency, invoice_amount_fc, status, clients(client_name)")
          .in("business_unit_id", ctx.businessUnitIds)
          .in("status", ["unpaid", "partial", "overdue"])
          .order("due_date")

        if (args.business_unit_id) query = query.eq("business_unit_id", args.business_unit_id)
        const { data, error } = await query
        if (error) throw new Error(error.message)
        return data
      },
    })
  }

  if (hasPermission(ctx, "finance", "invoices", "create")) {
    tools.push({
      name: "create_invoice",
      description: "Create a new invoice.",
      inputSchema: {
        type: "object",
        required: ["business_unit_id", "client_id", "project_id", "invoice_date", "due_date", "currency", "invoice_amount_fc"],
        properties: {
          business_unit_id: { type: "string" },
          client_id: { type: "string" },
          project_id: { type: "string" },
          invoice_date: { type: "string", description: "YYYY-MM-DD" },
          due_date: { type: "string", description: "YYYY-MM-DD" },
          currency: { type: "string", description: "e.g. USD" },
          invoice_amount_fc: { type: "number" },
          exchange_rate: { type: "number", description: "Exchange rate to INR (default 1)" },
          remarks: { type: "string" },
        },
      },
      handler: async (args) => {
        if (!ctx.businessUnitIds.includes(args.business_unit_id as string)) {
          throw new Error("You do not have access to this business unit")
        }
        const { data, error } = await client
          .from("invoices")
          .insert({ ...args, created_by: ctx.userId })
          .select()
          .single()
        if (error) throw new Error(error.message)
        return data
      },
    })
  }

  if (hasPermission(ctx, "finance", "invoices", "update")) {
    tools.push({
      name: "update_invoice_status",
      description: "Update the status of an invoice.",
      inputSchema: {
        type: "object",
        required: ["invoice_id", "status"],
        properties: {
          invoice_id: { type: "string" },
          status: { type: "string", enum: ["unpaid", "paid", "partial", "overdue", "void"] },
          remarks: { type: "string" },
        },
      },
      handler: async (args) => {
        const { data, error } = await client
          .from("invoices")
          .update({ status: args.status, remarks: args.remarks, updated_at: new Date().toISOString() })
          .eq("id", args.invoice_id)
          .in("business_unit_id", ctx.businessUnitIds)
          .select()
          .single()
        if (error) throw new Error(error.message)
        return data
      },
    })
  }

  // ── PAYMENTS ──────────────────────────────────────────────────────────────
  if (hasPermission(ctx, "finance", "payments", "view")) {
    tools.push({
      name: "list_payments",
      description: "List payment records. Filter by invoice, date range, or business unit.",
      inputSchema: {
        type: "object",
        properties: {
          invoice_id: { type: "string" },
          from_date: { type: "string", description: "YYYY-MM-DD" },
          to_date: { type: "string", description: "YYYY-MM-DD" },
          limit: { type: "number" },
        },
      },
      handler: async (args) => {
        let query = client
          .from("payments")
          .select("*, invoices(invoice_number, clients(client_name))")
          .in("business_unit_id", ctx.businessUnitIds)
          .order("payment_date", { ascending: false })
          .limit((args.limit as number) || 50)

        if (args.invoice_id) query = query.eq("invoice_id", args.invoice_id)
        if (args.from_date) query = query.gte("payment_date", args.from_date)
        if (args.to_date) query = query.lte("payment_date", args.to_date)

        const { data, error } = await query
        if (error) throw new Error(error.message)
        return data
      },
    })
  }

  if (hasPermission(ctx, "finance", "payments", "create")) {
    tools.push({
      name: "record_payment",
      description: "Record a payment received against an invoice.",
      inputSchema: {
        type: "object",
        required: ["business_unit_id", "invoice_id", "payment_date", "amount_received_fc", "finance_account_id"],
        properties: {
          business_unit_id: { type: "string" },
          invoice_id: { type: "string" },
          payment_date: { type: "string", description: "YYYY-MM-DD" },
          amount_received_fc: { type: "number" },
          bank_conversion_rate: { type: "number", description: "Bank conversion rate (default 1)" },
          bank_reference: { type: "string" },
          finance_account_id: { type: "string" },
          notes: { type: "string" },
        },
      },
      handler: async (args) => {
        if (!ctx.businessUnitIds.includes(args.business_unit_id as string)) {
          throw new Error("You do not have access to this business unit")
        }
        const { data, error } = await client
          .from("payments")
          .insert({ ...args, created_by: ctx.userId })
          .select()
          .single()
        if (error) throw new Error(error.message)
        return data
      },
    })
  }

  // ── FORECASTS ─────────────────────────────────────────────────────────────
  if (hasPermission(ctx, "finance", "forecasts", "view")) {
    tools.push({
      name: "list_forecasts",
      description: "List revenue forecasts. Filter by month, status, or client.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["approved", "cancelled", "invoiced"] },
          client_id: { type: "string" },
          from_month: { type: "string", description: "Start month (YYYY-MM-DD)" },
          to_month: { type: "string", description: "End month (YYYY-MM-DD)" },
          limit: { type: "number" },
        },
      },
      handler: async (args) => {
        let query = client
          .from("forecasts")
          .select("*, clients(client_name), projects(project_name)")
          .in("business_unit_id", ctx.businessUnitIds)
          .order("forecast_month", { ascending: false })
          .limit((args.limit as number) || 50)

        if (args.status) query = query.eq("status", args.status)
        if (args.client_id) query = query.eq("client_id", args.client_id)
        if (args.from_month) query = query.gte("forecast_month", args.from_month)
        if (args.to_month) query = query.lte("forecast_month", args.to_month)

        const { data, error } = await query
        if (error) throw new Error(error.message)
        return data
      },
    })
  }

  // ── EXPENSES ──────────────────────────────────────────────────────────────
  if (hasPermission(ctx, "finance", "booked_expenses", "view")) {
    tools.push({
      name: "list_booked_expenses",
      description: "List booked (confirmed) expenses.",
      inputSchema: {
        type: "object",
        properties: {
          category: { type: "string" },
          from_date: { type: "string", description: "YYYY-MM-DD" },
          to_date: { type: "string", description: "YYYY-MM-DD" },
          limit: { type: "number" },
        },
      },
      handler: async (args) => {
        let query = client
          .from("booked_expenses")
          .select("*")
          .in("business_unit_id", ctx.businessUnitIds)
          .order("booked_on_date", { ascending: false })
          .limit((args.limit as number) || 50)

        if (args.category) query = query.eq("category", args.category)
        if (args.from_date) query = query.gte("booked_on_date", args.from_date)
        if (args.to_date) query = query.lte("booked_on_date", args.to_date)

        const { data, error } = await query
        if (error) throw new Error(error.message)
        return data
      },
    })
  }

  if (hasPermission(ctx, "finance", "actual_expenses", "view")) {
    tools.push({
      name: "list_actual_expenses",
      description: "List actual (paid) expenses.",
      inputSchema: {
        type: "object",
        properties: {
          from_date: { type: "string", description: "YYYY-MM-DD" },
          to_date: { type: "string", description: "YYYY-MM-DD" },
          finance_account_id: { type: "string" },
          limit: { type: "number" },
        },
      },
      handler: async (args) => {
        let query = client
          .from("actual_expenses")
          .select("*, finance_accounts(account_name)")
          .in("business_unit_id", ctx.businessUnitIds)
          .order("pay_date", { ascending: false })
          .limit((args.limit as number) || 50)

        if (args.from_date) query = query.gte("pay_date", args.from_date)
        if (args.to_date) query = query.lte("pay_date", args.to_date)
        if (args.finance_account_id) query = query.eq("finance_account_id", args.finance_account_id)

        const { data, error } = await query
        if (error) throw new Error(error.message)
        return data
      },
    })
  }

  // ── FINANCE ACCOUNTS ──────────────────────────────────────────────────────
  if (hasPermission(ctx, "finance", "finance_accounts", "view")) {
    tools.push({
      name: "list_finance_accounts",
      description: "List all bank/finance accounts and their current balances.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["active", "inactive"] },
          business_unit_id: { type: "string" },
        },
      },
      handler: async (args) => {
        let query = client
          .from("finance_accounts")
          .select("id, account_name, account_type, bank_name, current_balance, currency, status, is_default")
          .in("business_unit_id", ctx.businessUnitIds)
          .order("account_name")

        if (args.status) query = query.eq("status", args.status)
        if (args.business_unit_id) query = query.eq("business_unit_id", args.business_unit_id)

        const { data, error } = await query
        if (error) throw new Error(error.message)
        return data
      },
    })
  }

  // ── OTHER INCOME ──────────────────────────────────────────────────────────
  if (hasPermission(ctx, "finance", "other_income", "view")) {
    tools.push({
      name: "list_other_income",
      description: "List other income entries (non-invoice income).",
      inputSchema: {
        type: "object",
        properties: {
          from_date: { type: "string", description: "YYYY-MM-DD" },
          to_date: { type: "string", description: "YYYY-MM-DD" },
          category: { type: "string" },
          limit: { type: "number" },
        },
      },
      handler: async (args) => {
        let query = client
          .from("other_income")
          .select("*, finance_accounts(account_name)")
          .in("business_unit_id", ctx.businessUnitIds)
          .order("income_date", { ascending: false })
          .limit((args.limit as number) || 50)

        if (args.from_date) query = query.gte("income_date", args.from_date)
        if (args.to_date) query = query.lte("income_date", args.to_date)
        if (args.category) query = query.eq("category", args.category)

        const { data, error } = await query
        if (error) throw new Error(error.message)
        return data
      },
    })
  }

  // ── FIRC ──────────────────────────────────────────────────────────────────
  if (hasPermission(ctx, "finance", "firc", "view")) {
    tools.push({
      name: "list_firc",
      description: "List FIRC (Foreign Inward Remittance Certificates) records.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["pending", "received", "not_applicable"] },
          limit: { type: "number" },
        },
      },
      handler: async (args) => {
        let query = client
          .from("firc")
          .select("*, payments(bank_reference, invoices(invoice_number))")
          .in("business_unit_id", ctx.businessUnitIds)
          .order("created_at", { ascending: false })
          .limit((args.limit as number) || 50)

        if (args.status) query = query.eq("status", args.status)

        const { data, error } = await query
        if (error) throw new Error(error.message)
        return data
      },
    })
  }

  // ── EXPENSE FORECASTS ─────────────────────────────────────────────────────
  if (hasPermission(ctx, "finance", "expense_forecasts", "view")) {
    tools.push({
      name: "list_expense_forecasts",
      description: "List planned/forecasted expenses.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string" },
          from_date: { type: "string", description: "YYYY-MM-DD" },
          to_date: { type: "string", description: "YYYY-MM-DD" },
          limit: { type: "number" },
        },
      },
      handler: async (args) => {
        let query = client
          .from("expense_forecasts")
          .select("*")
          .in("business_unit_id", ctx.businessUnitIds)
          .order("forecast_date", { ascending: false })
          .limit((args.limit as number) || 50)

        if (args.status) query = query.eq("status", args.status)
        if (args.from_date) query = query.gte("forecast_date", args.from_date)
        if (args.to_date) query = query.lte("forecast_date", args.to_date)

        const { data, error } = await query
        if (error) throw new Error(error.message)
        return data
      },
    })
  }

  return tools
}
