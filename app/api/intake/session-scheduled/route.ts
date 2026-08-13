import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Fires from a Zapier automation watching Austin's Gmail (Sent folder, not
// inbox — HoneyBook sends this confirmation from austin@djausto.com to the
// client) for the subject "Austin has scheduled a session with you". There's
// no HoneyBook API to query directly, so this email is the only available
// signal that a real session got booked with a client. The body always
// reads "...scheduled a session with you in {Project Title}. Please view
// the details below:" — Project Title is HoneyBook's own project name,
// typically "{Names} {date}", which is matched by first name against
// leads still in Pipeline (status = checking, covers both the "checking"
// and derived "ready" states — has_available doesn't change the raw
// status). Only acts when exactly one lead matches; anything ambiguous or
// unmatched is a no-op rather than a guess, since a wrong match would
// silently corrupt the pipeline.
export async function POST(request: Request) {
  const secret = request.headers.get("x-webhook-secret");
  if (!secret || secret !== process.env.HONEYBOOK_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const payload = await request.json().catch(() => null);
  const emailBody: string | undefined = payload?.body;
  if (!emailBody || typeof emailBody !== "string") {
    return NextResponse.json({ error: "body is required" }, { status: 400 });
  }

  // Non-greedy up to the tracking-link bracket or the actual sentence
  // boundary — matching on a bare "." would wrongly cut the date inside
  // the title short (e.g. "9.6.26" truncated to "9"). \s+ (not a literal
  // space) after "in", and [\s\S] instead of "." for the capture, because
  // Zapier's "Body Plain" field inserts a line break with no space right
  // where the original tracking-pixel link used to be (the dotAll flag
  // would also fix this but needs an ES2018+ target).
  const titleMatch = emailBody.match(/scheduled a session with you in\s+([\s\S]+?)(?:\[|\.\s*Please view)/i);
  // Collapse in case the title itself wraps across a line break.
  const projectTitle = titleMatch?.[1]?.trim().replace(/\s+/g, " ");
  if (!projectTitle) {
    return NextResponse.json({ ok: false, reason: "couldn't find a project title in the email body" });
  }

  const admin = createAdminClient();
  const { data: candidates } = await admin.from("leads").select("*").eq("status", "checking");

  const titleLower = projectTitle.toLowerCase();
  const firstWord = (name: string | null) => (name || "").trim().split(/\s+/)[0]?.toLowerCase() || "";

  const matches = (candidates ?? []).filter((lead) => {
    const clientFirst = firstWord(lead.client_name);
    if (!clientFirst || !titleLower.includes(clientFirst)) return false;
    const fianceFirst = firstWord(lead.fiance_name);
    return !fianceFirst || titleLower.includes(fianceFirst);
  });

  if (matches.length !== 1) {
    return NextResponse.json({
      ok: false,
      reason: matches.length === 0 ? "no matching Pipeline lead found" : "multiple leads matched — ambiguous",
      projectTitle,
      candidateCount: matches.length,
    });
  }

  const lead = matches[0];
  // Same effect as the owner clicking "MEETING BOOKED →" — the existing
  // status-change trigger logs this event automatically, with a null
  // actor (shows as "Automatically" in Lead History) since there's no
  // authenticated user in this request.
  const { error } = await admin.from("leads").update({ status: "meeting" }).eq("id", lead.id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, leadId: lead.id, matchedTitle: projectTitle });
}
