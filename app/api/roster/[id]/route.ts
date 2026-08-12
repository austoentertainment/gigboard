import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

async function requireOwner() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase.from("users").select("role").eq("id", user.id).single();
  return profile?.role === "owner" ? user : null;
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const owner = await requireOwner();
  if (!owner) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const admin = createAdminClient();
  const { error } = await admin.auth.admin.deleteUser(id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const owner = await requireOwner();
  if (!owner) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const { email } = await request.json();
  if (!email || typeof email !== "string" || !email.includes("@")) {
    return NextResponse.json({ error: "A valid email is required" }, { status: 400 });
  }
  const trimmed = email.trim();

  const admin = createAdminClient();

  // Updates the actual login credential — email_confirm skips the "click
  // to confirm your new address" flow, since Austin is changing this on
  // someone else's behalf, not the account holder self-serving it.
  const { error: authError } = await admin.auth.admin.updateUserById(id, { email: trimmed, email_confirm: true });
  if (authError) {
    return NextResponse.json({ error: authError.message }, { status: 400 });
  }

  // handle_new_user only mirrors auth.users into public.users on signup
  // (insert), not on update — without this, the roster list and every
  // email lookup (notifications, leaderboard, etc.) would keep showing
  // the old address even though login already uses the new one.
  const { error: profileError } = await admin.from("users").update({ email: trimmed }).eq("id", id);
  if (profileError) {
    return NextResponse.json({ error: `Login email updated, but the roster record still shows the old one: ${profileError.message}` }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
