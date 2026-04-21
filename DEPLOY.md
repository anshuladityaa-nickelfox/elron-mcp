# Deployment Guide

## Prerequisites
- Supabase CLI installed: `npm install -g supabase`
- Logged in: `supabase login`

## Step 1 — Link to your project
```bash
supabase link --project-ref vqbawakmcbnotxfltrws
```

## Step 2 — Deploy the MCP function
```bash
supabase functions deploy mcp --no-verify-jwt
```

The `--no-verify-jwt` flag is required so the function handles its own JWT
validation (needed for the MCP OAuth flow).

## Step 4 — Enable Supabase OAuth 2.1 (for Claude Desktop auth)

1. Go to Supabase Dashboard → Authentication → OAuth Apps
2. The MCP client (Claude Desktop) will auto-register via dynamic client registration
   when a user first connects — no manual app registration needed.

## Step 5 — Connect Claude Desktop

Each user adds this to their Claude Desktop config file:

**Mac:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "elron": {
      "url": "https://vqbawakmcbnotxfltrws.supabase.co/functions/v1/mcp"
    }
  }
}
```

First time Claude opens → browser popup → user enters their email → OTP sent to inbox
→ user enters OTP code → clicks Approve → done.
Every session after that is fully automatic (no OTP again).

## Verification

Test the endpoint is live:
```bash
curl https://vqbawakmcbnotxfltrws.supabase.co/functions/v1/mcp
# Should return: {"status":"ok","server":{"name":"elron-mcp","version":"1.0.0"}}
```

## How permissions work

- Tools available to a user are determined by their `custom_role_permissions` at login time
- If admin changes a user's role → takes effect on their next Claude session
- New invited users work automatically once they accept their invite
- RLS enforces access at the DB layer as a second security check
