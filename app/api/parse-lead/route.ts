import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

async function requireOwner() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase.from("users").select("role").eq("id", user.id).single();
  return profile?.role === "owner" ? user : null;
}

const EXTRACTION_PROMPT = (raw: string) => `Extract lead info from this HoneyBook inquiry (email or copied text) for a wedding/event DJ company. Respond ONLY with a JSON object, no markdown fences, no preamble, with these keys (use "" when unknown):
- client: client/couple name
- contact: email or phone if present
- date: event date as YYYY-MM-DD
- location: venue and/or city as one line (e.g. "The Colony House, Anaheim")
- djTier: one of Headliner, Resident, Associate — only if the inquiry names a DJ tier or package that clearly maps to one
- prodTier: one of Marquee, Modern, Essential — only if the inquiry names a production tier/package that clearly maps to one
- upgrades: comma-separated add-ons mentioned (photo booth / Guac Booth, CO2, cold sparks, uplighting, custom lighting, ceremony audio, etc.)
- vision: 1-3 sentences capturing what the client says they want the event to feel like, in their words where possible

INQUIRY:
${raw}`;

export async function POST(request: Request) {
  const owner = await requireOwner();
  if (!owner) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY isn't set yet — add it in Vercel env vars, or use Add Manually for now." },
      { status: 503 }
    );
  }

  const { raw } = await request.json();
  if (!raw || typeof raw !== "string" || !raw.trim()) {
    return NextResponse.json({ error: "raw inquiry text is required" }, { status: 400 });
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 1000,
      messages: [{ role: "user", content: EXTRACTION_PROMPT(raw) }],
    }),
  });

  if (!response.ok) {
    return NextResponse.json({ error: "Anthropic API request failed" }, { status: 502 });
  }

  const data = await response.json();
  const text = (data.content || []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("\n");
  const clean = text.replace(/```json|```/g, "").trim();

  try {
    const obj = JSON.parse(clean);
    return NextResponse.json({
      name: obj.client || "",
      contact: obj.contact || "",
      date: obj.date || "",
      location: obj.location || "",
      djTier: ["Headliner", "Resident", "Associate"].includes(obj.djTier) ? obj.djTier : "",
      prodTier: ["Marquee", "Modern", "Essential"].includes(obj.prodTier) ? obj.prodTier : "",
      upgrades: obj.upgrades || "",
      vision: obj.vision || "",
    });
  } catch {
    return NextResponse.json({ error: "Couldn't parse that — try Add Manually" }, { status: 502 });
  }
}
