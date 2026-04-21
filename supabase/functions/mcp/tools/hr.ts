import { SupabaseClient } from "npm:@supabase/supabase-js@2"
import { MCPTool, UserContext } from "../types.ts"
import { hasPermission } from "../permissions.ts"

export function buildHrTools(client: SupabaseClient, ctx: UserContext): MCPTool[] {
  const tools: MCPTool[] = []

  // ── TEAM MEMBERS ──────────────────────────────────────────────────────────
  if (hasPermission(ctx, "hr", "hr_team_members", "view")) {
    tools.push({
      name: "list_team_members",
      description: "List all team members. Filter by team, designation, or archived status.",
      inputSchema: {
        type: "object",
        properties: {
          is_archived: { type: "boolean" },
          team_id: { type: "string" },
          designation_id: { type: "string" },
          search: { type: "string", description: "Search by name or email" },
          limit: { type: "number" },
        },
      },
      handler: async (args) => {
        let query = client
          .from("team_members")
          .select("id, name, email, employee_id, phone, date_of_joining, is_archived, designations(title), teams(name)")
          .in("business_unit_id", ctx.businessUnitIds)
          .eq("is_archived", (args.is_archived as boolean) ?? false)
          .order("name")
          .limit((args.limit as number) || 100)

        if (args.team_id) query = query.eq("team_id", args.team_id)
        if (args.designation_id) query = query.eq("designation_id", args.designation_id)
        if (args.search) query = query.or(`name.ilike.%${args.search}%,email.ilike.%${args.search}%`)

        const { data, error } = await query
        if (error) throw new Error(error.message)
        return data
      },
    })

    tools.push({
      name: "get_team_member",
      description: "Get full profile of a team member including team, designation, and reporting manager.",
      inputSchema: {
        type: "object",
        required: ["team_member_id"],
        properties: {
          team_member_id: { type: "string" },
        },
      },
      handler: async (args) => {
        const { data, error } = await client
          .from("team_members")
          .select(`*, designations(title, description), teams(name, description), reporting_manager:team_members!reporting_manager_id(name, email)`)
          .eq("id", args.team_member_id)
          .in("business_unit_id", ctx.businessUnitIds)
          .single()
        if (error) throw new Error(error.message)
        return data
      },
    })
  }

  if (hasPermission(ctx, "hr", "hr_team_members", "create")) {
    tools.push({
      name: "create_team_member",
      description: "Add a new team member.",
      inputSchema: {
        type: "object",
        required: ["business_unit_id", "employee_id", "name", "phone", "email", "date_of_joining"],
        properties: {
          business_unit_id: { type: "string" },
          employee_id: { type: "string" },
          name: { type: "string" },
          email: { type: "string" },
          phone: { type: "string" },
          date_of_joining: { type: "string", description: "YYYY-MM-DD" },
          designation_id: { type: "string" },
          team_id: { type: "string" },
          reporting_manager_id: { type: "string" },
        },
      },
      handler: async (args) => {
        if (!ctx.businessUnitIds.includes(args.business_unit_id as string)) {
          throw new Error("You do not have access to this business unit")
        }
        const { data, error } = await client
          .from("team_members")
          .insert({ ...args, created_by: ctx.userId })
          .select()
          .single()
        if (error) throw new Error(error.message)
        return data
      },
    })
  }

  if (hasPermission(ctx, "hr", "hr_team_members", "update")) {
    tools.push({
      name: "update_team_member",
      description: "Update a team member's details.",
      inputSchema: {
        type: "object",
        required: ["team_member_id"],
        properties: {
          team_member_id: { type: "string" },
          name: { type: "string" },
          phone: { type: "string" },
          designation_id: { type: "string" },
          team_id: { type: "string" },
          reporting_manager_id: { type: "string" },
          is_archived: { type: "boolean" },
        },
      },
      handler: async (args) => {
        const { team_member_id, ...updates } = args
        const { data, error } = await client
          .from("team_members")
          .update({ ...updates, updated_at: new Date().toISOString() })
          .eq("id", team_member_id)
          .in("business_unit_id", ctx.businessUnitIds)
          .select()
          .single()
        if (error) throw new Error(error.message)
        return data
      },
    })
  }

  // ── TEAMS ─────────────────────────────────────────────────────────────────
  if (hasPermission(ctx, "hr", "hr_teams", "view")) {
    tools.push({
      name: "list_teams",
      description: "List all teams in the business unit.",
      inputSchema: {
        type: "object",
        properties: {
          business_unit_id: { type: "string" },
        },
      },
      handler: async (args) => {
        let query = client
          .from("teams")
          .select("id, name, description, created_at")
          .in("business_unit_id", ctx.businessUnitIds)
          .order("name")

        if (args.business_unit_id) query = query.eq("business_unit_id", args.business_unit_id)

        const { data, error } = await query
        if (error) throw new Error(error.message)
        return data
      },
    })
  }

  // ── DESIGNATIONS ──────────────────────────────────────────────────────────
  if (hasPermission(ctx, "hr", "hr_designations", "view")) {
    tools.push({
      name: "list_designations",
      description: "List all job designations/titles in the business unit.",
      inputSchema: {
        type: "object",
        properties: {
          business_unit_id: { type: "string" },
        },
      },
      handler: async (args) => {
        let query = client
          .from("designations")
          .select("id, title, description, created_at")
          .in("business_unit_id", ctx.businessUnitIds)
          .order("title")

        if (args.business_unit_id) query = query.eq("business_unit_id", args.business_unit_id)

        const { data, error } = await query
        if (error) throw new Error(error.message)
        return data
      },
    })
  }

  return tools
}
