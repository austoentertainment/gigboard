import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email";
import { fmtDate } from "@/app/board/ui";
import type { DjTier } from "@/lib/supabase/types";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://board.austoentertainment.com";

// Runs once daily (see vercel.json — 16:00 UTC, which is 9am Pacific during
// daylight saving; Vercel Cron has no timezone awareness, so this drifts to
// 8am Pacific once DST ends in November).
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

  // Auto-archive stale Pipeline leads: still unable to get a first meeting
  // booked 30 days after the lead came in reads as a dead lead, independent
  // of how far off the event date itself is.
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  await admin.from("leads").update({ status: "lost" }).eq("status", "checking").lt("created_at", thirtyDaysAgo);

  // One digest email per DJ, only if they actually have something open —
  // not a per-lead reminder, and no 48-hour staleness window: any date
  // check still sitting unanswered counts every time this runs.
  const { data: checkingLeads } = await admin.from("leads").select("*").eq("status", "checking");
  if (!checkingLeads || checkingLeads.length === 0) {
    return NextResponse.json({ ok: true, reminded: 0 });
  }

  const { data: djs } = await admin.from("users").select("id, email, display_name").eq("role", "dj");
  if (!djs || djs.length === 0) return NextResponse.json({ ok: true, reminded: 0 });

  const { data: profiles } = await admin
    .from("dj_profiles")
    .select("user_id, dj_tier_visibility, notify_email")
    .in("user_id", djs.map((d) => d.id));

  const { data: responses } = await admin
    .from("availability_responses")
    .select("lead_id, dj_user_id")
    .in("lead_id", checkingLeads.map((l) => l.id));
  const respondedPairs = new Set((responses ?? []).map((r) => `${r.lead_id}:${r.dj_user_id}`));

  let reminded = 0;

  for (const dj of djs) {
    const profile = profiles?.find((p) => p.user_id === dj.id);
    if (profile && profile.notify_email === false) continue;
    // Empty visibility means not qualified for anything yet — same rule
    // as everywhere else this tier check appears.
    const visibility = (profile?.dj_tier_visibility ?? []) as DjTier[];

    const pending = checkingLeads.filter((lead) => {
      const tierMatches = !lead.dj_tier || visibility.includes(lead.dj_tier as DjTier);
      return tierMatches && !respondedPairs.has(`${lead.id}:${dj.id}`);
    });
    if (pending.length === 0) continue;

    const rows = pending
      .map((lead) => {
        const d = fmtDate(lead.event_date);
        const tier = [lead.dj_tier, lead.prod_tier].filter(Boolean).join(" + ");
        return `<li><strong>${d.mon} ${d.day}${d.year ? `, ${d.year}` : ""}</strong>${tier ? ` — ${tier}` : ""}${lead.location ? ` — ${lead.location}` : ""}</li>`;
      })
      .join("");

    const count = pending.length;
    await sendEmail({
      to: dj.email,
      subject: `${count} open date check${count === 1 ? "" : "s"} waiting on you`,
      html: `
        <p>Hey ${dj.display_name || "there"} — you've got ${count} open date check${count === 1 ? "" : "s"} that still need a response.</p>
        <ul>${rows}</ul>
        <p><a href="${SITE_URL}/board">Open the board and mark yourself available or pass →</a></p>
      `,
    });

    for (const lead of pending) {
      await admin.from("events").insert({ lead_id: lead.id, actor_user_id: dj.id, event_type: "reminder_sent" });
    }
    reminded++;
  }

  return NextResponse.json({ ok: true, reminded });
}
