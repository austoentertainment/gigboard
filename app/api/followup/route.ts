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

// The only statuses a queue may start from. A lead that's already pending,
// sending or sent must not be re-queued — that's how you get two texts.
const QUEUEABLE: FollowupStatus[] = ["awaiting_approval", "failed", "skipped_stale"];

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

  // Same shape of guard as the cancel above, and as followup.py's own
  // pending -> sending claim: the status the row must currently hold is
  // part of the UPDATE, so two queues (or a queue racing a send) can't
  // both land. Zero rows back means someone else moved it first.
  const { data, error } = await admin
    .from("leads")
    .update({
      followup_status: "pending",
      followup_requested_at: now,
      followup_message: message.trim(),
      followup_error: null,
      followup_updated_at: now,
    })
    .eq("id", leadId)
    .in("followup_status", QUEUEABLE)
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
