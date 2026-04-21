import { SupabaseClient } from "npm:@supabase/supabase-js@2"
import { UserContext, UserPermission } from "./types.ts"

export async function loadUserContext(
  client: SupabaseClient,
  userId: string
): Promise<UserContext> {
  const { data: memberships, error } = await client
    .from("business_unit_members")
    .select(`
      business_unit_id,
      invite_status,
      custom_roles (
        id,
        name,
        custom_role_permissions (
          parent_module,
          sub_module,
          module_enabled,
          can_view,
          can_create,
          can_update,
          can_delete,
          can_export,
          can_import
        )
      )
    `)
    .eq("user_id", userId)
    .eq("invite_status", "accepted")

  if (error) {
    console.error("Error loading permissions:", error)
    return { userId, businessUnitIds: [], permissions: [] }
  }

  if (!memberships || memberships.length === 0) {
    return { userId, businessUnitIds: [], permissions: [] }
  }

  const businessUnitIds = memberships.map((m: any) => m.business_unit_id)
  const permMap = new Map<string, UserPermission>()

  for (const membership of memberships as any[]) {
    const role = membership.custom_roles
    if (!role?.custom_role_permissions) continue

    for (const p of role.custom_role_permissions) {
      const key = `${p.parent_module}:${p.sub_module}`
      const existing = permMap.get(key)

      // Union permissions across multiple roles — most permissive wins
      permMap.set(key, {
        parentModule: p.parent_module,
        subModule: p.sub_module,
        moduleEnabled: p.module_enabled || existing?.moduleEnabled || false,
        canView: p.can_view || existing?.canView || false,
        canCreate: p.can_create || existing?.canCreate || false,
        canUpdate: p.can_update || existing?.canUpdate || false,
        canDelete: p.can_delete || existing?.canDelete || false,
        canExport: p.can_export || existing?.canExport || false,
        canImport: p.can_import || existing?.canImport || false,
      })
    }
  }

  return {
    userId,
    businessUnitIds,
    permissions: Array.from(permMap.values()).filter(p => p.moduleEnabled),
  }
}

export function hasPermission(
  ctx: UserContext,
  parentModule: string,
  subModule: string,
  action: "view" | "create" | "update" | "delete" | "export" | "import"
): boolean {
  const perm = ctx.permissions.find(
    p => p.parentModule === parentModule && p.subModule === subModule
  )
  if (!perm || !perm.moduleEnabled) return false

  switch (action) {
    case "view":   return perm.canView
    case "create": return perm.canCreate
    case "update": return perm.canUpdate
    case "delete": return perm.canDelete
    case "export": return perm.canExport
    case "import": return perm.canImport
  }
}
