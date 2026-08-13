import type { Instrument } from "./supabase/types";

// Shared between the server-side new-lead notification and the client-side
// date-check filtering, so a musician only ever sees/gets notified about
// leads that actually mention their instrument.
export const INSTRUMENT_KEYWORD: Record<Instrument, string> = {
  Saxophone: "sax",
  Violin: "violin",
};

// Checks both the structured "Upgrades" field and the client's free-text
// vision — a musician request often only shows up in the vision text (e.g.
// HoneyBook's AI-parsed intake fills client_vision from free text but
// doesn't always also populate upgrades), so upgrades-only matching
// silently missed real requests.
export function instrumentMentioned(
  lead: { upgrades: string | null; client_vision: string | null },
  instrument: Instrument
): boolean {
  const text = `${lead.upgrades || ""} ${lead.client_vision || ""}`.toLowerCase();
  return text.includes(INSTRUMENT_KEYWORD[instrument]);
}

export function anyInstrumentMentioned(lead: { upgrades: string | null; client_vision: string | null }): boolean {
  return (Object.keys(INSTRUMENT_KEYWORD) as Instrument[]).some((i) => instrumentMentioned(lead, i));
}
