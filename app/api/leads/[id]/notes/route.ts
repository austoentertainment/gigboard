import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const { notes } = await request.json();
  if (typeof notes !== "string") return NextResponse.json({ error: "notes must be a string" }, { status: 400 });

  const admin = createAdminClient();

  const { data: profile } = await admin.from("users").select("role").eq("id", user.id).single();
  const { data: lead } = await admin.from("leads").select("assigned_dj_id").eq("id", id).single();
  if (!lead) return NextResponse.json({ error: "Lead not found" }, { status: 404 });

  const allowed = profile?.role === "owner" || lead.assigned_dj_id === user.id;
  if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { error } = await admin.from("leads").update({ meeting_notes: notes }).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
