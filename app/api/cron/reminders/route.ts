import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email";
import { fmtDate } from "@/app/board/ui";
import { anyInstrumentMentioned, instrumentMentioned } from "@/lib/instruments";
import { musiciansAvailableOn, notifyMusicianOfRelease } from "@/lib/notifications";
import type { DjTier, Instrument } from "@/lib/supabase/types";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://board.austoentertainment.com";
const HOLD_DAYS = 14;

// Runs once daily (see vercel.json — 16:00 UTC, which is 9am Pacific during
// daylight saving; Vercel Cron has no timezone awareness, so this drifts to
// 8am Pacific once DST ends in November). Housekeeping below still runs
// every tick — only the digest emails further down are throttled to
// every other day.
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

  // Musician stage auto-advance: booking a musician already flips the
  // stage to 'planning' via a DB trigger (trg_advance_musician_stage), so
  // the two states left to derive here are past events that got a
  // musician booked (complete), and DJ-booked leads where the musician
  // add-on interest never converted (booked_no_musician) — new/pending_
  // booking/archived stay owner-controlled since they reflect real-world
  // events (the intro call, going cold) nothing else can infer.
  await admin.from("leads").update({ musician_stage: "complete" }).eq("musician_stage", "planning").lt("event_date", today);

  const { data: bookedNoMusicianCandidates } = await admin
    .from("leads")
    .select("id, upgrades, client_vision")
    .in("status", ["booked", "played"])
    .in("musician_stage", ["new", "pending_booking"]);
  const musicianRelevant = (bookedNoMusicianCandidates ?? []).filter(anyInstrumentMentioned);
  if (musicianRelevant.length > 0) {
    const { data: alreadyBooked } = await admin
      .from("lead_musicians")
      .select("lead_id")
      .in("lead_id", musicianRelevant.map((l) => l.id));
    const bookedLeadIds = new Set((alreadyBooked ?? []).map((b) => b.lead_id));
    const toFlip = musicianRelevant.filter((l) => !bookedLeadIds.has(l.id)).map((l) => l.id);
    if (toFlip.length > 0) {
      await admin.from("leads").update({ musician_stage: "booked_no_musician" }).in("id", toFlip);
    }
  }

  // Release-the-hold emails: leads whose 14-day musician hold has expired
  // without converting to a booking (a lead that did get booked already
  // flipped to 'planning' via the DB trigger, so it won't show up in this
  // 'pending_booking' query at all). This runs every tick regardless of
  // the digest cadence below — it's a one-time notice per musician per
  // lead, not a recurring nag — and is deduped via a 'musician_release_
  // sent' events row so it never repeats for the same pair.
  const { data: pendingLeads } = await admin.from("leads").select("*").eq("musician_stage", "pending_booking");
  const holdExpired = (pendingLeads ?? []).filter((l) => {
    if (!l.musician_meeting_date) return false;
    const holdUntil = new Date(l.musician_meeting_date + "T12:00:00").getTime() + HOLD_DAYS * 24 * 60 * 60 * 1000;
    return Date.now() >= holdUntil;
  });
  if (holdExpired.length > 0) {
    const { data: alreadyReleased } = await admin
      .from("events")
      .select("lead_id, actor_user_id")
      .eq("event_type", "musician_release_sent")
      .in("lead_id", holdExpired.map((l) => l.id));
    const releasedPairs = new Set((alreadyReleased ?? []).map((e) => `${e.lead_id}:${e.actor_user_id}`));

    for (const lead of holdExpired) {
      const musicians = await musiciansAvailableOn(admin, lead.id);
      for (const musician of musicians) {
        if (releasedPairs.has(`${lead.id}:${musician.id}`)) continue;
        await notifyMusicianOfRelease(lead, musician);
        await admin.from("events").insert({ lead_id: lead.id, actor_user_id: musician.id, event_type: "musician_release_sent" });
      }
    }
  }

  // Digest emails (DJ + musician open-response reminders) fire once every
  // ~2 days rather than every day the cron itself runs — a sentinel event
  // with no lead_id records the last time either digest actually went
  // out, so this is driven by elapsed time rather than an every-other-day
  // cron schedule (which drifts at month boundaries) or a schema change.
  const { data: lastDigest } = await admin
    .from("events")
    .select("created_at")
    .eq("event_type", "reminder_digest_sent")
    .is("lead_id", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const hoursSinceLastDigest = lastDigest ? (Date.now() - new Date(lastDigest.created_at).getTime()) / 3600000 : Infinity;
  const digestDue = hoursSinceLastDigest >= 47;

  let djReminded = 0;
  let musicianReminded = 0;

  if (digestDue) {
    const { data: rawCheckingLeads } = await admin.from("leads").select("*").eq("status", "checking");
    // Headliner leads stay hidden from every DJ but the owner until he
    // personally passes — same rule leads_feed enforces for what a DJ can
    // even see on the board (see the view's WHERE clause in schema.sql).
    // Reminding a DJ about one he can't see yet was the bug behind "I got
    // a Date Check email but there's nothing on my board."
    let checkingLeads = rawCheckingLeads ?? [];
    const headlinerLeadIds = checkingLeads.filter((l) => l.dj_tier === "Headliner").map((l) => l.id);
    if (headlinerLeadIds.length > 0) {
      const { data: owners } = await admin.from("users").select("id").eq("role", "owner");
      const { data: ownerPasses } = await admin
        .from("availability_responses")
        .select("lead_id")
        .eq("response", "pass")
        .in("dj_user_id", (owners ?? []).map((o) => o.id))
        .in("lead_id", headlinerLeadIds);
      const ownerPassedLeadIds = new Set((ownerPasses ?? []).map((p) => p.lead_id));
      checkingLeads = checkingLeads.filter((l) => l.dj_tier !== "Headliner" || ownerPassedLeadIds.has(l.id));
    }
    if (checkingLeads.length > 0) {
      const { data: djs } = await admin.from("users").select("id, email, display_name").eq("role", "dj");
      const { data: djProfiles } = await admin
        .from("dj_profiles")
        .select("user_id, dj_tier_visibility, notify_email")
        .in("user_id", (djs ?? []).map((d) => d.id));
      const { data: checkResponses } = await admin
        .from("availability_responses")
        .select("lead_id, dj_user_id")
        .in("lead_id", checkingLeads.map((l) => l.id));
      const respondedPairs = new Set((checkResponses ?? []).map((r) => `${r.lead_id}:${r.dj_user_id}`));

      for (const dj of djs ?? []) {
        const profile = djProfiles?.find((p) => p.user_id === dj.id);
        if (profile && profile.notify_email === false) continue;
        // Empty visibility means not qualified for anything yet — same
        // rule as everywhere else this tier check appears.
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
        djReminded++;
      }
    }

    // Musician digest — same idea as the DJ one above, except a musician's
    // "open" pool is instrument-matched leads still in musician_stage
    // 'new' (their Date Checks tab) they haven't answered yet, rather
    // than a tier-matched status.
    const { data: newMusicianLeads } = await admin.from("leads").select("*").eq("musician_stage", "new");
    if (newMusicianLeads && newMusicianLeads.length > 0) {
      const { data: musicians } = await admin.from("users").select("id, email, display_name").eq("role", "musician");
      const { data: musicianProfiles } = await admin
        .from("dj_profiles")
        .select("user_id, instrument, notify_email")
        .in("user_id", (musicians ?? []).map((m) => m.id));
      const { data: newResponses } = await admin
        .from("availability_responses")
        .select("lead_id, dj_user_id")
        .in("lead_id", newMusicianLeads.map((l) => l.id));
      const respondedPairs = new Set((newResponses ?? []).map((r) => `${r.lead_id}:${r.dj_user_id}`));

      for (const musician of musicians ?? []) {
        const profile = musicianProfiles?.find((p) => p.user_id === musician.id);
        if (profile && profile.notify_email === false) continue;
        const instrument = profile?.instrument as Instrument | undefined;
        if (!instrument) continue;

        const pending = newMusicianLeads.filter((lead) =>
          instrumentMentioned(lead, instrument) && !respondedPairs.has(`${lead.id}:${musician.id}`)
        );
        if (pending.length === 0) continue;

        const rows = pending
          .map((lead) => {
            const d = fmtDate(lead.event_date);
            return `<li><strong>${d.mon} ${d.day}${d.year ? `, ${d.year}` : ""}</strong>${lead.location ? ` — ${lead.location}` : ""}</li>`;
          })
          .join("");

        const count = pending.length;
        await sendEmail({
          to: musician.email,
          subject: `${count} open date check${count === 1 ? "" : "s"} waiting on you`,
          html: `
            <p>Hey ${musician.display_name || "there"} — you've got ${count} open date check${count === 1 ? "" : "s"} that still need a response.</p>
            <ul>${rows}</ul>
            <p><a href="${SITE_URL}/board">Open the board and mark yourself available or pass →</a></p>
          `,
        });

        for (const lead of pending) {
          await admin.from("events").insert({ lead_id: lead.id, actor_user_id: musician.id, event_type: "reminder_sent" });
        }
        musicianReminded++;
      }
    }

    await admin.from("events").insert({ event_type: "reminder_digest_sent" });
  }

  return NextResponse.json({ ok: true, digestDue, djReminded, musicianReminded, released: holdExpired.length });
}
