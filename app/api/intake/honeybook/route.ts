import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseLeadWithClaude, LeadParseError } from "@/lib/parseLead";
import { notifyDjsOfNewLead } from "@/lib/notifications";
import { tierRate, travelRate, guessTravelZone } from "@/lib/rates";
import type { DjTier, ProdTier, TravelZone } from "@/lib/supabase/types";

// Zapier's "New Inquiry" trigger field names aren't confirmed yet, so this
// accepts whatever shape shows up and folds every present field into one
// text blob for Claude to parse, rather than assuming exact field names.
export async function POST(request: Request) {
  const secret = request.headers.get("x-webhook-secret");
  if (!secret || secret !== process.env.HONEYBOOK_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }

  const honeybookRef =
    body.id || body.inquiryId || body.inquiry_id ||
    createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 32);

  const admin = createAdminClient();

  const { data: existing } = await admin
    .from("leads")
    .select("id")
    .eq("honeybook_ref", String(honeybookRef))
    .maybeSingle();

  if (existing) {
    return NextResponse.json({ ok: true, deduped: true, leadId: existing.id });
  }

  // Don't silently drop non-string fields (nested objects/arrays) — a client
  // name buried in a structured field has caused it to vanish from the blob
  // before, leaving only a partner/fiance name for Claude to see.
  const raw = Object.entries(body)
    .map(([k, v]) => {
      if (v == null) return null;
      if (typeof v === "string") return v.trim() ? `${k}: ${v}` : null;
      if (typeof v === "object") return `${k}: ${JSON.stringify(v)}`;
      return `${k}: ${v}`;
    })
    .filter((line): line is string => Boolean(line))
    .join("\n");

  console.log("[honeybook webhook] raw payload:", JSON.stringify(body));

  let parsed;
  try {
    parsed = await parseLeadWithClaude(raw);
  } catch (err) {
    const status = err instanceof LeadParseError ? err.status : 502;
    const message = err instanceof LeadParseError ? err.message : "Couldn't parse inquiry";
    return NextResponse.json({ error: message }, { status });
  }

  const { data: settings } = await admin.from("company_settings").select("*").eq("id", 1).single();
  const zone = (parsed.travelZone || guessTravelZone(parsed.location || "") || "") as TravelZone | "";
  const payout = parsed.djTier && parsed.prodTier ? tierRate(settings, parsed.djTier, parsed.prodTier) : 0;
  const travel = zone ? travelRate(settings, zone) : 0;

  const { data: lead, error } = await admin
    .from("leads")
    .insert({
      client_name: parsed.name,
      fiance_name: parsed.fiance,
      contact: parsed.contact,
      event_date: parsed.date || null,
      location: parsed.location,
      dj_tier: (parsed.djTier || null) as DjTier | null,
      prod_tier: (parsed.prodTier || null) as ProdTier | null,
      upgrades: parsed.upgrades,
      client_vision: parsed.vision,
      source: "honeybook",
      status: "checking",
      needs_review: true,
      honeybook_ref: String(honeybookRef),
      payout: payout || null,
      travel_zone: zone || null,
      travel_rate: travel || null,
    })
    .select("*")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await notifyDjsOfNewLead(lead);

  return NextResponse.json({ ok: true, leadId: lead.id });
}
