import { SupabaseClient } from "npm:@supabase/supabase-js@2"
import { MCPTool, UserContext } from "../types.ts"
import { hasPermission } from "../permissions.ts"

export function buildPmTools(client: SupabaseClient, ctx: UserContext): MCPTool[] {
  const tools: MCPTool[] = []

  // ── PROJECTS ──────────────────────────────────────────────────────────────
  if (hasPermission(ctx, "pm", "pm_projects", "view")) {
    tools.push({
      name: "list_projects",
      description: "List all projects. Filter by status, client, or engagement type.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["active", "completed", "on_hold", "cancelled"] },
          client_id: { type: "string" },
          engagement_type: { type: "string", enum: ["retainer", "fixed", "time_and_material"] },
          limit: { type: "number" },
        },
      },
      handler: async (args) => {
        let query = client
          .from("projects")
          .select("id, project_name, status, engagement_type, created_at, clients(client_name)")
          .in("business_unit_id", ctx.businessUnitIds)
          .order("created_at", { ascending: false })
          .limit((args.limit as number) || 50)

        if (args.status) query = query.eq("status", args.status)
        if (args.client_id) query = query.eq("client_id", args.client_id)
        if (args.engagement_type) query = query.eq("engagement_type", args.engagement_type)

        const { data, error } = await query
        if (error) throw new Error(error.message)
        return data
      },
    })

    tools.push({
      name: "get_project",
      description: "Get full project details including team allocations and owners.",
      inputSchema: {
        type: "object",
        required: ["project_id"],
        properties: {
          project_id: { type: "string" },
        },
      },
      handler: async (args) => {
        const { data, error } = await client
          .from("projects")
          .select(`*, clients(client_name), project_allocations(*, team_members(name, email)), project_owners(*, team_members(name))`)
          .eq("id", args.project_id)
          .in("business_unit_id", ctx.businessUnitIds)
          .single()
        if (error) throw new Error(error.message)
        return data
      },
    })
  }

  if (hasPermission(ctx, "pm", "pm_projects", "create")) {
    tools.push({
      name: "create_project",
      description: "Create a new project.",
      inputSchema: {
        type: "object",
        required: ["business_unit_id", "client_id", "project_name"],
        properties: {
          business_unit_id: { type: "string" },
          client_id: { type: "string" },
          project_name: { type: "string" },
          description: { type: "string" },
          engagement_type: { type: "string", enum: ["retainer", "fixed", "time_and_material"] },
          status: { type: "string", default: "active" },
        },
      },
      handler: async (args) => {
        if (!ctx.businessUnitIds.includes(args.business_unit_id as string)) {
          throw new Error("You do not have access to this business unit")
        }
        const { data, error } = await client
          .from("projects")
          .insert({ ...args, created_by: ctx.userId })
          .select()
          .single()
        if (error) throw new Error(error.message)
        return data
      },
    })
  }

  // ── TIMESHEETS ────────────────────────────────────────────────────────────
  if (hasPermission(ctx, "pm", "pm_timesheets", "view")) {
    tools.push({
      name: "list_timesheets",
      description: "List timesheets. Filter by status, team member, or date range.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["draft", "submitted", "rm_approved", "approved", "rejected"] },
          team_member_id: { type: "string" },
          from_date: { type: "string", description: "Week start date (YYYY-MM-DD)" },
          to_date: { type: "string", description: "Week start date (YYYY-MM-DD)" },
          limit: { type: "number" },
        },
      },
      handler: async (args) => {
        let query = client
          .from("timesheets")
          .select("*, team_members(name, email)")
          .in("business_unit_id", ctx.businessUnitIds)
          .order("week_start_date", { ascending: false })
          .limit((args.limit as number) || 50)

        if (args.status) query = query.eq("status", args.status)
        if (args.team_member_id) query = query.eq("team_member_id", args.team_member_id)
        if (args.from_date) query = query.gte("week_start_date", args.from_date)
        if (args.to_date) query = query.lte("week_start_date", args.to_date)

        const { data, error } = await query
        if (error) throw new Error(error.message)
        return data
      },
    })

    tools.push({
      name: "get_timesheet",
      description: "Get full timesheet with all entries broken down by project and task.",
      inputSchema: {
        type: "object",
        required: ["timesheet_id"],
        properties: {
          timesheet_id: { type: "string" },
        },
      },
      handler: async (args) => {
        const { data, error } = await client
          .from("timesheets")
          .select(`*, team_members(name, email), timesheet_entries(*, projects(project_name), timesheet_tasks(name))`)
          .eq("id", args.timesheet_id)
          .in("business_unit_id", ctx.businessUnitIds)
          .single()
        if (error) throw new Error(error.message)
        return data
      },
    })
  }

  if (hasPermission(ctx, "pm", "pm_timesheet_approvals", "view")) {
    tools.push({
      name: "list_pending_timesheet_approvals",
      description: "List timesheets pending approval.",
      inputSchema: {
        type: "object",
        properties: {
          business_unit_id: { type: "string" },
          limit: { type: "number" },
        },
      },
      handler: async (args) => {
        let query = client
          .from("timesheets")
          .select("*, team_members(name, email)")
          .in("business_unit_id", ctx.businessUnitIds)
          .eq("status", "submitted")
          .order("submitted_at")
          .limit((args.limit as number) || 50)

        if (args.business_unit_id) query = query.eq("business_unit_id", args.business_unit_id)

        const { data, error } = await query
        if (error) throw new Error(error.message)
        return data
      },
    })
  }

  // ── PM TEAM MEMBERS ───────────────────────────────────────────────────────
  if (hasPermission(ctx, "pm", "pm_team_members", "view")) {
    tools.push({
      name: "list_pm_team_members",
      description: "List team members available in project management.",
      inputSchema: {
        type: "object",
        properties: {
          is_archived: { type: "boolean", description: "Include archived members (default false)" },
          team_id: { type: "string" },
          limit: { type: "number" },
        },
      },
      handler: async (args) => {
        let query = client
          .from("team_members")
          .select("id, name, email, employee_id, date_of_joining, designations(title), teams(name)")
          .in("business_unit_id", ctx.businessUnitIds)
          .eq("is_archived", (args.is_archived as boolean) ?? false)
          .order("name")
          .limit((args.limit as number) || 100)

        if (args.team_id) query = query.eq("team_id", args.team_id)

        const { data, error } = await query
        if (error) throw new Error(error.message)
        return data
      },
    })
  }

  return tools
}
