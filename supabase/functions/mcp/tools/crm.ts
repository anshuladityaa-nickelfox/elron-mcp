import { SupabaseClient } from "npm:@supabase/supabase-js@2"
import { MCPTool, UserContext } from "../types.ts"
import { hasPermission } from "../permissions.ts"

export function buildCrmTools(client: SupabaseClient, ctx: UserContext): MCPTool[] {
  const tools: MCPTool[] = []

  // ── LEADS ─────────────────────────────────────────────────────────────────
  if (hasPermission(ctx, "crm", "leads", "view")) {
    tools.push({
      name: "list_leads",
      description: "List CRM leads. Filter by stage, priority, assigned user, or search by company.",
      inputSchema: {
        type: "object",
        properties: {
          stage: { type: "string", description: "Pipeline stage (e.g. new, qualified, proposal)" },
          priority: { type: "string", enum: ["none", "low", "medium", "high"] },
          assigned_to: { type: "string", description: "Filter by assigned team member ID" },
          search: { type: "string", description: "Search by company name" },
          pipeline_id: { type: "string" },
          limit: { type: "number" },
        },
      },
      handler: async (args) => {
        let query = client
          .from("leads")
          .select("id, company_name, contact_name, contact_email, stage, priority, deal_value, deal_currency, expected_close_date, assigned_to, created_at")
          .in("business_unit_id", ctx.businessUnitIds)
          .order("created_at", { ascending: false })
          .limit((args.limit as number) || 50)

        if (args.stage) query = query.eq("stage", args.stage)
        if (args.priority) query = query.eq("priority", args.priority)
        if (args.assigned_to) query = query.eq("assigned_to", args.assigned_to)
        if (args.pipeline_id) query = query.eq("pipeline_id", args.pipeline_id)
        if (args.search) query = query.ilike("company_name", `%${args.search}%`)

        const { data, error } = await query
        if (error) throw new Error(error.message)
        return data
      },
    })

    tools.push({
      name: "get_lead",
      description: "Get full details of a lead including activities and tasks.",
      inputSchema: {
        type: "object",
        required: ["lead_id"],
        properties: {
          lead_id: { type: "string", description: "Lead UUID" },
        },
      },
      handler: async (args) => {
        const { data, error } = await client
          .from("leads")
          .select(`*, crm_activities(*), lead_tasks(*), lead_custom_field_values(*)`)
          .eq("id", args.lead_id)
          .in("business_unit_id", ctx.businessUnitIds)
          .single()
        if (error) throw new Error(error.message)
        return data
      },
    })

    tools.push({
      name: "get_pipeline_summary",
      description: "Get a summary of leads grouped by stage with total deal values.",
      inputSchema: {
        type: "object",
        properties: {
          pipeline_id: { type: "string" },
          business_unit_id: { type: "string" },
        },
      },
      handler: async (args) => {
        let query = client
          .from("leads")
          .select("stage, deal_value, deal_currency")
          .in("business_unit_id", ctx.businessUnitIds)

        if (args.pipeline_id) query = query.eq("pipeline_id", args.pipeline_id)
        if (args.business_unit_id) query = query.eq("business_unit_id", args.business_unit_id)

        const { data, error } = await query
        if (error) throw new Error(error.message)

        // Aggregate by stage
        const summary = (data || []).reduce((acc: Record<string, { count: number; total_value: number }>, lead: any) => {
          if (!acc[lead.stage]) acc[lead.stage] = { count: 0, total_value: 0 }
          acc[lead.stage].count++
          acc[lead.stage].total_value += lead.deal_value || 0
          return acc
        }, {})

        return summary
      },
    })
  }

  if (hasPermission(ctx, "crm", "leads", "create")) {
    tools.push({
      name: "create_lead",
      description: "Create a new CRM lead.",
      inputSchema: {
        type: "object",
        required: ["business_unit_id", "company_name"],
        properties: {
          business_unit_id: { type: "string" },
          company_name: { type: "string" },
          contact_name: { type: "string" },
          contact_email: { type: "string" },
          contact_phone: { type: "string" },
          source: { type: "string", description: "Lead source e.g. Website, Referral" },
          stage: { type: "string", description: "Initial pipeline stage" },
          priority: { type: "string", enum: ["none", "low", "medium", "high"] },
          deal_value: { type: "number" },
          deal_currency: { type: "string" },
          expected_close_date: { type: "string", description: "YYYY-MM-DD" },
          notes: { type: "string" },
          pipeline_id: { type: "string" },
        },
      },
      handler: async (args) => {
        if (!ctx.businessUnitIds.includes(args.business_unit_id as string)) {
          throw new Error("You do not have access to this business unit")
        }
        const { data, error } = await client
          .from("leads")
          .insert({ ...args, created_by: ctx.userId })
          .select()
          .single()
        if (error) throw new Error(error.message)
        return data
      },
    })
  }

  if (hasPermission(ctx, "crm", "leads", "update")) {
    tools.push({
      name: "update_lead",
      description: "Update a lead's stage, priority, value, or other details.",
      inputSchema: {
        type: "object",
        required: ["lead_id"],
        properties: {
          lead_id: { type: "string" },
          stage: { type: "string" },
          priority: { type: "string", enum: ["none", "low", "medium", "high"] },
          deal_value: { type: "number" },
          expected_close_date: { type: "string", description: "YYYY-MM-DD" },
          notes: { type: "string" },
          assigned_to: { type: "string" },
          lost_reason: { type: "string" },
        },
      },
      handler: async (args) => {
        const { lead_id, ...updates } = args
        const { data, error } = await client
          .from("leads")
          .update({ ...updates, updated_at: new Date().toISOString() })
          .eq("id", lead_id)
          .in("business_unit_id", ctx.businessUnitIds)
          .select()
          .single()
        if (error) throw new Error(error.message)
        return data
      },
    })
  }

  // ── CRM ACTIVITIES ────────────────────────────────────────────────────────
  if (hasPermission(ctx, "crm", "crm_activities", "view")) {
    tools.push({
      name: "list_crm_activities",
      description: "List CRM activities (calls, emails, meetings) for leads or clients.",
      inputSchema: {
        type: "object",
        properties: {
          lead_id: { type: "string" },
          client_id: { type: "string" },
          activity_type: { type: "string" },
          is_completed: { type: "boolean" },
          limit: { type: "number" },
        },
      },
      handler: async (args) => {
        let query = client
          .from("crm_activities")
          .select("*")
          .in("business_unit_id", ctx.businessUnitIds)
          .order("activity_date", { ascending: false })
          .limit((args.limit as number) || 50)

        if (args.lead_id) query = query.eq("lead_id", args.lead_id)
        if (args.client_id) query = query.eq("client_id", args.client_id)
        if (args.activity_type) query = query.eq("activity_type", args.activity_type)
        if (args.is_completed !== undefined) query = query.eq("is_completed", args.is_completed)

        const { data, error } = await query
        if (error) throw new Error(error.message)
        return data
      },
    })
  }

  if (hasPermission(ctx, "crm", "crm_activities", "create")) {
    tools.push({
      name: "create_crm_activity",
      description: "Log a new CRM activity (call, email, meeting, etc.).",
      inputSchema: {
        type: "object",
        required: ["business_unit_id", "title", "activity_type"],
        properties: {
          business_unit_id: { type: "string" },
          lead_id: { type: "string" },
          client_id: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          activity_type: { type: "string", description: "e.g. call, email, meeting, note" },
          activity_date: { type: "string", description: "ISO datetime" },
          due_date: { type: "string", description: "ISO datetime" },
        },
      },
      handler: async (args) => {
        if (!ctx.businessUnitIds.includes(args.business_unit_id as string)) {
          throw new Error("You do not have access to this business unit")
        }
        const { data, error } = await client
          .from("crm_activities")
          .insert({ ...args, created_by: ctx.userId })
          .select()
          .single()
        if (error) throw new Error(error.message)
        return data
      },
    })
  }

  // ── LEAD TASKS ────────────────────────────────────────────────────────────
  if (hasPermission(ctx, "crm", "lead_tasks", "view")) {
    tools.push({
      name: "list_lead_tasks",
      description: "List tasks associated with leads.",
      inputSchema: {
        type: "object",
        properties: {
          lead_id: { type: "string" },
          is_completed: { type: "boolean" },
          assigned_to: { type: "string" },
          limit: { type: "number" },
        },
      },
      handler: async (args) => {
        let query = client
          .from("lead_tasks")
          .select("*")
          .in("business_unit_id", ctx.businessUnitIds)
          .order("created_at", { ascending: false })
          .limit((args.limit as number) || 50)

        if (args.lead_id) query = query.eq("lead_id", args.lead_id)
        if (args.is_completed !== undefined) query = query.eq("is_completed", args.is_completed)
        if (args.assigned_to) query = query.eq("assigned_to", args.assigned_to)

        const { data, error } = await query
        if (error) throw new Error(error.message)
        return data
      },
    })
  }

  return tools
}
