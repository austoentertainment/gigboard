import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import BoardApp from "./BoardApp";

export default async function BoardPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return (
      <ErrorScreen message="Your session isn't valid — go back to the login page and sign in again." />
    );
  }

  let { data: profile } = await supabase
    .from("users")
    .select("id, display_name, role")
    .eq("id", user.id)
    .single();

  // The public.users row is normally created by a trigger on signup. If it's
  // missing (e.g. an account created before that trigger existed), heal it
  // here instead of leaving the user in a redirect loop between /login and
  // /board.
  if (!profile) {
    const admin = createAdminClient();
    const role = user.email === "austin@djausto.com" ? "owner" : "dj";
    await admin.from("users").insert({ id: user.id, email: user.email!, role });
    await admin.from("dj_profiles").insert({ user_id: user.id });
    const { data: healed } = await supabase
      .from("users")
      .select("id, display_name, role")
      .eq("id", user.id)
      .single();
    profile = healed;
  }

  if (!profile) {
    return (
      <ErrorScreen message="Couldn't load your account profile. Try refreshing — if this keeps happening, something's wrong server-side." />
    );
  }

  return (
    <BoardApp
      userId={profile.id}
      displayName={profile.display_name || user.email || "You"}
      role={profile.role}
    />
  );
}

function ErrorScreen({ message }: { message: string }) {
  return (
    <div style={{ background: "#14151F", minHeight: "100vh", color: "#EEEDE6", display: "grid", placeItems: "center", fontFamily: "system-ui, sans-serif", padding: 16 }}>
      <div style={{ maxWidth: 360, textAlign: "center", fontSize: 14, color: "#9AA0B5" }}>{message}</div>
    </div>
  );
}
