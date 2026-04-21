import { SupabaseClient } from "npm:@supabase/supabase-js@2"
import { MCPTool, UserContext } from "../types.ts"
import { buildClientTools } from "./clients.ts"
import { buildFinanceTools } from "./finance.ts"
import { buildCrmTools } from "./crm.ts"
import { buildPmTools } from "./pm.ts"
import { buildHrTools } from "./hr.ts"

export function buildAllTools(client: SupabaseClient, ctx: UserContext): MCPTool[] {
  return [
    // Meta tool — always available, shows what the user can access
    {
      name: "get_my_access",
      description: "Shows your business units and what modules you have access to.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => ({
        user_id: ctx.userId,
        business_unit_ids: ctx.businessUnitIds,
        permissions: ctx.permissions.map(p => ({
          module: `${p.parentModule}:${p.subModule}`,
          can_view: p.canView,
          can_create: p.canCreate,
          can_update: p.canUpdate,
          can_delete: p.canDelete,
        })),
      }),
    },

    ...buildClientTools(client, ctx),
    ...buildFinanceTools(client, ctx),
    ...buildCrmTools(client, ctx),
    ...buildPmTools(client, ctx),
    ...buildHrTools(client, ctx),
  ]
}
