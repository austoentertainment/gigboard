import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email";
import { fmtDate } from "@/app/board/ui";
import type { DjTier } from "@/lib/supabase/types";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://board.austoentertainment.com";
const REMINDER_AFTER_MS = 48 * 60 * 60 * 1000;

export async function GET(request: Request) {
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const admin = createAdminClient();

  // Auto-archive past events: booked gigs that happened are assumed played;
  // anything still stuck in checking/meeting once the date's gone is a
  // missed opportunity, not a played gig.
  const today = new Date().toISOString().slice(0, 10);
  await admin.from("leads").update({ status: "played" }).eq("status", "booked").lt("event_date", today);
  await admin.from("leads").update({ status: "lost" }).in("status", ["checking", "meeting"]).lt("event_date", today);

  const cutoff = new Date(Date.now() - REMINDER_AFTER_MS).toISOString();

  const { data: staleLeads } = await admin
    .from("leads")
    .select("*")
    .eq("status", "checking")
    .lt("created_at", cutoff);

  if (!staleLeads || staleLeads.length === 0) {
    return NextResponse.json({ ok: true, reminded: 0 });
  }

  const { data: djs } = await admin.from("users").select("id, email, display_name").eq("role", "dj");
  if (!djs || djs.length === 0) return NextResponse.json({ ok: true, reminded: 0 });

  const { data: profiles } = await admin
    .from("dj_profiles")
    .select("user_id, dj_tier_visibility, notify_email")
    .in("user_id", djs.map((d) => d.id));

  let reminded = 0;

  for (const lead of staleLeads) {
    const { data: responded } = await admin
      .from("availability_responses")
      .select("dj_user_id")
      .eq("lead_id", lead.id);
    const respondedIds = new Set((responded ?? []).map((r) => r.dj_user_id));

    const { data: alreadyReminded } = await admin
      .from("events")
      .select("actor_user_id")
      .eq("lead_id", lead.id)
      .eq("event_type", "reminder_sent");
    const remindedIds = new Set((alreadyReminded ?? []).map((e) => e.actor_user_id));

    for (const dj of djs) {
      if (respondedIds.has(dj.id) || remindedIds.has(dj.id)) continue;
      const profile = profiles?.find((p) => p.user_id === dj.id);
      if (profile && profile.notify_email === false) continue;
      const visibility = (profile?.dj_tier_visibility ?? []) as DjTier[];
      const tierMatches = visibility.length === 0 || !lead.dj_tier || visibility.includes(lead.dj_tier as DjTier);
      if (!tierMatches) continue;

      const d = fmtDate(lead.event_date);
      await sendEmail({
        to: dj.email,
        subject: "Still open — quick date check reminder",
        html: `
          <p>Hey ${dj.display_name || "there"} — this date check is still waiting on you.</p>
          <p><strong>${d.mon} ${d.day}${d.year ? `, ${d.year}` : ""}</strong>${lead.location ? ` — ${lead.location}` : ""}</p>
          <p><a href="${SITE_URL}/board?lead=${lead.id}">Mark yourself available or pass →</a></p>
        `,
      });
      await admin.from("events").insert({ lead_id: lead.id, actor_user_id: dj.id, event_type: "reminder_sent" });
      reminded++;
    }
  }

  return NextResponse.json({ ok: true, reminded });
}
