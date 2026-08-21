import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

async function requireOwner() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase.from("users").select("role").eq("id", user.id).single();
  return profile?.role === "owner" ? user : null;
}

export async function GET(request: Request) {
  const owner = await requireOwner();
  if (!owner) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // Defaults to the last 48 hours — the Roster tab's Email Log opens
  // scoped to that window, with a link to widen it.
  const hours = Number(new URL(request.url).searchParams.get("hours")) || 48;
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("email_log")
    .select("id, to_email, subject, html, failed, created_at")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ emails: data ?? [] });
}
