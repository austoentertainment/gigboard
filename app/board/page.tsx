import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import BoardApp from "./BoardApp";

export default async function BoardPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("users")
    .select("id, display_name, role")
    .eq("id", user.id)
    .single();

  if (!profile) redirect("/login");

  return (
    <BoardApp
      userId={profile.id}
      displayName={profile.display_name || user.email || "You"}
      role={profile.role}
    />
  );
}
