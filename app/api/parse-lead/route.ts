import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { parseLeadWithClaude, LeadParseError } from "@/lib/parseLead";

async function requireOwner() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase.from("users").select("role").eq("id", user.id).single();
  return profile?.role === "owner" ? user : null;
}

export async function POST(request: Request) {
  const owner = await requireOwner();
  if (!owner) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { raw } = await request.json();

  try {
    const parsed = await parseLeadWithClaude(raw);
    return NextResponse.json(parsed);
  } catch (err) {
    if (err instanceof LeadParseError) {
      const message = err.status === 503
        ? "ANTHROPIC_API_KEY isn't set yet — add it in Vercel env vars, or use Add Manually for now."
        : err.message;
      return NextResponse.json({ error: message }, { status: err.status });
    }
    return NextResponse.json({ error: "Couldn't parse that — try Add Manually" }, { status: 502 });
  }
}
