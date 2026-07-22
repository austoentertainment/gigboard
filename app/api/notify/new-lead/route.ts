import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { notifyDjsOfNewLead } from "@/lib/notifications";

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { data: profile } = await supabase.from("users").select("role").eq("id", user.id).single();
  if (profile?.role !== "owner") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { leadId } = await request.json();
  if (!leadId) return NextResponse.json({ error: "leadId is required" }, { status: 400 });

  const admin = createAdminClient();
  const { data: lead } = await admin.from("leads").select("*").eq("id", leadId).single();
  if (!lead) return NextResponse.json({ error: "Lead not found" }, { status: 404 });

  await notifyDjsOfNewLead(lead);
  return NextResponse.json({ ok: true });
}
