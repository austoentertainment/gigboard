import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { MusicianStage, MusicianService, Instrument, DjTier } from "@/lib/supabase/types";

// One-time creation of the 9 leads from the musician sheet that had no
// match in the Board at all (confirmed missing, not just a name-matching
// miss) — hand-transcribed from the sheet and confirmed with Austin.
// Same dry-run-by-default/?commit=true pattern as the sheet importer.
type NewLeadSpec = {
  clientName: string;
  fianceName: string;
  eventDate: string;
  location: string;
  djTier: DjTier | null;
  instruments: Instrument[];
  clientVision: string;
  musicianStage: MusicianStage;
  meetingDate: string | null;
  availability: { musician: "brian" | "rebecca"; response: "available" | "pass" }[];
  bookings: { musician: "brian" | "rebecca"; services: MusicianService[]; payout: number | null }[];
};

const NEW_LEADS: NewLeadSpec[] = [
  {
    clientName: "James Anderson", fianceName: "Rebecca Brull", eventDate: "2027-07-24", location: "Agape 1928",
    djTier: null, instruments: ["Violin"],
    clientVision: "We're working with Koral and got recommended your name! We're going for an elegant, classy event to start but an electric indoor dance floor. We're 31 and 27 and our friends are all around that age so we expect high energy from them. We love a good mix of wedding classics but also new music and varying songs (Latin, hip hop, house) which it seemed like you were great at mixing. Excited to hear more about your style and energy!",
    musicianStage: "pending_booking", meetingDate: "2026-08-12",
    availability: [{ musician: "rebecca", response: "available" }],
    bookings: [],
  },
  {
    clientName: "Catherine Holden", fianceName: "Brandon Ririe", eventDate: "2027-04-10", location: "41150 Via Europa, Temecula, CA",
    djTier: "Headliner", instruments: ["Violin"],
    clientVision: "We want our wedding to feel like an unforgettable party while still being elegant and classy. Music is one of the biggest priorities for us. We love EDM, pop, hip-hop, and dance music, and we'd prefer a modern, high-energy playlist over a traditional wedding playlist. We'd rather keep the dance floor packed than play songs just because they're wedding staples. We want guests of all ages to have fun, but our goal is to create an atmosphere that especially resonates with our younger crowd and feels authentic to us.",
    musicianStage: "pending_booking", meetingDate: "2026-08-12",
    availability: [{ musician: "rebecca", response: "available" }],
    bookings: [],
  },
  {
    clientName: "Bailey Clark", fianceName: "Ryan McNew", eventDate: "2027-06-05", location: "1425 N Twin Oaks Valley Rd San Marcos, CA 92069 United States",
    djTier: "Headliner", instruments: ["Saxophone"],
    clientVision: "I think music sets the tone/vibe and I'd love to have the music be what guests talk about after our wedding! We want to be very intentional with the songs and genres we play so that the day feels like US rather than a general wedding playlist! We love a big range of music from like frank Sinatra to big booty mix (we love EDM!) and would like to have someone create those fun nostalgic moments for us as she celebrate with our loved ones!",
    musicianStage: "pending_booking", meetingDate: "2026-07-23",
    availability: [{ musician: "brian", response: "available" }],
    bookings: [],
  },
  {
    clientName: "Scarlett Anderson", fianceName: "Tommy Ferry", eventDate: "2027-09-04", location: "Garty Pavilion, 1220 El Carmel Pl, San Diego, CA 92109",
    djTier: null, instruments: ["Saxophone"],
    clientVision: "",
    musicianStage: "planning", meetingDate: "2026-07-08",
    availability: [{ musician: "brian", response: "available" }],
    bookings: [{ musician: "brian", services: ["2 Hours of Dancing"], payout: 1000 }],
  },
  {
    clientName: "Lauren Sardarian", fianceName: "Dustin Sallen", eventDate: "2027-02-20", location: "Monserate Winery",
    djTier: "Headliner", instruments: ["Saxophone"],
    clientVision: "We are most excited to celebrate with our loved ones on the dance floor! We are hoping for a high energy dance floor with fun mash ups and \"club style\" lighting.",
    musicianStage: "new", meetingDate: null,
    availability: [{ musician: "brian", response: "available" }],
    bookings: [],
  },
  {
    clientName: "Delaney Kitching", fianceName: "Brad", eventDate: "2026-10-02", location: "Ponte Winery - Temecula",
    djTier: "Headliner", instruments: ["Saxophone"],
    clientVision: "90s country, EDM, 80s music, and ABBA. It would be super cool to have these styles mixed together in creative ways. I picture high-energy 90s country songs turned into EDM-style remixes, ABBA played several times throughout the night, and 80s songs mashed up to appeal to all generations. We want music people recognize right away but played in super high energy versions! Also, we want to surprise our guests with the saxophone player — have the saxophone player hop out onto the dance floor to get the party going.",
    musicianStage: "planning", meetingDate: "2026-01-13",
    availability: [{ musician: "brian", response: "available" }],
    bookings: [{ musician: "brian", services: ["2 Hours of Dancing"], payout: 800 }],
  },
  {
    clientName: "Emily Marquis", fianceName: "Josh Levine", eventDate: "2026-03-28", location: "Monserate Winery, Villa de Fiore",
    djTier: "Resident", instruments: ["Saxophone"],
    clientVision: "",
    musicianStage: "complete", meetingDate: null,
    availability: [{ musician: "brian", response: "available" }],
    bookings: [{ musician: "brian", services: ["Dinner", "2 Hours of Dancing"], payout: 1000 }],
  },
  {
    clientName: "Sage Hinojoza", fianceName: "Luke Leal", eventDate: "2026-07-13", location: "Monserate Winery, Tuscan Villa, maybe new venue",
    djTier: "Associate", instruments: ["Violin"],
    clientVision: "A seemless ceremony, fun dancing, songs and beats of music that are great for dancing, smooth transitions between songs, music that is not explicit, wedding is Italian/Elegant.",
    musicianStage: "planning", meetingDate: null,
    availability: [{ musician: "rebecca", response: "available" }],
    bookings: [{ musician: "rebecca", services: ["Ceremony", "Cocktail Hour"], payout: 800 }],
  },
  {
    clientName: "Caitlin Consolo", fianceName: "Bryan Simpkins", eventDate: "2026-11-15", location: "Monserate winery, New Venue!!!",
    djTier: "Resident", instruments: ["Violin", "Saxophone"],
    clientVision: "Violin for cocktail hour, dj for the rest. Photo Booth indoors during reception.",
    musicianStage: "planning", meetingDate: null,
    availability: [{ musician: "brian", response: "available" }, { musician: "rebecca", response: "available" }],
    bookings: [
      { musician: "rebecca", services: ["Ceremony"], payout: 600 },
      { musician: "brian", services: ["2 Hours of Dancing"], payout: 800 },
    ],
  },
];

async function requireOwner() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase.from("users").select("role").eq("id", user.id).single();
  return profile?.role === "owner" ? user : null;
}

export async function GET(request: Request) {
  const owner = await requireOwner();
  if (!owner) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const commit = new URL(request.url).searchParams.get("commit") === "true";
  const admin = createAdminClient();

  const { data: musicians } = await admin.from("users").select("id, display_name").eq("role", "musician");
  const findMusician = (name: string) => (musicians ?? []).find((m) => (m.display_name || "").toLowerCase().includes(name));
  const brian = findMusician("brian");
  const rebecca = findMusician("rebecca");
  if (!brian || !rebecca) {
    return NextResponse.json({ error: "Couldn't find both roster musicians by name (Brian/Rebecca)." }, { status: 400 });
  }
  const musicianId = (m: "brian" | "rebecca") => (m === "brian" ? brian.id : rebecca.id);

  const report: Array<Record<string, unknown>> = [];

  for (const spec of NEW_LEADS) {
    const upgrades = spec.instruments.join(", ");
    const plan = {
      clientName: spec.clientName, fianceName: spec.fianceName, eventDate: spec.eventDate,
      djTier: spec.djTier, upgrades, musicianStage: spec.musicianStage, meetingDate: spec.meetingDate,
      availability: spec.availability, bookings: spec.bookings,
    };

    if (commit) {
      const { data: lead, error: leadError } = await admin.from("leads").insert({
        client_name: spec.clientName,
        fiance_name: spec.fianceName,
        event_date: spec.eventDate,
        location: spec.location,
        dj_tier: spec.djTier,
        upgrades,
        client_vision: spec.clientVision,
        source: "manual",
      }).select("id").single();

      if (leadError || !lead) {
        report.push({ ...plan, error: leadError?.message || "insert failed" });
        continue;
      }

      for (const b of spec.bookings) {
        await admin.from("lead_musicians").insert({ lead_id: lead.id, musician_id: musicianId(b.musician), services: b.services, payout: b.payout });
      }
      // Booking inserts above auto-advance musician_stage to 'planning' via
      // trg_advance_musician_stage — this explicit update makes sure the
      // final stage matches the spec (e.g. 'complete') regardless.
      await admin.from("leads").update({ musician_stage: spec.musicianStage, musician_meeting_date: spec.meetingDate }).eq("id", lead.id);

      for (const a of spec.availability) {
        await admin.from("availability_responses").insert({ lead_id: lead.id, dj_user_id: musicianId(a.musician), response: a.response });
      }

      report.push({ ...plan, leadId: lead.id, created: true });
    } else {
      report.push(plan);
    }
  }

  return NextResponse.json({ commit, count: NEW_LEADS.length, rows: report });
}
