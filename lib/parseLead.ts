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
- upgrades: comma-separated add-ons mentioned (photo booth / Guac Booth, CO2, cold sparks, uplighting, custom lighting, ceremony audio, etc.)
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
    return {
      name: obj.client || "",
      fiance: obj.fiance || "",
      contact: obj.contact || "",
      date: obj.date || "",
      location: obj.location || "",
      djTier: ["Headliner", "Resident", "Associate"].includes(obj.djTier) ? obj.djTier : "",
      prodTier: ["Marquee", "Modern", "Essential"].includes(obj.prodTier) ? obj.prodTier : "",
      upgrades: obj.upgrades || "",
      vision: obj.vision || "",
      travelZone: ["Local", "Extended Local", "Regional", "Central CA"].includes(obj.travelZone) ? obj.travelZone : "",
    };
  } catch {
    throw new LeadParseError("Couldn't parse that inquiry", 502);
  }
}
