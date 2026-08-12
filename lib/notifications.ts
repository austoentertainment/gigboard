import { createAdminClient } from "./supabase/admin";
import { sendEmail } from "./email";
import { fmtDate } from "@/app/board/ui";
import { INSTRUMENT_KEYWORD } from "./instruments";
import type { Database, DjTier, Instrument } from "./supabase/types";

type Lead = Database["public"]["Tables"]["leads"]["Row"];

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://board.austoentertainment.com";

function leadSummaryHtml(lead: Lead) {
  const d = fmtDate(lead.event_date);
  const tier = [lead.dj_tier, lead.prod_tier].filter(Boolean).join(" + ");
  const total = (lead.payout || 0) + (lead.travel_rate || 0);
  const names = [lead.client_name, lead.fiance_name].filter(Boolean).join(" + ");
  return `
    <p><strong>${d.dow ? `${d.dow}, ` : ""}${d.mon} ${d.day}${d.year ? `, ${d.year}` : ""}</strong></p>
    ${names ? `<p>${names}</p>` : ""}
    <p>${tier || "Tier TBD"}${lead.location ? ` — ${lead.location}` : ""}</p>
    ${total ? `<p>$${total} payout${lead.travel_rate ? ` (includes $${lead.travel_rate} travel)` : ""}</p>` : ""}
  `;
}

export async function notifyDjsOfNewLead(lead: Lead) {
  const admin = createAdminClient();

  const { data: djs } = await admin.from("users").select("id, email, display_name").eq("role", "dj");
  if (!djs || djs.length === 0) return;

  const { data: profiles } = await admin
    .from("dj_profiles")
    .select("user_id, dj_tier_visibility, notify_email")
    .in("user_id", djs.map((d) => d.id));

  const link = `${SITE_URL}/board?lead=${lead.id}`;

  for (const dj of djs) {
    const profile = profiles?.find((p) => p.user_id === dj.id);
    if (profile && profile.notify_email === false) continue;
    // Empty visibility means the owner hasn't qualified this DJ for any
    // tier yet — that's "not eligible for anything", not "eligible for
    // everything", so no fallback to "no tiers set = show all" here.
    const visibility = (profile?.dj_tier_visibility ?? []) as DjTier[];
    const tierMatches = !lead.dj_tier || visibility.includes(lead.dj_tier as DjTier);
    if (!tierMatches) continue;

    const names = [lead.client_name, lead.fiance_name].filter(Boolean).join(" + ");
    await sendEmail({
      to: dj.email,
      subject: names ? `New date check: ${names} — can you play this one?` : "New date check — can you play this one?",
      html: `
        <p>Hey ${dj.display_name || "there"} — a new date check just dropped.</p>
        ${leadSummaryHtml(lead)}
        <p><a href="${link}">Open it and mark yourself available or pass →</a></p>
      `,
    });
  }
}

// Deliberately omits payout/travel — a musician's rate is decided per-event
// after they're actually booked, never at date-check time, so it must never
// appear in this email regardless of what's on the lead.
function leadSummaryForMusicianHtml(lead: Lead) {
  const d = fmtDate(lead.event_date);
  const names = [lead.client_name, lead.fiance_name].filter(Boolean).join(" + ");
  return `
    <p><strong>${d.dow ? `${d.dow}, ` : ""}${d.mon} ${d.day}${d.year ? `, ${d.year}` : ""}</strong></p>
    ${names ? `<p>${names}</p>` : ""}
    ${lead.location ? `<p>${lead.location}</p>` : ""}
  `;
}

export async function notifyMusiciansOfNewLead(lead: Lead) {
  const admin = createAdminClient();

  const upgrades = (lead.upgrades || "").toLowerCase();
  if (!upgrades) return;

  const { data: musicians } = await admin.from("users").select("id, email, display_name").eq("role", "musician");
  if (!musicians || musicians.length === 0) return;

  const { data: profiles } = await admin
    .from("dj_profiles")
    .select("user_id, instrument, notify_email")
    .in("user_id", musicians.map((m) => m.id));

  const link = `${SITE_URL}/board?lead=${lead.id}`;
  const names = [lead.client_name, lead.fiance_name].filter(Boolean).join(" + ");

  for (const musician of musicians) {
    const profile = profiles?.find((p) => p.user_id === musician.id);
    if (profile && profile.notify_email === false) continue;
    const instrument = profile?.instrument as Instrument | undefined;
    if (!instrument) continue;
    // Only notify when the lead actually mentions this musician's
    // instrument — there's no "date check" pool for musicians the way
    // there is for DJs, so an unrelated lead should never reach them.
    if (!upgrades.includes(INSTRUMENT_KEYWORD[instrument])) continue;

    await sendEmail({
      to: musician.email,
      subject: `New lead wants a ${instrument.toLowerCase()}${names ? `: ${names}` : ""}`,
      html: `
        <p>Hey ${musician.display_name || "there"} — a new lead just came in that mentions a ${instrument.toLowerCase()}.</p>
        ${leadSummaryForMusicianHtml(lead)}
        <p><a href="${link}">Open it →</a></p>
      `,
    });
  }
}
