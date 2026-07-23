import type { Database, TravelZone } from "./supabase/types";

type CompanySettings = Database["public"]["Tables"]["company_settings"]["Row"];

export function tierRate(settings: CompanySettings | null, djTier: string, prodTier: string): number {
  if (!settings) return 0;
  const djMap: Record<string, number> = { Headliner: settings.headliner_rate, Resident: settings.resident_rate, Associate: settings.associate_rate };
  const prodMap: Record<string, number> = { Marquee: settings.marquee_rate, Modern: settings.modern_rate, Essential: settings.essential_rate };
  return (djMap[djTier] || 0) + (prodMap[prodTier] || 0);
}

export function travelRate(settings: CompanySettings | null, zone: string): number {
  if (!settings) return 0;
  const zoneMap: Record<string, number> = {
    Local: settings.travel_local_rate,
    "Extended Local": settings.travel_extended_local_rate,
    Regional: settings.travel_regional_rate,
    "Central CA": settings.travel_central_ca_rate,
  };
  return zoneMap[zone] || 0;
}

const ZONE_KEYWORDS: Record<TravelZone, string[]> = {
  Local: ["orange county", "san clemente", "fullerton", "long beach"],
  "Extended Local": ["dtla", "downtown los angeles", "los angeles", " la ", "pasadena", "riverside"],
  Regional: ["desert cities", "palm springs", "san diego", "arrowhead", "big bear"],
  "Central CA": ["central coast", "mammoth", "bay area", "san francisco"],
};

export function guessTravelZone(location: string): TravelZone | null {
  const text = ` ${location.toLowerCase()} `;
  for (const [zone, keywords] of Object.entries(ZONE_KEYWORDS) as [TravelZone, string[]][]) {
    if (keywords.some((k) => text.includes(k))) return zone;
  }
  return null;
}
