# Austo Gig Board

Lead pipeline and DJ date-check board for Austo Entertainment. Next.js 16 + Supabase (Postgres, Auth, RLS) + Vercel.

## Local development

```bash
npm install
npm run dev
```

Needs a `.env.local` with:

```
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
```

## Database

Run `supabase/schema.sql` once in the Supabase SQL editor (Database → SQL Editor) to create the tables, RLS policies, and the `leads_feed` view that hides `client_name`/`contact`/`owner_notes` from DJ accounts.

## Environment variables (Vercel)

| Key | Used for |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon/public key |
| `SUPABASE_SERVICE_ROLE_KEY` | Roster invite/remove (admin API routes) |
| `ANTHROPIC_API_KEY` | Paste-import lead parsing (`/api/parse-lead`) — falls back to manual entry if unset |

## Deploys

Pushing to `main` auto-deploys via the connected GitHub → Vercel integration.
