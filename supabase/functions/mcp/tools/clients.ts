import { SupabaseClient } from "npm:@supabase/supabase-js@2"
import { MCPTool, UserContext } from "../types.ts"
import { hasPermission } from "../permissions.ts"

export function buildClientTools(client: SupabaseClient, ctx: UserContext): MCPTool[] {
  const tools: MCPTool[] = []
  const canView   = hasPermission(ctx, "clients", "clients", "view")
  const canCreate = hasPermission(ctx, "clients", "clients", "create")
  const canUpdate = hasPermission(ctx, "clients", "clients", "update")
  const canDelete = hasPermission(ctx, "clients", "clients", "delete")

  if (!canView) return tools

  tools.push({
    name: "list_clients",
    description: "List all clients across your business units. Filter by status or search by name.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["active", "inactive"], description: "Filter by client status" },
        search: { type: "string", description: "Search by client name" },
        business_unit_id: { type: "string", description: "Filter by specific business unit ID" },
        limit: { type: "number", description: "Max records to return (default 50)" },
      },
    },
    handler: async (args) => {
      let query = client
        .from("clients")
        .select("id, client_name, legal_name, country, status, default_billing_currency, default_payment_terms, created_at")
        .in("business_unit_id", ctx.businessUnitIds)
        .order("client_name")
        .limit((args.limit as number) || 50)

      if (args.status) query = query.eq("status", args.status)
      if (args.search) query = query.ilike("client_name", `%${args.search}%`)
      if (args.business_unit_id) query = query.eq("business_unit_id", args.business_unit_id)

      const { data, error } = await query
      if (error) throw new Error(error.message)
      return data
    },
  })

  tools.push({
    name: "get_client",
    description: "Get full details of a client including contacts and tax configuration.",
    inputSchema: {
      type: "object",
      required: ["client_id"],
      properties: {
        client_id: { type: "string", description: "The client UUID" },
      },
    },
    handler: async (args) => {
      const { data, error } = await client
        .from("clients")
        .select(`
          *,
          client_contacts (*),
          client_tax_config (*),
          client_tax_applicable (*),
          client_tax_deductible (*)
        `)
        .eq("id", args.client_id)
        .in("business_unit_id", ctx.businessUnitIds)
        .single()

      if (error) throw new Error(error.message)
      return data
    },
  })

  if (canCreate) {
    tools.push({
      name: "create_client",
      description: "Create a new client.",
      inputSchema: {
        type: "object",
        required: ["business_unit_id", "client_name"],
        properties: {
          business_unit_id: { type: "string", description: "Business unit this client belongs to" },
          client_name: { type: "string", description: "Client display name" },
          legal_name: { type: "string", description: "Legal entity name" },
          country: { type: "string", description: "Country" },
          default_billing_currency: { type: "string", description: "Default billing currency (e.g. USD)" },
          default_payment_terms: { type: "number", description: "Default payment terms in days" },
          notes: { type: "string", description: "Additional notes" },
        },
      },
      handler: async (args) => {
        if (!ctx.businessUnitIds.includes(args.business_unit_id as string)) {
          throw new Error("You do not have access to this business unit")
        }
        const { data, error } = await client
          .from("clients")
          .insert({ ...args, created_by: ctx.userId })
          .select()
          .single()
        if (error) throw new Error(error.message)
        return data
      },
    })
  }

  if (canUpdate) {
    tools.push({
      name: "update_client",
      description: "Update an existing client's details.",
      inputSchema: {
        type: "object",
        required: ["client_id"],
        properties: {
          client_id: { type: "string", description: "The client UUID" },
          client_name: { type: "string" },
          legal_name: { type: "string" },
          country: { type: "string" },
          status: { type: "string", enum: ["active", "inactive"] },
          notes: { type: "string" },
          default_payment_terms: { type: "number" },
        },
      },
      handler: async (args) => {
        const { client_id, ...updates } = args
        const { data, error } = await client
          .from("clients")
          .update({ ...updates, updated_at: new Date().toISOString() })
          .eq("id", client_id)
          .in("business_unit_id", ctx.businessUnitIds)
          .select()
          .single()
        if (error) throw new Error(error.message)
        return data
      },
    })
  }

  if (canDelete) {
    tools.push({
      name: "delete_client",
      description: "Delete a client. Use with caution — this is irreversible.",
      inputSchema: {
        type: "object",
        required: ["client_id"],
        properties: {
          client_id: { type: "string", description: "The client UUID" },
        },
      },
      handler: async (args) => {
        const { error } = await client
          .from("clients")
          .delete()
          .eq("id", args.client_id)
          .in("business_unit_id", ctx.businessUnitIds)
        if (error) throw new Error(error.message)
        return { success: true, deleted_id: args.client_id }
      },
    })
  }

  return tools
}
