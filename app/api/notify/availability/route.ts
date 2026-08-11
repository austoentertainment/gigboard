import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { notifyOwnersOfAvailability, notifyDjsOfNewLead } from "@/lib/notifications";

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { leadId } = await request.json();
  if (!leadId) return NextResponse.json({ error: "leadId is required" }, { status: 400 });

  const admin = createAdminClient();

  const { data: response } = await admin
    .from("availability_responses")
    .select("response")
    .eq("lead_id", leadId)
    .eq("dj_user_id", user.id)
    .single();
  if (!response) return NextResponse.json({ ok: true, skipped: true });

  const { data: lead } = await admin.from("leads").select("*").eq("id", leadId).single();
  if (!lead || lead.status !== "checking") return NextResponse.json({ ok: true, skipped: true });

  const { data: profile } = await admin.from("users").select("display_name, email, role").eq("id", user.id).single();
  if (!profile) return NextResponse.json({ ok: true, skipped: true });

  // Austin gets first refusal on Headliner leads — leads_feed hides them
  // from every DJ until he passes, and the "new lead" email is held back
  // the same way (see /api/intake/honeybook and /api/notify/new-lead).
  // His pass is what releases both at once, to whichever DJs are
  // qualified for the Headliner tier.
  if (profile.role === "owner" && response.response === "pass" && lead.dj_tier === "Headliner") {
    await notifyDjsOfNewLead(lead);
    return NextResponse.json({ ok: true });
  }

  if (response.response !== "available") {
    return NextResponse.json({ ok: true, skipped: true });
  }

  await notifyOwnersOfAvailability(lead, profile);
  return NextResponse.json({ ok: true });
}
