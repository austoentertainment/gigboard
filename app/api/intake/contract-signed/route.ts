import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { notifyOwnerOfSyncMiss, notifyOwnerOfUnassignedBooking } from "@/lib/notifications";

// Fires from a Zapier automation watching Austin's Gmail INBOX (unlike the
// session-scheduled hook, which watches Sent) for HoneyBook's "Contract
// signed" mail from mailman@honeybook.com. A signed contract is the real
// moment a DJ gig is booked, so this is the automated equivalent of
// hitting MARK BOOKED.
//
// The subject carries the HoneyBook project title verbatim —
//   "Contract signed: Haley Mykytka + Noah Lowy 8.7.27"
// — which is far more reliable than digging it out of the body, so that's
// the primary parse. The body line ("{title} : {proposal name}") is only a
// fallback for when Zapier hands over a body but no subject.
//
// Booking is heavier than scheduling a meeting: it tells a DJ the gig is
// theirs and starts the payment flow. So the matching stays as strict as
// the meeting sync — exactly one match or it refuses — and it only ever
// looks at leads that aren't booked yet.
export async function POST(request: Request) {
  const secret = request.headers.get("x-webhook-secret");
  if (!secret || secret !== process.env.HONEYBOOK_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const payload = await request.json().catch(() => null);
  const subject: string | undefined = payload?.subject;
  const body: string | undefined = payload?.body;
  if (!subject && !body) {
    return NextResponse.json({ error: "subject or body is required" }, { status: 400 });
  }

  const fromSubject = subject?.match(/contract signed:\s*([\s\S]+?)\s*$/i)?.[1];
  // "Haley Mykytka + Noah Lowy 8.7.27 : 2026 DJ Proposal - DJ EBO" — the
  // title is everything before the colon on the line after the "signed
  // the contract on ..." sentence.
  const fromBody = body?.match(/signed the contract on[^\n]*\n+\s*([^\n:]+?)\s*:/i)?.[1];
  const projectTitle = (fromSubject || fromBody)?.trim().replace(/\s+/g, " ");
  if (!projectTitle) {
    const reason = "couldn't find a project title in the contract-signed email";
    await notifyOwnerOfSyncMiss(reason, null);
    return NextResponse.json({ ok: false, reason });
  }

  const admin = createAdminClient();
  const firstWord = (name: string | null) => (name || "").trim().split(/\s+/)[0] || "";
  // Whole-word rather than substring: a lead named "Hal" would otherwise
  // match a "Haley ..." project title. Worth the extra strictness here
  // because a false positive books the wrong gig.
  const titleHasName = (name: string) => {
    if (!name) return false;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, "i").test(projectTitle);
  };
  // Both names have to appear when the lead has two — "Haley" alone is a
  // far weaker signal than "Haley" and "Noah" together.
  const titleMatches = (lead: { client_name: string | null; fiance_name: string | null }) => {
    const clientFirst = firstWord(lead.client_name);
    if (!titleHasName(clientFirst)) return false;
    const fianceFirst = firstWord(lead.fiance_name);
    return !fianceFirst || titleHasName(fianceFirst);
  };

  const { data: candidates } = await admin.from("leads").select("*").in("status", ["checking", "meeting"]);
  const matches = (candidates ?? []).filter(titleMatches);

  if (matches.length !== 1) {
    // HoneyBook re-sending the same mail (or a Zap replay) would otherwise
    // read as "no match" and raise a false alarm, since the lead is booked
    // by then and no longer in the candidate pool. Check for that first.
    if (matches.length === 0) {
      const { data: settled } = await admin.from("leads").select("id, client_name, fiance_name").in("status", ["booked", "played"]);
      if ((settled ?? []).some(titleMatches)) {
        return NextResponse.json({ ok: true, alreadyBooked: true, projectTitle });
      }
    }
    const reason = matches.length === 0
      ? "no unbooked lead matched that project title"
      : `${matches.length} leads matched that project title, so it was too ambiguous to pick one`;
    await notifyOwnerOfSyncMiss(reason, projectTitle);
    return NextResponse.json({ ok: false, reason, projectTitle, candidateCount: matches.length });
  }

  const lead = matches[0];

  // No assigned DJ means there's nobody for "booked" to belong to, and the
  // email can't say who it should be — so this stops and asks rather than
  // booking a gig into a vacuum.
  if (!lead.assigned_dj_id) {
    await notifyOwnerOfUnassignedBooking(lead, projectTitle);
    return NextResponse.json({ ok: false, reason: "no DJ assigned to that lead", leadId: lead.id, projectTitle });
  }

  // Same effect as the owner clicking MARK BOOKED — the existing
  // status-change trigger logs it, which is what surfaces "Booked" in the
  // assigned DJ's Activity feed.
  const { error } = await admin.from("leads").update({ status: "booked" }).eq("id", lead.id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, leadId: lead.id, projectTitle });
}
