import { INSTRUMENT_KEYWORD } from "./instruments";
import type { Instrument } from "./supabase/types";

export type ParsedLead = {
  name: string;
  fiance: string;
  contact: string;
  date: string;
  location: string;
  djTier: string;
  prodTier: string;
  upgrades: string;
  vision: string;
  travelZone: string;
};

const EXTRACTION_PROMPT = (raw: string) => `Extract lead info from this HoneyBook inquiry (email or copied text) for a wedding/event DJ company based in Orange County, California. Respond ONLY with a JSON object, no markdown fences, no preamble, with these keys (use "" when unknown):
- client: the primary contact / the person who submitted this inquiry (e.g. "Jess & Marco" → "Jess"; if a field is literally labeled "Your Name" or "Contact Name", that person is always the client). Never leave this blank if ANY person's name appears anywhere in the inquiry — even if the only name present is labeled "partner", "fiancé", "fiancée", or similar, put that name here as the client rather than in fiance.
- fiance: the client's partner, ONLY if the inquiry clearly names two separate people (e.g. "Jess & Marco" → "Marco", or explicit separate "Your Name" / "Partner's Name" fields both filled in). Else "".
- contact: email or phone if present
- date: event date as YYYY-MM-DD
- location: venue and/or city as one line (e.g. "The Colony House, Anaheim")
- djTier: one of Headliner, Resident, Associate — only if the inquiry names a DJ tier or package that clearly maps to one
- prodTier: one of Marquee, Modern, Essential — only if the inquiry names a production tier/package that clearly maps to one
- upgrades: comma-separated add-ons mentioned (photo booth / Guac Booth, CO2, cold sparks, uplighting, custom lighting, ceremony audio, etc.) — if a live saxophonist or violinist is wanted for any part of the event, include the literal word "Saxophone" or "Violin" here so it can be matched later. This includes ANY mention at all, not just a clearly worded request — a raw form field/checkbox like "Instruments: Violin" or "Add-ons: Sax" counts just as much as a sentence asking for one
- vision: 1-3 sentences capturing what the client says they want the event to feel like, in their words where possible
- travelZone: one of Local, Extended Local, Regional, Central CA, based on the event location's distance from Orange County — use your knowledge of California geography to classify it, even if the exact city isn't in these examples:
  - Local: Greater Orange County, San Clemente, Fullerton, Long Beach
  - Extended Local: DTLA, Pasadena, Riverside, and similar Greater LA / Inland Empire cities
  - Regional: Desert Cities (Palm Springs etc.), San Diego, Arrowhead, Big Bear
  - Central CA: Central Coast, Mammoth, Bay Area, and similarly far Northern/Central California
  Use "" only if the location is missing or genuinely not a California location.

INQUIRY:
${raw}`;

export class LeadParseError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function parseLeadWithClaude(raw: string): Promise<ParsedLead> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new LeadParseError("ANTHROPIC_API_KEY isn't set yet.", 503);
  }
  if (!raw || !raw.trim()) {
    throw new LeadParseError("raw inquiry text is required", 400);
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
    throw new LeadParseError("Anthropic API request failed", 502);
  }

  const data = await response.json();
  const text = (data.content || []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("\n");
  const clean = text.replace(/```json|```/g, "").trim();

  try {
    const obj = JSON.parse(clean);
    let name = obj.client || "";
    let fiance = obj.fiance || "";
    // Belt-and-suspenders: whichever name is the only one present always
    // ends up as the client, regardless of which field the model put it
    // in — this is the field every display and email actually shows first,
    // so a single name must never end up stranded in "fiance" alone.
    if (!name && fiance) { name = fiance; fiance = ""; }
    let upgrades = obj.upgrades || "";
    const vision = obj.vision || "";
    // Deterministic backstop, independent of how well the prompt above
    // works: instrument matching downstream (see lib/instruments.ts) keys
    // off the literal word "Violin"/"Saxophone" appearing in upgrades or
    // vision. If that word shows up anywhere in the raw inquiry at all —
    // including a raw form field the model didn't recognize as an
    // add-on request — force it into upgrades so a musician's Date Check
    // can never silently miss it due to an extraction miss.
    const rawLower = raw.toLowerCase();
    const captured = `${upgrades} ${vision}`.toLowerCase();
    for (const instrument of Object.keys(INSTRUMENT_KEYWORD) as Instrument[]) {
      const keyword = INSTRUMENT_KEYWORD[instrument];
      if (rawLower.includes(keyword) && !captured.includes(keyword)) {
        upgrades = upgrades ? `${upgrades}, ${instrument}` : instrument;
      }
    }
    return {
      name,
      fiance,
      contact: obj.contact || "",
      date: obj.date || "",
      location: obj.location || "",
      djTier: ["Headliner", "Resident", "Associate"].includes(obj.djTier) ? obj.djTier : "",
      prodTier: ["Marquee", "Modern", "Essential"].includes(obj.prodTier) ? obj.prodTier : "",
      upgrades,
      vision,
      travelZone: ["Local", "Extended Local", "Regional", "Central CA"].includes(obj.travelZone) ? obj.travelZone : "",
    };
  } catch {
    throw new LeadParseError("Couldn't parse that inquiry", 502);
  }
}
