export interface UserPermission {
  parentModule: string
  subModule: string
  moduleEnabled: boolean
  canView: boolean
  canCreate: boolean
  canUpdate: boolean
  canDelete: boolean
  canExport: boolean
  canImport: boolean
}

export interface UserContext {
  userId: string
  businessUnitIds: string[]
  permissions: UserPermission[]
}

export interface MCPTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  handler: (args: Record<string, unknown>) => Promise<unknown>
}

export interface MCPRequest {
  jsonrpc: "2.0"
  id?: string | number
  method: string
  params?: Record<string, unknown>
}

export interface MCPResponse {
  jsonrpc: "2.0"
  id?: string | number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}
