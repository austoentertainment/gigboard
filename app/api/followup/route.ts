import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { FollowupStatus } from "@/lib/supabase/types";

// Queueing a text is owner-only — DJs never get near this, which is why
// the check is here rather than relying on the UI hiding the button.
async function requireOwner() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase.from("users").select("role").eq("id", user.id).single();
  return profile?.role === "owner" ? user : null;
}

// A lead that's pending or sending must never be re-queued — that's how
// you get two texts out. 'sent' IS allowed, but only to advance to the
// second follow-up, which the round check below enforces.
const QUEUEABLE: FollowupStatus[] = [
  "awaiting_approval", "failed", "skipped_stale", "skipped_no_phone", "skipped_no_consent", "sent",
];
const MAX_ROUNDS = 2;

export async function POST(request: Request) {
  const owner = await requireOwner();
  if (!owner) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { leadId, message, action } = await request.json().catch(() => ({}));
  if (!leadId) return NextResponse.json({ error: "leadId is required" }, { status: 400 });

  const admin = createAdminClient();
  const now = new Date().toISOString();

  if (action === "cancel") {
    // Conditional on 'pending' so a cancel racing the Mac's claim loses
    // cleanly: once followup.py flips the row to 'sending', this matches
    // nothing and the text goes out rather than being half-cancelled.
    // followup_message is deliberately kept so reopening the draft still
    // has the edits.
    const { data, error } = await admin
      .from("leads")
      .update({ followup_status: "awaiting_approval", followup_requested_at: null, followup_updated_at: now })
      .eq("id", leadId)
      .eq("followup_status", "pending")
      .select("id");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data || data.length === 0) {
      return NextResponse.json({ error: "That text is already sending — too late to cancel." }, { status: 409 });
    }
    return NextResponse.json({ ok: true });
  }

  if (typeof message !== "string" || !message.trim()) {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }

  // Read the current state to work out which round this send is, then
  // write back guarded on that exact status — a compare-and-swap. If the
  // Mac (or another tab) moved the row in between, the status no longer
  // matches and the update touches nothing.
  const { data: current } = await admin
    .from("leads")
    .select("followup_status, followup_round")
    .eq("id", leadId)
    .single();
  if (!current) return NextResponse.json({ error: "Lead not found" }, { status: 404 });

  const status = current.followup_status as FollowupStatus;
  const round = current.followup_round ?? 0;
  if (!QUEUEABLE.includes(status)) {
    return NextResponse.json({ error: "A text is already on its way for this lead." }, { status: 409 });
  }
  // Sent advances to the next round; anything else is a retry of the
  // round that didn't make it, so it stays put.
  const nextRound = status === "sent" ? round + 1 : (round || 1);
  if (nextRound > MAX_ROUNDS) {
    return NextResponse.json({ error: "Both follow-ups have already gone out to this lead." }, { status: 409 });
  }

  const { data, error } = await admin
    .from("leads")
    .update({
      followup_status: "pending",
      followup_requested_at: now,
      followup_message: message.trim(),
      followup_error: null,
      followup_round: nextRound,
      followup_updated_at: now,
    })
    .eq("id", leadId)
    .eq("followup_status", status)
    .select("id");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data || data.length === 0) {
    return NextResponse.json(
      { error: "This lead's text status changed — refresh and try again." },
      { status: 409 },
    );
  }

  return NextResponse.json({ ok: true });
}
