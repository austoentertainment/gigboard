import { createAdminClient } from "./supabase/admin";
import { sendEmail } from "./email";
import { fmtDate } from "@/app/board/ui";
import { instrumentMentioned, anyInstrumentMentioned } from "./instruments";
import type { Database, DjTier, Instrument } from "./supabase/types";

type Lead = Database["public"]["Tables"]["leads"]["Row"];

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://board.austoentertainment.com";

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function leadEmailSubject(lead: Lead) {
  const d = fmtDate(lead.event_date);
  const dateStr = `${d.mon} ${d.day}${d.year ? `, ${d.year}` : ""}`;
  return `New Lead Opportunity ${dateStr} 💸`;
}

// Same body for both DJs and musicians — Upgrades and Vision are what
// someone actually needs to decide whether a lead's a fit, and neither
// role saw them in the email before (only date/location, or date/
// location/tier/payout for DJs).
function leadEmailBodyHtml(lead: Lead) {
  const d = fmtDate(lead.event_date);
  const dateStr = `${d.dow ? `${d.dow}, ` : ""}${d.mon} ${d.day}${d.year ? `, ${d.year}` : ""}`;
  const names = escapeHtml([lead.client_name, lead.fiance_name].filter(Boolean).join(" + ") || "Unnamed lead");
  const location = escapeHtml(lead.location || "TBD");
  const upgrades = lead.upgrades ? escapeHtml(lead.upgrades).replace(/\n/g, "<br>") : "None listed";
  const vision = lead.client_vision ? escapeHtml(lead.client_vision).replace(/\n/g, "<br>") : "Not provided";
  return `
    <p><strong>Name of the Couple:</strong> ${names}</p>
    <p><strong>Event Date:</strong> ${dateStr}</p>
    <p><strong>Venue/Location:</strong> ${location}</p>
    <p><strong>Upgrades:</strong> ${upgrades}</p>
    <p><strong>Vision:</strong> ${vision}</p>
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
    // 'Any' is the one deliberate exception: it means every DJ gets
    // notified regardless of their own tier qualifications.
    const visibility = (profile?.dj_tier_visibility ?? []) as DjTier[];
    const tierMatches = !lead.dj_tier || lead.dj_tier === "Any" || visibility.includes(lead.dj_tier as DjTier);
    if (!tierMatches) continue;

    await sendEmail({
      to: dj.email,
      subject: leadEmailSubject(lead),
      html: `
        <p>Hey ${dj.display_name || "there"} — a new date check just dropped.</p>
        ${leadEmailBodyHtml(lead)}
        <p><a href="${link}">Open it and mark yourself available or pass →</a></p>
      `,
    });
  }
}

function leadSummaryHtml(lead: Lead) {
  const d = fmtDate(lead.event_date);
  const dateStr = `${d.dow ? `${d.dow}, ` : ""}${d.mon} ${d.day}${d.year ? `, ${d.year}` : ""}`;
  const names = escapeHtml([lead.client_name, lead.fiance_name].filter(Boolean).join(" + ") || "Unnamed lead");
  const location = escapeHtml(lead.location || "TBD");
  return `
    <p><strong>Couple:</strong> ${names}</p>
    <p><strong>Event Date:</strong> ${dateStr}</p>
    <p><strong>Venue/Location:</strong> ${location}</p>
  `;
}

// The 14-day hold window — same constant the board's own "HOLD DATE" vs
// "FOLLOW UP" tag logic uses (see leadStatus in app/board/BoardApp.tsx),
// so an email and the live board tag never disagree about when a hold
// ends.
const HOLD_DAYS = 14;
function holdUntilDate(meetingDate: string) {
  return new Date(new Date(meetingDate + "T12:00:00").getTime() + HOLD_DAYS * 24 * 60 * 60 * 1000);
}

// Musicians who said "available" on this lead — once the owner's booked
// a first meeting, everyone still in the running has already answered
// yes, so "available responders" (not "instrument match") is the right
// audience for both the hold and release emails.
export async function musiciansAvailableOn(admin: ReturnType<typeof createAdminClient>, leadId: string) {
  const { data: avail } = await admin
    .from("availability_responses")
    .select("dj_user_id")
    .eq("lead_id", leadId)
    .eq("response", "available");
  const responderIds = (avail ?? []).map((a) => a.dj_user_id);
  if (responderIds.length === 0) return [];

  const { data: musicians } = await admin
    .from("users")
    .select("id, email, display_name")
    .eq("role", "musician")
    .in("id", responderIds);
  if (!musicians || musicians.length === 0) return [];

  const { data: profiles } = await admin
    .from("dj_profiles")
    .select("user_id, notify_email")
    .in("user_id", musicians.map((m) => m.id));
  return musicians.filter((m) => profiles?.find((p) => p.user_id === m.id)?.notify_email !== false);
}

async function sendHoldEmail(lead: Lead, musician: { email: string; display_name: string | null }) {
  if (!lead.musician_meeting_date) return;
  const d = fmtDate(lead.event_date);
  const dateStr = `${d.mon} ${d.day}${d.year ? `, ${d.year}` : ""}`;
  const holdUntilStr = holdUntilDate(lead.musician_meeting_date).toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
  });
  const link = `${SITE_URL}/board?lead=${lead.id}`;

  await sendEmail({
    to: musician.email,
    subject: `Hold the date — ${dateStr}`,
    html: `
      <p>Hey ${musician.display_name || "there"} — a meeting has been booked with this potential booking! Please hold the date for 2 weeks.</p>
      ${leadSummaryHtml(lead)}
      <p><strong>Hold Until:</strong> ${holdUntilStr}</p>
      <p><a href="${link}">View on the board →</a></p>
    `,
  });
}

// Fires the moment the owner books a first meeting and the lead moves
// from a musician's Date Checks into Pending — see musicianMeetingBooked
// in app/board/BoardApp.tsx, which calls /api/notify/musician-hold right
// after the DB update succeeds. Notifies every musician who's currently
// available on the lead.
export async function notifyMusiciansOfHold(lead: Lead) {
  const admin = createAdminClient();
  const musicians = await musiciansAvailableOn(admin, lead.id);
  for (const musician of musicians) await sendHoldEmail(lead, musician);
}

// Single-recipient counterpart used by the "ADD TO HOLD" manual shortcut
// (see addMusicianToHold in app/board/BoardApp.tsx) — only the musician
// just added should hear about it, not everyone already on hold for this
// lead, so this skips musiciansAvailableOn's broad lookup and just checks
// that one musician's own notify_email preference.
export async function notifyMusicianOfHold(lead: Lead, musicianId: string) {
  const admin = createAdminClient();
  const { data: musician } = await admin.from("users").select("email, display_name").eq("id", musicianId).single();
  if (!musician) return;
  const { data: profile } = await admin.from("dj_profiles").select("notify_email").eq("user_id", musicianId).maybeSingle();
  if (profile?.notify_email === false) return;
  await sendHoldEmail(lead, musician);
}

// Cron-only counterpart to notifyMusiciansOfHold — see the daily sweep in
// app/api/cron/reminders/route.ts, which finds leads whose 14-day hold
// just expired and calls this once per still-available musician on it.
export async function notifyMusicianOfRelease(lead: Lead, musician: { email: string; display_name: string | null }) {
  const d = fmtDate(lead.event_date);
  const dateStr = `${d.mon} ${d.day}${d.year ? `, ${d.year}` : ""}`;
  const link = `${SITE_URL}/board?lead=${lead.id}`;

  await sendEmail({
    to: musician.email,
    subject: `You're free to release this date — ${dateStr}`,
    html: `
      <p>Hey ${musician.display_name || "there"} — the 2-week hold on this date has passed. You're free to release it and book other events.</p>
      ${leadSummaryHtml(lead)}
      <p><a href="${link}">View on the board →</a></p>
    `,
  });
}

export async function notifyMusiciansOfNewLead(lead: Lead) {
  const admin = createAdminClient();

  if (!anyInstrumentMentioned(lead)) return;

  const { data: musicians } = await admin.from("users").select("id, email, display_name").eq("role", "musician");
  if (!musicians || musicians.length === 0) return;

  const { data: profiles } = await admin
    .from("dj_profiles")
    .select("user_id, instrument, notify_email")
    .in("user_id", musicians.map((m) => m.id));

  const link = `${SITE_URL}/board?lead=${lead.id}`;

  for (const musician of musicians) {
    const profile = profiles?.find((p) => p.user_id === musician.id);
    if (profile && profile.notify_email === false) continue;
    const instrument = profile?.instrument as Instrument | undefined;
    if (!instrument) continue;
    // Only notify when the lead actually mentions this musician's
    // instrument — there's no "date check" pool for musicians the way
    // there is for DJs, so an unrelated lead should never reach them.
    if (!instrumentMentioned(lead, instrument)) continue;

    await sendEmail({
      to: musician.email,
      subject: leadEmailSubject(lead),
      html: `
        <p>Hey ${musician.display_name || "there"} — a new lead just came in that mentions a ${instrument.toLowerCase()}.</p>
        ${leadEmailBodyHtml(lead)}
        <p><a href="${link}">Open it →</a></p>
      `,
    });
  }
}
