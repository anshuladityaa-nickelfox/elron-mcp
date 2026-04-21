import { createClient } from "npm:@supabase/supabase-js@2"

const SUPABASE_URL = "https://vqbawakmcbnotxfltrws.supabase.co"

export type AuthResult =
  | { success: true; userId: string; token: string }
  | { success: false; error: string }

export async function validateAuth(req: Request): Promise<AuthResult> {
  const authHeader = req.headers.get("Authorization")
  if (!authHeader?.startsWith("Bearer ")) {
    return { success: false, error: "Missing or invalid Authorization header" }
  }

  const token = authHeader.replace("Bearer ", "").trim()
  if (!token) {
    return { success: false, error: "Empty token" }
  }

  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!
  const supabase = createClient(SUPABASE_URL, anonKey)

  const { data: { user }, error } = await supabase.auth.getUser(token)

  if (error || !user) {
    return { success: false, error: "Invalid or expired token" }
  }

  return { success: true, userId: user.id, token }
}
