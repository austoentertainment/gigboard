import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://board.austoentertainment.com";

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { data: profile } = await supabase.from("users").select("role").eq("id", user.id).single();
  if (profile?.role !== "owner") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { leadId } = await request.json();
  if (!leadId) return NextResponse.json({ error: "leadId is required" }, { status: 400 });

  const admin = createAdminClient();
  const { data: lead } = await admin.from("leads").select("*").eq("id", leadId).single();
  if (!lead) return NextResponse.json({ error: "Lead not found" }, { status: 404 });

  // Looked up by role rather than hardcoded, same as every other
  // notification in this app — currently resolves to austin@djausto.com,
  // the one owner account.
  const { data: owners } = await admin.from("users").select("email").eq("role", "owner");
  if (!owners || owners.length === 0) return NextResponse.json({ ok: true, skipped: true });

  const title = [lead.client_name, lead.fiance_name].filter(Boolean).join(" + ") || "Unnamed lead";
  const link = `${SITE_URL}/board?lead=${lead.id}`;

  for (const owner of owners) {
    await sendEmail({
      to: owner.email,
      subject: `Meeting booked: ${title}`,
      html: `
        <p>${title}</p>
        <p><a href="${link}">Open it on the board →</a></p>
      `,
    });
  }

  return NextResponse.json({ ok: true });
}
