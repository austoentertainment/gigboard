import { createAdminClient } from "./supabase/admin";
import { sendEmail } from "./email";
import { fmtDate } from "@/app/board/ui";
import type { Database, DjTier } from "./supabase/types";

type Lead = Database["public"]["Tables"]["leads"]["Row"];

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://board.austoentertainment.com";

function leadSummaryHtml(lead: Lead) {
  const d = fmtDate(lead.event_date);
  const tier = [lead.dj_tier, lead.prod_tier].filter(Boolean).join(" + ");
  const total = (lead.payout || 0) + (lead.travel_rate || 0);
  return `
    <p><strong>${d.dow ? `${d.dow}, ` : ""}${d.mon} ${d.day}${d.year ? `, ${d.year}` : ""}</strong></p>
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

    await sendEmail({
      to: dj.email,
      subject: "New date check — can you play this one?",
      html: `
        <p>Hey ${dj.display_name || "there"} — a new date check just dropped.</p>
        ${leadSummaryHtml(lead)}
        <p><a href="${link}">Open it and mark yourself available or pass →</a></p>
      `,
    });
  }
}

export async function notifyOwnersOfAvailability(lead: Lead, dj: { display_name: string | null; email: string }) {
  const admin = createAdminClient();
  const { data: owners } = await admin.from("users").select("email").eq("role", "owner");
  if (!owners || owners.length === 0) return;

  const link = `${SITE_URL}/board?lead=${lead.id}`;
  const d = fmtDate(lead.event_date);
  const djName = dj.display_name || dj.email;

  for (const owner of owners) {
    await sendEmail({
      to: owner.email,
      subject: `🟢 ${djName} is available for ${d.mon} ${d.day} — contact the lead`,
      html: `
        <p><strong>${djName}</strong> just marked themselves available.</p>
        ${leadSummaryHtml(lead)}
        <p><a href="${link}">Open the lead →</a></p>
      `,
    });
  }
}
