import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { MusicianStage, MusicianService } from "@/lib/supabase/types";

// One-time backfill from Austin's second Google Sheet, which tracked the
// musician (Saxophone/Violin) add-on pipeline separately from the Gig
// Board itself before musician_stage existed here. Matches rows to
// EXISTING leads only — never creates new ones. Defaults to a dry run
// (commit: false) so the match list can be reviewed before anything is
// written; see the accompanying report format below.
const SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/11GKB9PC7SNAjXCR6p7Yki4Tr2UDzyQ_jIXz5Uh7ZbtA/export?format=csv&gid=0";

async function requireOwner() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase.from("users").select("role").eq("id", user.id).single();
  return profile?.role === "owner" ? user : null;
}

function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\r") continue;
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

function mapStage(raw: string): MusicianStage | null {
  const s = raw.trim().toUpperCase();
  if (s === "NEW") return "new";
  if (s === "PENDING BOOKING") return "pending_booking";
  if (s === "PLANNING") return "planning";
  if (s === "ARCHIVED") return "archived";
  if (s === "COMPLETE") return "complete";
  if (s.includes("BOOKED") && s.includes("NO MUSICIAN")) return "booked_no_musician";
  return null;
}

// Sheet dates are M/D/YY or M/D/YYYY with no consistent padding.
function parseSheetDate(raw: string): string | null {
  const m = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!m) return null;
  const [, mo, d, yRaw] = m;
  const y = yRaw.length === 2 ? `20${yRaw}` : yRaw;
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

function firstWord(s: string): string {
  return s.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, "") || "";
}

function extractDollarAmount(raw: string): number | null {
  const m = raw.match(/\$?([\d,]+(?:\.\d+)?)/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function matchServices(raw: string): MusicianService[] {
  const lower = raw.toLowerCase();
  const out: MusicianService[] = [];
  if (lower.includes("ceremony")) out.push("Ceremony");
  if (lower.includes("cocktail")) out.push("Cocktail Hour");
  if (lower.includes("dinner")) out.push("Dinner");
  if (lower.includes("formalit")) out.push("Formalities");
  if (lower.includes("dancing") || lower.includes("hours of danc") || lower.includes("hrs danc") || lower.includes("hrs of danc")) out.push("2 Hours of Dancing");
  return out;
}

type LeadCandidate = { id: string; client_name: string | null; fiance_name: string | null; event_date: string | null; musician_stage: string };

function matchLead(clientNameRaw: string, eventDateRaw: string, candidates: LeadCandidate[]): { match: LeadCandidate | null; reason?: string; candidateCount?: number } {
  const halves = clientNameRaw.split("+").map((h) => firstWord(h)).filter(Boolean);
  if (halves.length === 0) return { match: null, reason: "couldn't extract a name from CLIENT NAME" };

  const sheetYear = parseSheetDate(eventDateRaw)?.slice(0, 4);

  const scored = candidates.map((l) => {
    const leadTokens = [firstWord(l.client_name || ""), firstWord(l.fiance_name || "")].filter(Boolean);
    const hits = halves.filter((h) => leadTokens.includes(h)).length;
    const yearMatch = sheetYear && l.event_date ? l.event_date.startsWith(sheetYear) : false;
    return { lead: l, hits, yearMatch };
  }).filter((s) => s.hits > 0);

  if (scored.length === 0) return { match: null, reason: "no lead with a matching first name" };

  const bestHits = Math.max(...scored.map((s) => s.hits));
  let top = scored.filter((s) => s.hits === bestHits);
  if (top.length > 1) {
    const withYear = top.filter((s) => s.yearMatch);
    if (withYear.length === 1) top = withYear;
  }
  if (top.length !== 1) return { match: null, reason: "ambiguous — multiple leads match", candidateCount: top.length };
  return { match: top[0].lead };
}

// GET (not POST) so Austin can trigger this from the browser address bar
// while logged in as owner — cookies carry the session, no dev tools or
// curl needed. Defaults to a dry run; append ?commit=true only after
// reviewing the dry-run report.
export async function GET(request: Request) {
  const owner = await requireOwner();
  if (!owner) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const commit = new URL(request.url).searchParams.get("commit") === "true";

  const csvRes = await fetch(SHEET_CSV_URL);
  if (!csvRes.ok) {
    return NextResponse.json({ error: `Couldn't fetch the sheet (${csvRes.status}) — is it still shared "anyone with the link"?` }, { status: 502 });
  }
  const csvText = await csvRes.text();
  const rows = parseCSV(csvText);
  const dataRows = rows.slice(1); // drop header

  const admin = createAdminClient();

  const { data: musicians } = await admin.from("users").select("id, display_name").eq("role", "musician");
  const findMusician = (name: string) => (musicians ?? []).find((m) => (m.display_name || "").toLowerCase().includes(name));
  const brian = findMusician("brian");
  const rebecca = findMusician("rebecca");
  if (!brian || !rebecca) {
    return NextResponse.json({
      error: `Couldn't find both roster musicians by name — found Brian: ${brian ? "yes" : "no"}, Rebecca: ${rebecca ? "yes" : "no"}. Their display names in Roster must contain "Brian"/"Rebecca".`,
    }, { status: 400 });
  }

  const { data: candidates } = await admin.from("leads").select("id, client_name, fiance_name, event_date, musician_stage");
  const { data: existingResponses } = await admin.from("availability_responses").select("lead_id, dj_user_id");
  const { data: existingBookings } = await admin.from("lead_musicians").select("lead_id, musician_id");
  const respondedSet = new Set((existingResponses ?? []).map((r) => `${r.lead_id}:${r.dj_user_id}`));
  const bookedSet = new Set((existingBookings ?? []).map((b) => `${b.lead_id}:${b.musician_id}`));

  const report: Array<Record<string, unknown>> = [];
  let matchedCount = 0;

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    const [stageRaw, ownerRaw, eventDateRaw, clientNameRaw, , , , meetingDateRaw, servicesRaw, rateRaw, , brianRaw, rebeccaRaw] = row;
    if (!clientNameRaw?.trim() && !stageRaw?.trim()) continue; // blank row

    const stage = mapStage(stageRaw || "");
    if (!stage) {
      report.push({ row: i + 2, clientName: clientNameRaw, skipped: true, reason: `unrecognized STAGE value: "${stageRaw}"` });
      continue;
    }

    const { match, reason, candidateCount } = matchLead(clientNameRaw || "", eventDateRaw || "", (candidates ?? []) as LeadCandidate[]);
    if (!match) {
      report.push({ row: i + 2, clientName: clientNameRaw, stage, skipped: true, reason, candidateCount });
      continue;
    }

    matchedCount++;
    const meetingDate = parseSheetDate(meetingDateRaw || "");
    const plan: Record<string, unknown> = {
      leadId: match.id,
      matchedTo: [match.client_name, match.fiance_name].filter(Boolean).join(" + "),
      row: i + 2,
      stage,
      meetingDate,
    };

    if (commit) {
      // Booking rows first (for planning/complete) so the auto-advance
      // trigger's write to musician_stage gets overwritten by our own
      // explicit stage update right after, rather than racing it.
      const ownerUpper = (ownerRaw || "").toUpperCase();
      if (["planning", "complete"].includes(stage)) {
        const services = matchServices(servicesRaw || "");
        const payout = extractDollarAmount(rateRaw || "");
        if (ownerUpper.includes("BRIAN") && !bookedSet.has(`${match.id}:${brian.id}`)) {
          await admin.from("lead_musicians").insert({ lead_id: match.id, musician_id: brian.id, services, payout });
        }
        if (ownerUpper.includes("REBECCA") && !bookedSet.has(`${match.id}:${rebecca.id}`)) {
          await admin.from("lead_musicians").insert({ lead_id: match.id, musician_id: rebecca.id, services, payout });
        }
      }

      await admin.from("leads").update({ musician_stage: stage, musician_meeting_date: meetingDate }).eq("id", match.id);

      for (const [raw, musician] of [[brianRaw, brian], [rebeccaRaw, rebecca]] as const) {
        const val = (raw || "").trim().toUpperCase();
        if (val !== "OPEN" && val !== "UNAVAILABLE") continue;
        if (respondedSet.has(`${match.id}:${musician.id}`)) continue;
        await admin.from("availability_responses").insert({
          lead_id: match.id,
          dj_user_id: musician.id,
          response: val === "OPEN" ? "available" : "pass",
        });
      }
    }

    report.push(plan);
  }

  return NextResponse.json({
    commit,
    totalRows: dataRows.length,
    matched: matchedCount,
    skipped: dataRows.length - matchedCount,
    rows: report,
  });
}
