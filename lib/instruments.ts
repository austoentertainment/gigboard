import type { Instrument } from "./supabase/types";

// Shared between the server-side new-lead notification and the client-side
// date-check filtering, so a musician only ever sees/gets notified about
// leads that actually mention their instrument.
export const INSTRUMENT_KEYWORD: Record<Instrument, string> = {
  Saxophone: "sax",
  Violin: "violin",
};
