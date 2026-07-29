import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Instrument } from "@/lib/supabase/types";

async function requireOwner() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase.from("users").select("role").eq("id", user.id).single();
  return profile?.role === "owner" ? user : null;
}

export async function POST(request: Request) {
  const owner = await requireOwner();
  if (!owner) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { email, displayName, password, role, instrument } = await request.json();
  if (!email || typeof email !== "string") {
    return NextResponse.json({ error: "email is required" }, { status: 400 });
  }
  if (!password || typeof password !== "string" || password.length < 8) {
    return NextResponse.json({ error: "password must be at least 8 characters" }, { status: 400 });
  }
  const isMusician = role === "musician";
  if (isMusician && !["Saxophone", "Violin"].includes(instrument)) {
    return NextResponse.json({ error: "instrument is required for a musician" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: displayName || null },
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  // The signup trigger always creates the account as 'dj' — there's no
  // self-signup path a musician could pick their own role through, so
  // promote it here instead.
  if (isMusician) {
    const { error: roleError } = await admin.from("users").update({ role: "musician" }).eq("id", data.user.id);
    if (roleError) {
      return NextResponse.json({ error: `Account created, but couldn't set the musician role: ${roleError.message}` }, { status: 500 });
    }
  }

  // New roster members start opted out of notification emails — the owner
  // turns this on per-person from Roster once the board is actually live
  // for them, so roster/testing setup never emails someone before they're
  // ready.
  //
  // Musicians aren't gated by DJ tier anywhere today (they're matched to a
  // lead by instrument, not tier), but they're qualified for every tier by
  // default so nothing blocks them if a tier check ever does apply to them.
  const { error: profileError } = await admin.from("dj_profiles").update({
    notify_email: false,
    ...(isMusician ? { instrument: instrument as Instrument, dj_tier_visibility: ["Headliner", "Resident", "Associate"] } : {}),
  }).eq("user_id", data.user.id);
  if (profileError) {
    return NextResponse.json({ error: `Account created, but couldn't finish setting it up: ${profileError.message}` }, { status: 500 });
  }

  return NextResponse.json({ userId: data.user.id });
}
