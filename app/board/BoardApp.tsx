"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { Database, DjTier, ProdTier, TravelZone, Instrument, MusicianService } from "@/lib/supabase/types";
import { tierRate, travelRate, guessTravelZone } from "@/lib/rates";
import { anyInstrumentMentioned, instrumentMentioned } from "@/lib/instruments";
import {
  T, DJ_TIERS, LEAD_STATUS, MUSICIAN_STAGE, fmtDate,
  Lamp, Tag, Btn, Field, Input, Select, TextArea, Empty, TierPicker, SectionLabel, Avatar,
  MUSICIAN_INSTRUMENTS, MUSICIAN_SERVICES, TIER_COLORS, INSTRUMENT_COLORS,
} from "./ui";

type LeadRow = Database["public"]["Views"]["leads_feed"]["Row"];
type LeadInsert = Database["public"]["Tables"]["leads"]["Insert"];
type LeadUpdate = Database["public"]["Tables"]["leads"]["Update"];
type CompanySettings = Database["public"]["Tables"]["company_settings"]["Row"];
type RosterUser = { id: string; email: string; display_name: string | null };
type AvailabilityRow = { lead_id: string; dj_user_id: string; response: "available" | "pass" };
type LeaderboardRow = Database["public"]["Views"]["dj_leaderboard"]["Row"];
type EventRow = Database["public"]["Tables"]["events"]["Row"];
type LeadMusicianRow = Database["public"]["Tables"]["lead_musicians"]["Row"];

const tierStr = (l: LeadRow) => [l.dj_tier, l.prod_tier].filter(Boolean).join(" + ");
const byDate = (a: LeadRow, b: LeadRow) => ((a.event_date || "9999") > (b.event_date || "9999") ? 1 : -1);
const isPastEvent = (l: LeadRow) => !!l.event_date && l.event_date < new Date().toISOString().slice(0, 10);

// Same 48-hour window as the non-responder reminder cron (see
// app/api/cron/reminders/route.ts) — reusing it here keeps "on time" the
// same meaning everywhere, rather than inventing a second threshold. A
// currently-open check older than 48h without a response breaks the
// streak outright, since it's already late; otherwise the streak is how
// many of the most recent responses (newest lead first) came in inside
// the window before the first one that didn't.
const RESPONSE_STREAK_WINDOW_MS = 48 * 60 * 60 * 1000;
function computeResponseStreak(
  respondedLeads: { leadCreatedAt: string; respondedAt: string }[],
  openChecks: LeadRow[],
): number {
  const now = Date.now();
  if (openChecks.some((l) => now - new Date(l.created_at).getTime() > RESPONSE_STREAK_WINDOW_MS)) return 0;
  const sorted = [...respondedLeads].sort((a, b) => new Date(b.leadCreatedAt).getTime() - new Date(a.leadCreatedAt).getTime());
  let streak = 0;
  for (const r of sorted) {
    if (new Date(r.respondedAt).getTime() - new Date(r.leadCreatedAt).getTime() > RESPONSE_STREAK_WINDOW_MS) break;
    streak++;
  }
  return streak;
}
const bySubmitted = (a: LeadRow, b: LeadRow) => (new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

// Some sections (the DJ's Date Checks / Pending sub-categories) each need
// their own independent sort control, rather than sharing the one global
// sortBy/sortDir the rest of the board uses — plain helpers (not hooks) so
// they can be used freely after the loading early-return, with the actual
// per-section state declared once up top alongside the other useState calls.
type SectionSort = { by: "event" | "submitted"; dir: "asc" | "desc" };
const toggleSectionSort = (setter: (updater: (prev: SectionSort) => SectionSort) => void) => (next: "event" | "submitted") => {
  setter((prev) => (prev.by === next ? { by: prev.by, dir: prev.dir === "asc" ? "desc" : "asc" } : { by: next, dir: "asc" }));
};
const sortSection = (list: LeadRow[], sort: SectionSort) => {
  const base = sort.by === "event" ? byDate : bySubmitted;
  const dirMult = sort.dir === "asc" ? 1 : -1;
  return [...list].sort((a, b) => base(a, b) * dirMult);
};

function SortToggle({
  sortBy, sortDir, onChange,
}: {
  sortBy: "event" | "submitted";
  sortDir: "asc" | "desc";
  onChange: (v: "event" | "submitted") => void;
}) {
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
      <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.14em", color: T.dim }}>SORT</span>
      {(["event", "submitted"] as const).map((v) => {
        const active = sortBy === v;
        return (
          <button
            key={v}
            onClick={() => onChange(v)}
            title={active ? "Click again to flip the sort direction" : undefined}
            style={{
              fontFamily: "inherit", fontSize: 12, fontWeight: 700, letterSpacing: "0.04em",
              padding: "5px 12px", borderRadius: 20, cursor: "pointer",
              background: active ? T.teal : "transparent",
              color: T.text,
              border: `1px solid ${active ? T.teal : T.line}`,
              display: "flex", alignItems: "center", gap: 5,
            }}
          >
            {v === "event" ? "EVENT DATE" : "SUBMITTED"}
            {active && <span>{sortDir === "asc" ? "↑" : "↓"}</span>}
          </button>
        );
      })}
    </div>
  );
}

function totalPayout(lead: LeadRow): number {
  return (lead.payout || 0) + (lead.travel_rate || 0);
}

function leadStatus(lead: LeadRow) {
  if (lead.status === "checking") return lead.has_available ? "ready" : "checking";
  return lead.status;
}

// A single label per lead for cross-tab search results — reuses the same
// wording as the tabs (Pipeline/Meetings/Upcoming/Past/Archive) so a
// result reads the same whether you'd normally find it as "ready" in
// Pipeline or "booked" split into Upcoming vs. Past.
function stageLabel(lead: LeadRow): string {
  const st = leadStatus(lead);
  if (st === "booked") return isPastEvent(lead) ? "PAST" : "UPCOMING";
  return LEAD_STATUS[st].label;
}

function matchesSearch(lead: LeadRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const d = fmtDate(lead.event_date);
  const haystack = [
    lead.client_name,
    lead.fiance_name,
    lead.event_date,
    d.dow, d.mon, d.day ? String(d.day) : null, d.year ? String(d.year) : null,
  ].filter(Boolean).join(" ").toLowerCase();
  return haystack.includes(q);
}

function AvailChips({
  lead, roster, musicianRoster, rosterProfiles, availability, onRemove,
}: {
  lead: LeadRow;
  roster: RosterUser[];
  musicianRoster: RosterUser[];
  rosterProfiles: { user_id: string; instrument: Instrument | null }[];
  availability: AvailabilityRow[];
  onRemove: (leadId: string, userId: string, label: string) => void;
}) {
  const responses = availability.filter((r) => r.lead_id === lead.id);
  const rosterMap = Object.fromEntries(roster.map((d) => [d.id, d.display_name || d.email]));
  const musicianMap = Object.fromEntries(musicianRoster.map((m) => [m.id, m.display_name || m.email]));
  const instrumentMap = Object.fromEntries(rosterProfiles.map((p) => [p.user_id, p.instrument]));
  const noReply = roster.filter((d) => !responses.some((r) => r.dj_user_id === d.id)).map((d) => d.display_name || d.email);
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
      {responses.map((r) => {
        // A musician's chip is colored by instrument (gold Sax, brown
        // Violin) instead of the DJ side's green/red available/pass —
        // rosterMap alone missed musicians entirely, showing "?" since
        // they're never in the DJ roster.
        const instrument = instrumentMap[r.dj_user_id];
        const color = instrument ? INSTRUMENT_COLORS[instrument] : r.response === "available" ? T.green : T.red;
        const name = rosterMap[r.dj_user_id] || musicianMap[r.dj_user_id] || "?";
        return (
          <span key={r.dj_user_id} style={{
            display: "inline-flex", alignItems: "center", gap: 5,
            fontSize: 11.5, fontWeight: 700, padding: "3px 6px 3px 8px", borderRadius: 20,
            background: color + "22", color, border: `1px solid ${color}44`,
          }}>
            {name} {r.response === "available" ? "✓" : "✕"}
            <button
              aria-label={`Remove ${name}'s response`}
              onClick={() => onRemove(lead.id, r.dj_user_id, name)}
              style={{
                fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center",
                width: 14, height: 14, borderRadius: "50%", cursor: "pointer",
                background: "transparent", color, border: "none", padding: 0, fontSize: 11, lineHeight: 1, opacity: 0.7,
              }}
            >
              ×
            </button>
          </span>
        );
      })}
      {noReply.length > 0 && <span style={{ fontSize: 11.5, color: T.dim }}>no reply: {noReply.join(", ")}</span>}
      {roster.length === 0 && <span style={{ fontSize: 11.5, color: T.dim }}>add DJs in Roster to run date checks</span>}
    </div>
  );
}

function PayoutEditor({ lead, onSave }: { lead: LeadRow; onSave: (id: string, payout: number | null) => void }) {
  const [value, setValue] = useState(lead.payout != null ? String(lead.payout) : "");
  const [dirty, setDirty] = useState(false);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.14em", color: T.dim }}>PAYOUT ($)</span>
      <Input
        type="number"
        value={value}
        onChange={(e) => { setValue(e.target.value); setDirty(true); }}
        style={{ width: 100 }}
      />
      {dirty && (
        <Btn small kind="primary" onClick={() => { onSave(lead.id, value ? Number(value) : null); setDirty(false); }}>
          SAVE
        </Btn>
      )}
    </div>
  );
}

function ViboLinkEditor({ lead, onSave }: { lead: LeadRow; onSave: (id: string, viboLink: string | null) => void }) {
  const [value, setValue] = useState(lead.vibo_link || "");
  const [dirty, setDirty] = useState(false);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.14em", color: T.dim }}>VIBO LINK</span>
      <Input
        type="url"
        value={value}
        onChange={(e) => { setValue(e.target.value); setDirty(true); }}
        placeholder="Paste the Vibo host link"
        style={{ width: 220 }}
      />
      {dirty && (
        <Btn small kind="primary" onClick={() => { onSave(lead.id, value.trim() || null); setDirty(false); }}>
          SAVE
        </Btn>
      )}
    </div>
  );
}

function TravelEditor({
  lead, onSave,
}: {
  lead: LeadRow;
  onSave: (id: string, patch: { travel_rate: number | null }) => void;
}) {
  const [rate, setRate] = useState(lead.travel_rate != null ? String(lead.travel_rate) : "");
  const [dirty, setDirty] = useState(false);

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.14em", color: T.dim }}>TRAVEL ($)</span>
      <Input
        type="number"
        value={rate}
        onChange={(e) => { setRate(e.target.value); setDirty(true); }}
        style={{ width: 90 }}
      />
      {dirty && (
        <Btn small kind="primary" onClick={() => {
          onSave(lead.id, { travel_rate: rate ? Number(rate) : null });
          setDirty(false);
        }}>
          SAVE
        </Btn>
      )}
    </div>
  );
}

function MeetingNotesEditor({ lead, onSave }: { lead: LeadRow; onSave: (id: string, notes: string) => void }) {
  const [value, setValue] = useState(lead.meeting_notes || "");
  const [dirty, setDirty] = useState(false);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.14em", color: T.dim }}>MEETING NOTES</span>
      <TextArea
        value={value}
        onChange={(e) => { setValue(e.target.value); setDirty(true); }}
        placeholder="Notes from the meeting — logistics, timeline, anything worth remembering…"
        style={{ minHeight: 60 }}
      />
      {dirty && (
        <Btn small kind="primary" style={{ alignSelf: "flex-start" }} onClick={() => { onSave(lead.id, value); setDirty(false); }}>
          SAVE NOTES
        </Btn>
      )}
    </div>
  );
}

function describeEvent(e: EventRow, actorLabel: string): string {
  const detail = (e.detail || {}) as Record<string, unknown>;
  if (e.event_type === "status_change") {
    return `${actorLabel} moved this from ${String(detail.from ?? "?")} to ${String(detail.to ?? "?")}`;
  }
  if (e.event_type === "availability_response") {
    return `${actorLabel} marked themselves ${String(detail.response ?? "?")}`;
  }
  if (e.event_type === "availability_retracted") {
    return `${actorLabel} retracted their "${String(detail.previous_response ?? "?")}" response`;
  }
  return `${actorLabel}: ${e.event_type}`;
}

function LeadHistory({
  leadId, roster, userId, onFetch,
}: {
  leadId: string;
  roster: RosterUser[];
  userId: string;
  onFetch: (leadId: string) => Promise<EventRow[]>;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [events, setEvents] = useState<EventRow[] | null>(null);

  const toggle = async () => {
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (events === null) {
      setLoading(true);
      const data = await onFetch(leadId);
      setEvents(data);
      setLoading(false);
    }
  };

  const actorName = (actorId: string | null) => {
    if (!actorId) return "Automatically";
    if (actorId === userId) return "You";
    return roster.find((d) => d.id === actorId)?.display_name || "A DJ";
  };

  return (
    <div>
      <Btn kind="ghost" small onClick={toggle}>{open ? "HIDE HISTORY" : "HISTORY"}</Btn>
      {open && (
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
          {loading && <div style={{ fontSize: 12, color: T.dim }}>Loading…</div>}
          {!loading && events?.length === 0 && <div style={{ fontSize: 12, color: T.dim }}>No activity logged yet.</div>}
          {!loading && events?.map((e) => (
            <div key={e.id} style={{ fontSize: 12, color: T.dim, display: "flex", gap: 8, justifyContent: "space-between" }}>
              <span>{describeEvent(e, actorName(e.actor_user_id))}</span>
              <span style={{ flexShrink: 0, color: T.dim }}>{new Date(e.created_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// pending_booking has no distinct DB value for the hold-vs-follow-up split
// on purpose — it's a 14-day deadline computed live off musician_meeting_
// date so it can never drift out of sync with it. Falls back to the plain
// stage label if a pending_booking row somehow has no meeting date yet.
function musicianStageDisplay(lead: LeadRow): { label: string; color: string } {
  if (lead.musician_stage === "pending_booking" && lead.musician_meeting_date) {
    const holdUntil = new Date(lead.musician_meeting_date + "T12:00:00").getTime() + 14 * 24 * 60 * 60 * 1000;
    return Date.now() <= holdUntil ? { label: "HOLD DATE", color: T.yellow } : { label: "FOLLOW UP", color: T.blue };
  }
  return MUSICIAN_STAGE[lead.musician_stage];
}

// One tag per booked musician, by name, colored by their instrument —
// e.g. "Brian" in gold (Saxophone), "Rebecca" in brown (Violin) — rather
// than a generic "Saxophone"/"Violin" label.
function BookedMusicianTags({ musicians }: { musicians: { name: string | null; instrument: Instrument }[] | null }) {
  if (!musicians || musicians.length === 0) return null;
  return (
    <>
      {musicians.map((m, i) => (
        <Tag key={`${m.instrument}-${i}`} color={INSTRUMENT_COLORS[m.instrument] || T.blue}>{m.name || m.instrument}</Tag>
      ))}
    </>
  );
}

// Vertical (column) leaderboard: bar height encodes the dollar total (the
// actual ranking metric), count is a secondary direct label, and color is
// only a 2-state highlight (you vs. everyone else) — identity is already
// carried by the avatar + name, not by color, so this doesn't need a full
// categorical palette. No gridlines: every bar is already direct-labeled.
function DjBarChart({
  rows, userId, unit,
}: {
  rows: { dj_id: string; display_name: string | null; email: string; avatar_url: string | null; count: number; total: number }[];
  userId: string;
  unit: string;
}) {
  if (rows.length === 0) return <Empty text="Once DJs start booking gigs, standings show up here." />;
  const maxTotal = Math.max(1, ...rows.map((r) => r.total));
  const BAR_MAX = 140;
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 22, overflowX: "auto", paddingTop: 4, paddingBottom: 4 }}>
      {rows.map((r) => {
        const isMe = r.dj_id === userId;
        const barHeight = Math.max(4, Math.round((r.total / maxTotal) * BAR_MAX));
        return (
          <div key={r.dj_id} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, minWidth: 68, flexShrink: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: T.text, whiteSpace: "nowrap" }}>${r.total}</div>
            <Avatar url={r.avatar_url} name={r.display_name || r.email} size={36} ring={isMe} />
            <div
              style={{
                width: 24, height: barHeight, borderRadius: "4px 4px 0 0",
                background: isMe ? T.green : T.teal,
              }}
            />
            <div style={{ fontSize: 11.5, fontWeight: 700, color: T.text, textAlign: "center", maxWidth: 84, lineHeight: 1.25 }}>
              {r.display_name || r.email}{isMe && <span style={{ color: T.dim, fontWeight: 400 }}> (you)</span>}
            </div>
            <div style={{ fontSize: 10.5, color: T.dim }}>{r.count} {unit}{r.count !== 1 ? "s" : ""}</div>
          </div>
        );
      })}
    </div>
  );
}

// Replaces a free-form stage selector with buttons scoped to what's
// actually possible from the current stage — mirrors how the DJ card's
// actions work (different buttons for different states, not a dropdown).
function MusicianStageActions({
  lead, musicianRoster, availability, leadMusicians, onMeetingBooked, onMarkBooked, onMarkLost, onUndoPlanning,
}: {
  lead: LeadRow;
  musicianRoster: RosterUser[];
  availability: AvailabilityRow[];
  leadMusicians: LeadMusicianRow[];
  onMeetingBooked: (leadId: string) => void;
  onMarkBooked: (leadId: string, musicianId: string | null) => void;
  onMarkLost: (leadId: string) => void;
  onUndoPlanning: (leadId: string, targetStage: "new" | "pending_booking", hasAssignedDj: boolean) => void;
}) {
  const bookedIds = new Set(leadMusicians.filter((lm) => lm.lead_id === lead.id).map((lm) => lm.musician_id));
  const availableMusicians = musicianRoster.filter((m) =>
    !bookedIds.has(m.id) && availability.some((r) => r.lead_id === lead.id && r.dj_user_id === m.id && r.response === "available")
  );

  if (lead.musician_stage === "new") {
    if (availableMusicians.length === 0) return null;
    return (
      <Btn kind="green" small onClick={() => onMeetingBooked(lead.id)}>MEETING BOOKED →</Btn>
    );
  }

  if (lead.musician_stage === "pending_booking") {
    const display = musicianStageDisplay(lead);
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Tag color={display.color}>{display.label}</Tag>
          {lead.musician_meeting_date && (
            <span style={{ fontSize: 11.5, color: T.dim }}>
              Meeting {new Date(lead.musician_meeting_date + "T12:00:00").toLocaleDateString("en-US")}
            </span>
          )}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {availableMusicians.map((m) => (
            <Btn key={m.id} kind="green" small onClick={() => onMarkBooked(lead.id, m.id)}>
              MARK BOOKED — {m.display_name || m.email}
            </Btn>
          ))}
          <Btn kind="ghost" small onClick={() => onMarkBooked(lead.id, null)}>MARK BOOKED — NO MUSICIAN</Btn>
          <Btn kind="ghost" small style={{ color: T.red, borderColor: T.red + "44" }} onClick={() => onMarkLost(lead.id)}>MARK LOST</Btn>
        </div>
      </div>
    );
  }

  // Reaching "planning" with nobody currently booked means a musician was
  // removed after MARK BOOKED already advanced the stage (the REMOVE
  // button only deletes the lead_musicians row — it doesn't know to walk
  // the stage back too). This is the recovery path for that mismatch.
  if (lead.musician_stage === "planning" && bookedIds.size === 0) {
    const hasAssignedDj = !!lead.assigned_dj_id;
    return (
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <Btn kind="ghost" small onClick={() => onUndoPlanning(lead.id, "pending_booking", hasAssignedDj)}>
          UNDO — BACK TO PENDING BOOKING
        </Btn>
        <Btn kind="ghost" small onClick={() => onUndoPlanning(lead.id, "new", hasAssignedDj)}>
          UNDO — BACK TO NEW
        </Btn>
      </div>
    );
  }

  return null;
}

function MusicianBookingRow({
  musician, instrument, booking, onUnbook, onUpdate,
}: {
  musician: RosterUser;
  instrument: Instrument | null | undefined;
  booking: LeadMusicianRow;
  onUnbook: (id: string, label: string) => void;
  onUpdate: (id: string, patch: { services?: MusicianService[]; payout?: number | null; deposit_paid?: boolean; paid_in_full?: boolean }, msg?: string) => void;
}) {
  const [payout, setPayout] = useState(booking.payout != null ? String(booking.payout) : "");
  const [dirty, setDirty] = useState(false);
  const services = booking.services || [];

  return (
    <div style={{ background: T.raised, border: `1px solid ${T.line}`, borderRadius: 8, padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <div style={{ fontWeight: 700, fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
          {musician.display_name || musician.email}
          {instrument && <Tag color={T.blue}>{instrument}</Tag>}
        </div>
        <Btn kind="danger" small onClick={() => onUnbook(booking.id, musician.display_name || musician.email)}>REMOVE</Btn>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        {MUSICIAN_SERVICES.map((s) => {
          const active = services.includes(s);
          return (
            <button
              key={s}
              onClick={() => onUpdate(booking.id, { services: active ? services.filter((x) => x !== s) : [...services, s] })}
              style={{
                fontFamily: "inherit", fontSize: 12, fontWeight: 700, letterSpacing: "0.04em",
                padding: "4px 10px", borderRadius: 20, cursor: "pointer",
                background: active ? T.teal : "transparent",
                color: active ? T.text : T.dim,
                border: `1px solid ${active ? T.teal : T.line}`,
              }}
            >
              {s}
            </button>
          );
        })}
        {services.length === 0 && <span style={{ fontSize: 11, color: T.red }}>no services picked yet</span>}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.14em", color: T.dim }}>PAYOUT ($) — PRIVATE TO THIS MUSICIAN</span>
        <Input type="number" value={payout} onChange={(e) => { setPayout(e.target.value); setDirty(true); }} style={{ width: 100 }} />
        {dirty && (
          <Btn small kind="primary" onClick={() => { onUpdate(booking.id, { payout: payout ? Number(payout) : null }, "Payout updated"); setDirty(false); }}>
            SAVE
          </Btn>
        )}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <Btn
          kind={booking.deposit_paid ? "green" : "ghost"}
          small
          onClick={() => onUpdate(booking.id, { deposit_paid: !booking.deposit_paid }, booking.deposit_paid ? "Deposit unmarked" : "Deposit marked paid")}
        >
          {booking.deposit_paid ? "✓ " : ""}DEPOSIT PAID
        </Btn>
        <Btn
          kind={booking.paid_in_full ? "green" : "ghost"}
          small
          onClick={() => onUpdate(booking.id, { paid_in_full: !booking.paid_in_full }, booking.paid_in_full ? "Unmarked paid in full" : "Marked paid in full")}
        >
          {booking.paid_in_full ? "✓ " : ""}PAID IN FULL
        </Btn>
      </div>
    </div>
  );
}

function MusicianBooking({
  leadId, musicianRoster, rosterProfiles, bookings, availability, musicianStage, onBook, onUnbook, onUpdate, onAddToHold, disableNewBookings,
}: {
  leadId: string;
  musicianRoster: RosterUser[];
  rosterProfiles: { user_id: string; instrument: Instrument | null }[];
  bookings: LeadMusicianRow[];
  availability: AvailabilityRow[];
  musicianStage: LeadRow["musician_stage"];
  onBook: (leadId: string, musicianId: string) => void;
  onUnbook: (id: string, label: string) => void;
  onUpdate: (id: string, patch: { services?: MusicianService[]; payout?: number | null; deposit_paid?: boolean; paid_in_full?: boolean }, msg?: string) => void;
  // Manual shortcut for a musician nobody's asked about yet (no instrument
  // mentioned in the original inquiry) — simulates "said available, owner
  // booked the meeting" in one click, same end state as the normal Date
  // Check -> MEETING BOOKED flow, without waiting on either step.
  onAddToHold: (leadId: string, musicianId: string) => void;
  // Musicians only ever come as part of a DJ package, never booked on
  // their own — so the plain "+ BOOK" shortcut is hidden any time the
  // lead's DJ side isn't booked yet (status !== "booked"), forcing that
  // case through the "MARK BOOKED — {musician}" action above instead,
  // which sets both at once. Already-booked rows still show normally.
  disableNewBookings?: boolean;
}) {
  if (musicianRoster.length === 0) return null;
  const dealDone = musicianStage === "planning" || musicianStage === "complete";
  const isAvailable = (musicianId: string) =>
    availability.some((r) => r.lead_id === leadId && r.dj_user_id === musicianId && r.response === "available");
  const anyRowVisible = musicianRoster.some((m) =>
    bookings.some((b) => b.musician_id === m.id) || !disableNewBookings || (!isAvailable(m.id) && !dealDone)
  );
  if (!anyRowVisible) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.14em", color: T.dim }}>MUSICIANS</span>
      {musicianRoster.map((m) => {
        const instrument = rosterProfiles.find((p) => p.user_id === m.id)?.instrument;
        const booking = bookings.find((b) => b.musician_id === m.id);
        if (booking) {
          return <MusicianBookingRow key={m.id} musician={m} instrument={instrument} booking={booking} onUnbook={onUnbook} onUpdate={onUpdate} />;
        }
        const canBookDirect = !disableNewBookings;
        const canAddToHold = !isAvailable(m.id) && !dealDone;
        if (!canBookDirect && !canAddToHold) return null;
        return (
          <div key={m.id} style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {canBookDirect && (
              <Btn kind="ghost" small onClick={() => onBook(leadId, m.id)}>
                + BOOK {m.display_name || m.email}{instrument ? ` (${instrument})` : ""}
              </Btn>
            )}
            {canAddToHold && (
              <Btn kind="ghost" small onClick={() => onAddToHold(leadId, m.id)}>
                ADD TO HOLD — {m.display_name || m.email}
              </Btn>
            )}
          </div>
        );
      })}
    </div>
  );
}

function EditLeadForm({ lead, onSave, onCancel }: { lead: LeadRow; onSave: (patch: LeadUpdate) => void; onCancel: () => void }) {
  const [f, setF] = useState({
    name: lead.client_name || "",
    fianceName: lead.fiance_name || "",
    contact: lead.contact || "",
    date: lead.event_date || "",
    location: lead.location || "",
    djTier: lead.dj_tier || "",
    prodTier: lead.prod_tier || "",
    upgrades: lead.upgrades || "",
    vision: lead.client_vision || "",
    djNotes: lead.dj_notes || "",
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });

  return (
    <div style={{ background: T.raised, border: `1px solid ${T.teal}55`, borderRadius: 10, padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontWeight: 800, letterSpacing: "0.1em", fontSize: 12, color: T.accent }}>EDIT LEAD</div>
      <SectionLabel>CLIENT</SectionLabel>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Field label="CLIENT"><Input value={f.name} onChange={set("name")} /></Field>
        <Field label="FIANCÉ / PARTNER"><Input value={f.fianceName} onChange={set("fianceName")} /></Field>
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Field label="CONTACT"><Input value={f.contact} onChange={set("contact")} /></Field>
        <Field label="EVENT DATE"><Input type="date" value={f.date} onChange={set("date")} /></Field>
      </div>
      <SectionLabel>EVENT</SectionLabel>
      <Field label="LOCATION"><Input value={f.location} onChange={set("location")} /></Field>
      <TierPicker djTier={f.djTier} prodTier={f.prodTier} onChange={({ djTier, prodTier }) => setF({ ...f, djTier, prodTier })} />
      <Field label="UPGRADES"><Input value={f.upgrades} onChange={set("upgrades")} /></Field>
      <Field label="CLIENT VISION"><TextArea value={f.vision} onChange={set("vision")} /></Field>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.14em", color: T.dim }}>MUSICIAN REQUESTED</span>
        {MUSICIAN_INSTRUMENTS.map((i) => {
          // Matching is purely text-based (see lib/instruments.ts), so
          // "requesting" an instrument just means the literal word is
          // present in Upgrades — this toggle adds/removes it there
          // instead of making Austin hand-edit free text, which is the
          // manual way to add a musician to the proposal even when the
          // original inquiry never asked for one.
          const active = instrumentMentioned({ upgrades: f.upgrades, client_vision: f.vision }, i);
          return (
            <button
              key={i}
              onClick={() => {
                const upgrades = active
                  ? f.upgrades.replace(new RegExp(`,?\\s*${i}`, "i"), "").trim().replace(/^,\s*/, "")
                  : f.upgrades ? `${f.upgrades}, ${i}` : i;
                setF({ ...f, upgrades });
              }}
              style={{
                fontFamily: "inherit", fontSize: 12, fontWeight: 700, letterSpacing: "0.04em",
                padding: "4px 10px", borderRadius: 20, cursor: "pointer",
                background: active ? T.teal : "transparent",
                color: active ? T.text : T.dim,
                border: `1px solid ${active ? T.teal : T.line}`,
              }}
            >
              {i}
            </button>
          );
        })}
      </div>
      <SectionLabel>NOTES</SectionLabel>
      <Field label="NOTES FOR DJs (SHOWN ON DATE CHECK)"><TextArea value={f.djNotes} onChange={set("djNotes")} /></Field>
      <div style={{ fontSize: 11.5, color: T.dim }}>Payout, travel, and deposit status are edited directly on the card, not here.</div>
      <div style={{ display: "flex", gap: 8 }}>
        <Btn kind="primary" onClick={() => onSave({
          client_name: f.name, fiance_name: f.fianceName, contact: f.contact, event_date: f.date || null,
          location: f.location, dj_tier: (f.djTier || null) as DjTier | null, prod_tier: (f.prodTier || null) as ProdTier | null,
          upgrades: f.upgrades, client_vision: f.vision, dj_notes: f.djNotes,
        })}>SAVE CHANGES</Btn>
        <Btn onClick={onCancel}>CANCEL</Btn>
      </div>
    </div>
  );
}

function LeadCard({
  lead, djView, roster, availability, myAnswer, highlighted, busy, userId, onFetchHistory,
  musicianRoster, rosterProfiles, leadMusicians, onBookMusician, onUnbookMusician, onUpdateMusicianBooking,
  onAddMusicianToHold,
  onMusicianMeetingBooked, onMarkMusicianBooked, onMarkMusicianLost, onUndoMusicianPlanning, onRemoveAvailability,
  onSetAvail, onRetractAvail, onUpdateLead, onDeleteLead, onSaveNotes,
}: {
  lead: LeadRow;
  djView?: boolean;
  roster: RosterUser[];
  availability: AvailabilityRow[];
  myAnswer?: "available" | "pass";
  highlighted?: boolean;
  busy?: boolean;
  userId: string;
  onFetchHistory: (leadId: string) => Promise<EventRow[]>;
  musicianRoster: RosterUser[];
  rosterProfiles: { user_id: string; instrument: Instrument | null }[];
  leadMusicians: LeadMusicianRow[];
  onBookMusician: (leadId: string, musicianId: string) => void;
  onUnbookMusician: (id: string, label: string) => void;
  onUpdateMusicianBooking: (id: string, patch: { services?: MusicianService[]; payout?: number | null; deposit_paid?: boolean; paid_in_full?: boolean }, msg?: string) => void;
  onAddMusicianToHold: (leadId: string, musicianId: string) => void;
  onMusicianMeetingBooked: (leadId: string) => void;
  onMarkMusicianBooked: (leadId: string, musicianId: string | null) => void;
  onMarkMusicianLost: (leadId: string) => void;
  onUndoMusicianPlanning: (leadId: string, targetStage: "new" | "pending_booking", hasAssignedDj: boolean) => void;
  onRemoveAvailability: (leadId: string, userId: string, label: string) => void;
  onSetAvail: (leadId: string, answer: "available" | "pass") => void;
  onRetractAvail: (leadId: string) => void;
  onUpdateLead: (id: string, patch: LeadUpdate, msg?: string) => void;
  onDeleteLead: (id: string) => void;
  onSaveNotes: (id: string, notes: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(!!highlighted);
  const [selectedDjId, setSelectedDjId] = useState(lead.assigned_dj_id || "");
  const st = leadStatus(lead);
  const s = LEAD_STATUS[st];
  const d = fmtDate(lead.event_date);
  const availDjIds = availability.filter((r) => r.lead_id === lead.id && r.response === "available").map((r) => r.dj_user_id);
  const tier = tierStr(lead);
  const unpaidPast = isPastEvent(lead) && !lead.paid_in_full && ["booked", "played"].includes(st);
  const assignedDjName = lead.assigned_dj_id ? roster.find((d) => d.id === lead.assigned_dj_id)?.display_name || "Assigned" : null;
  // Gates the musician stage/booking controls: relevant if the upgrades
  // or vision text mentions an instrument, the owner's already advanced
  // the stage by hand, or a musician's already booked on it — independent
  // of the DJ-side status, since a musician add-on can be pursued (or fall
  // through) at any point in the DJ pipeline.
  const musicianRelevant = !djView && (
    anyInstrumentMentioned(lead)
    || lead.musician_stage !== "new"
    || leadMusicians.some((lm) => lm.lead_id === lead.id)
  );
  // A musician has no way to see when the client meeting actually happens
  // — assigning the DJ is the closest real-world signal Austin has for
  // "the meeting's locked in," so it doubles as the musician-side meeting-
  // booked trigger too (only when nobody's advanced that stage already).
  const hasAvailableMusician = musicianRoster.some((m) =>
    availability.some((r) => r.lead_id === lead.id && r.dj_user_id === m.id && r.response === "available")
  );
  // These per-DJ labels aren't stored lead statuses — the lead itself is
  // "ready" or "meeting" for everyone else, but a DJ's own copy needs
  // wording that reflects where things stand specifically for them.
  const iAmMarkedAvailable = djView && st === "ready" && myAnswer === "available";
  const iAmAssignedFollowUp = djView && st === "meeting" && lead.assigned_dj_id === userId;
  const iAmAwaitingSelection = djView && st === "meeting" && !lead.assigned_dj_id && myAnswer === "available";
  // Owner's own equivalent of iAmAssignedFollowUp — once someone's
  // assigned, the client meeting itself already happened; what's left is
  // following up with that DJ to close it, not "meeting booked" (that
  // wording belongs to the still-unassigned Meetings section).
  const ownerFollowUp = !djView && st === "meeting" && !!lead.assigned_dj_id;
  // Same idea for a DJ who's passed — the lead is unchanged for everyone
  // else, but their own Archive copy should read "PASSED", not the
  // generic checking/ready label.
  const iHavePassed = djView && myAnswer === "pass" && ["checking", "ready"].includes(st);
  // And for a DJ who hasn't answered yet — this is exactly what puts a
  // lead in the "Need Availability" section, so it never overlaps with
  // any of the answered cases above.
  const iNeedToRespond = djView && ["checking", "ready"].includes(st) && !myAnswer;
  const statusLabel = !djView && ["booked", "played"].includes(st) && assignedDjName
    ? assignedDjName
    : ownerFollowUp ? "FOLLOW UP"
    : iAmAssignedFollowUp ? "FOLLOW UP"
    : iAmAwaitingSelection ? "MEETING BOOKED"
    : iAmMarkedAvailable ? "AVAILABLE"
    : iHavePassed ? "PASSED"
    : iNeedToRespond ? "DATE CHECK NEEDED" : s.label;
  const statusColor = ownerFollowUp ? T.violet
    : iAmAssignedFollowUp ? T.violet
    : iAmAwaitingSelection ? T.green
    : iAmMarkedAvailable ? T.green
    : iHavePassed ? T.dim
    : iNeedToRespond ? T.red : s.color;

  return (
    <div
      id={`lead-${lead.id}`}
      style={{
        display: "flex", background: T.surface,
        border: `1px solid ${unpaidPast ? T.red : highlighted ? T.accent : st === "ready" && !djView ? T.green + "66" : T.line}`,
        boxShadow: highlighted ? `0 0 0 3px ${T.accent}33` : unpaidPast ? `0 0 0 1px ${T.red}` : "none",
        borderRadius: 10, overflow: "hidden",
      }}
    >
      <div className="lead-date-strip" style={{ width: 190, background: T.raised, borderRight: `1px solid ${T.line}`, display: "flex", flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 18, padding: "14px 12px", flexShrink: 0 }}>
        <Lamp color={statusColor} pulse={st === "checking" || (st === "ready" && !djView)} />
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
          {d.dow && <div className="lead-date-line" style={{ fontSize: 28, fontWeight: 900, lineHeight: 1.1, whiteSpace: "nowrap", fontFamily: "var(--font-heading), serif", textAlign: "center" }}>{d.dow.toUpperCase()}</div>}
          <div className="lead-date-line" style={{ fontSize: 28, fontWeight: 900, lineHeight: 1.1, whiteSpace: "nowrap", fontFamily: "var(--font-heading), serif", textAlign: "center" }}>{d.mon} {d.day}</div>
          {d.year && <div style={{ fontSize: 11, color: T.dim, marginTop: 2, textAlign: "center" }}>{d.year}</div>}
        </div>
      </div>

      <div style={{ flex: 1, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
        {editing ? (
          <EditLeadForm
            lead={lead}
            onSave={(patch) => { onUpdateLead(lead.id, patch, "Lead updated"); setEditing(false); }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <>
        <div
          onClick={() => setExpanded((e) => !e)}
          style={{ display: "flex", flexDirection: "column", gap: 6, cursor: "pointer" }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
            <div style={{ minWidth: 0 }}>
              <div className="lead-name" style={{ fontWeight: 800, fontSize: 24, fontFamily: "var(--font-heading), serif", lineHeight: 1.15 }}>
                {djView
                  ? [lead.client_name, lead.fiance_name].filter(Boolean).join(" + ") || tier || "Gig"
                  : [lead.client_name, lead.fiance_name].filter(Boolean).join(" + ") || "Unnamed lead"}
              </div>
              {(lead.dj_tier || lead.prod_tier) && (
                <div className="lead-tier" style={{ fontWeight: 700, fontSize: 19, fontFamily: "var(--font-heading), serif", lineHeight: 1.2, marginTop: 2 }}>
                  {lead.dj_tier && <span style={{ color: TIER_COLORS[lead.dj_tier] || T.blue }}>{lead.dj_tier}</span>}
                  {lead.dj_tier && lead.prod_tier && <span style={{ color: T.dim }}> + </span>}
                  {lead.prod_tier && <span style={{ color: TIER_COLORS[lead.prod_tier] || T.blue }}>{lead.prod_tier}</span>}
                </div>
              )}
              <div style={{ fontSize: 12.5, color: T.dim, marginTop: 4 }}>
                {lead.location || "location TBD"}
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
              {!djView && lead.needs_review && <Tag color={T.violet}>NEEDS REVIEW</Tag>}
              {unpaidPast && <Tag color={T.red}>UNPAID</Tag>}
              {musicianRelevant && !["booked", "played"].includes(st) && (
                <Tag color={musicianStageDisplay(lead).color}>
                  {lead.musician_stage === "new" ? "MUSICIAN REQUESTED" : `MUSICIAN: ${musicianStageDisplay(lead).label}`}
                </Tag>
              )}
              {!djView && lead.assigned_dj_id && !["booked", "played"].includes(st) && <Tag color={T.violet}>DJ: {assignedDjName}</Tag>}
              {["booked", "played"].includes(st) && <BookedMusicianTags musicians={lead.booked_musicians} />}
              <Tag color={statusColor}>{statusLabel}</Tag>
              <span style={{ color: T.dim, fontSize: 11, marginLeft: 2 }}>{expanded ? "▴" : "▾"}</span>
            </div>
          </div>
          {(totalPayout(lead) > 0 || lead.vibo_link) && (
            <div className="lead-total-row" style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 10 }}>
              {totalPayout(lead) > 0 && (
                <div style={{ fontSize: 20, fontWeight: 900, color: T.text }}>
                  ${totalPayout(lead)}
                </div>
              )}
              {lead.vibo_link && (
                <a
                  href={lead.vibo_link}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 800, letterSpacing: "0.06em", color: T.accent, textDecoration: "none" }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- tiny fixed-size icon, not worth next/image's overhead */}
                  <img src="/vibo-icon.png" alt="" style={{ width: 14, height: 14 }} />
                  VIBO
                </a>
              )}
            </div>
          )}
        </div>

        {expanded && djView && (lead.deposit_paid || lead.paid_in_full) && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {lead.deposit_paid && <Tag color={T.green}>DEPOSIT PAID</Tag>}
            {lead.paid_in_full && <Tag color={T.green}>PAID IN FULL</Tag>}
          </div>
        )}

        {expanded && djView && lead.contact && (
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 12.5, color: T.dim, alignItems: "center" }}>
            <span>{lead.contact}</span>
          </div>
        )}

        {expanded && !djView && ["meeting", "booked", "played"].includes(st) && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", opacity: busy ? 0.5 : 1, pointerEvents: busy ? "none" : "auto" }}>
            <Btn
              kind={lead.deposit_paid ? "green" : "ghost"}
              small
              onClick={() => onUpdateLead(lead.id, { deposit_paid: !lead.deposit_paid }, lead.deposit_paid ? "Deposit unmarked" : "Deposit marked paid")}
            >
              {lead.deposit_paid ? "✓ " : ""}DEPOSIT PAID
            </Btn>
            <Btn
              kind={lead.paid_in_full ? "green" : "ghost"}
              small
              onClick={() => onUpdateLead(lead.id, { paid_in_full: !lead.paid_in_full }, lead.paid_in_full ? "Unmarked paid in full" : "Marked paid in full")}
            >
              {lead.paid_in_full ? "✓ " : ""}PAID IN FULL
            </Btn>
          </div>
        )}

        {expanded && !djView && (
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 12.5, color: T.dim, alignItems: "center" }}>
            {lead.contact && <span>{lead.contact}</span>}
            {lead.assigned_dj_id && !["booked", "played"].includes(st) && (
              <span>DJ: <span style={{ color: T.text, fontWeight: 700 }}>
                {assignedDjName}
              </span></span>
            )}
            <PayoutEditor lead={lead} onSave={(id, payout) => onUpdateLead(id, { payout }, "Payout updated")} />
          </div>
        )}

        {expanded && !djView && (
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 12.5, color: T.dim, alignItems: "center" }}>
            <ViboLinkEditor lead={lead} onSave={(id, viboLink) => onUpdateLead(id, { vibo_link: viboLink }, "Vibo link updated")} />
          </div>
        )}

        {expanded && !djView && (
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 12.5, color: T.dim, alignItems: "center" }}>
            <TravelEditor
              lead={lead}
              onSave={(id, patch) => onUpdateLead(id, patch, "Travel updated")}
            />
            {totalPayout(lead) > 0 && (
              <span>Total: <strong style={{ color: T.text }}>${totalPayout(lead)}</strong></span>
            )}
          </div>
        )}

        {expanded && lead.upgrades && (
          <div style={{ fontSize: 12.5, color: T.accent }}>
            <span style={{ color: T.dim, fontWeight: 700, letterSpacing: "0.1em", fontSize: 10.5 }}>UPGRADES </span>
            {lead.upgrades}
          </div>
        )}
        {expanded && lead.client_vision && (
          <div style={{ fontSize: 12.5, color: T.dim, whiteSpace: "pre-wrap", borderLeft: `2px solid ${T.line}`, paddingLeft: 8 }}>
            {lead.client_vision}
          </div>
        )}
        {expanded && djView && lead.dj_notes && <div style={{ fontSize: 12.5, color: T.dim, whiteSpace: "pre-wrap" }}>{lead.dj_notes}</div>}

        {expanded && !djView && ["checking", "ready", "meeting"].includes(st) && <AvailChips lead={lead} roster={roster} musicianRoster={musicianRoster} rosterProfiles={rosterProfiles} availability={availability} onRemove={onRemoveAvailability} />}

        {expanded && ["meeting", "booked", "played"].includes(st) && <MeetingNotesEditor lead={lead} onSave={onSaveNotes} />}

        {expanded && musicianRelevant && (
          <MusicianStageActions
            lead={lead}
            musicianRoster={musicianRoster}
            availability={availability}
            leadMusicians={leadMusicians}
            onMeetingBooked={onMusicianMeetingBooked}
            onMarkBooked={onMarkMusicianBooked}
            onMarkLost={onMarkMusicianLost}
            onUndoPlanning={onUndoMusicianPlanning}
          />
        )}

        {expanded && musicianRelevant && (
          <MusicianBooking
            leadId={lead.id}
            musicianRoster={musicianRoster}
            rosterProfiles={rosterProfiles}
            bookings={leadMusicians.filter((lm) => lm.lead_id === lead.id)}
            availability={availability}
            musicianStage={lead.musician_stage}
            onBook={onBookMusician}
            onUnbook={onUnbookMusician}
            onUpdate={onUpdateMusicianBooking}
            onAddToHold={onAddMusicianToHold}
            disableNewBookings={lead.status !== "booked"}
          />
        )}

        {expanded && !djView && <LeadHistory leadId={lead.id} roster={roster} userId={userId} onFetch={onFetchHistory} />}

        {expanded && (
        <div style={{ display: "flex", gap: 8, marginTop: 2, alignItems: "center", justifyContent: "space-between", opacity: busy ? 0.5 : 1, pointerEvents: busy ? "none" : "auto", transition: "opacity 120ms" }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {!djView && lead.needs_review && (
            <Btn kind="green" small onClick={() => onUpdateLead(lead.id, { needs_review: false }, "Reviewed — live on the board")}>
              ✓ APPROVE
            </Btn>
          )}
          {["checking", "ready"].includes(st) && (djView || lead.dj_tier === "Headliner") && (
            <>
              <Btn
                kind={myAnswer === "available" ? "green" : "primary"}
                small
                onClick={() => (myAnswer === "available" ? onRetractAvail(lead.id) : onSetAvail(lead.id, "available"))}
              >
                {myAnswer === "available" ? "✓ I'M AVAILABLE" : "I'M AVAILABLE"}
              </Btn>
              <Btn
                kind={myAnswer === "pass" ? "danger" : "ghost"}
                small
                onClick={() => (myAnswer === "pass" ? onRetractAvail(lead.id) : onSetAvail(lead.id, "pass"))}
              >
                {myAnswer === "pass" ? "✕ PASSED" : "PASS"}
              </Btn>
            </>
          )}
          {/* Meeting's booked but Austin hasn't picked a DJ yet — clicking
              the already-checked button unchecks it, same as above, rather
              than a separate undo action. */}
          {djView && st === "meeting" && !lead.assigned_dj_id && myAnswer === "available" && (
            <Btn kind="green" small onClick={() => onRetractAvail(lead.id)}>{"✓ I'M AVAILABLE"}</Btn>
          )}

          {!djView && st === "ready" && (
            <Btn kind="green" small onClick={() => onUpdateLead(lead.id, { status: "meeting" }, "Marked: meeting booked")}>
              MEETING BOOKED →
            </Btn>
          )}
          {!djView && st === "meeting" && (
            <>
              <Select
                value={selectedDjId}
                onChange={(e) => setSelectedDjId(e.target.value)}
                style={{ width: "auto", fontSize: 12, padding: "6px 8px" }}
              >
                <option value="">Assign DJ…</option>
                {/* Austin (owner-as-assignable) never answers date checks, so he'd
                    get filtered out by the availability check below like any other
                    non-responder — always keep him selectable regardless. */}
                {(availDjIds.length ? roster.filter((d) => availDjIds.includes(d.id) || d.id === userId) : roster).map((d) => (
                  <option key={d.id} value={d.id}>{d.display_name || d.email}{availDjIds.includes(d.id) ? " (available)" : ""}</option>
                ))}
              </Select>
              <Btn
                kind="primary"
                small
                disabled={!selectedDjId || selectedDjId === lead.assigned_dj_id}
                onClick={() => {
                  const name = roster.find((d) => d.id === selectedDjId)?.display_name || "DJ";
                  const patch: LeadUpdate = { assigned_dj_id: selectedDjId };
                  if (lead.musician_stage === "new" && hasAvailableMusician) {
                    patch.musician_stage = "pending_booking";
                    patch.musician_meeting_date = new Date().toISOString().slice(0, 10);
                  }
                  onUpdateLead(lead.id, patch, `${name} assigned — waiting on booking`);
                }}
              >
                DJ ASSIGNED →
              </Btn>
            </>
          )}
          {!djView && st === "meeting" && lead.assigned_dj_id && (
            <Btn kind="green" small onClick={() => onUpdateLead(lead.id, { status: "booked" }, `Booked — ${assignedDjName} is on it`)}>
              MARK BOOKED →
            </Btn>
          )}
          {!djView && st === "meeting" && (
            <Btn kind="ghost" small onClick={() => onUpdateLead(lead.id, { status: "checking" }, "Back to pipeline")}>
              ← BACK TO PIPELINE
            </Btn>
          )}
          {!djView && st === "booked" && (
            <Btn kind="ghost" small onClick={() => onUpdateLead(lead.id, { status: "played" }, "Marked as completed")}>
              MARK COMPLETED
            </Btn>
          )}
          {!djView && st === "booked" && (
            <Btn kind="ghost" small onClick={() => onUpdateLead(lead.id, { status: "meeting" }, "Back to meeting")}>
              ↩ BACK TO MEETING
            </Btn>
          )}
          {!djView && !["lost", "played"].includes(st) && (
            <Btn kind="ghost" small style={{ color: T.red, borderColor: T.red + "44" }} onClick={() => onUpdateLead(lead.id, { status: "lost" }, "Marked lost")}>
              LOST
            </Btn>
          )}
          {!djView && st === "played" && (
            <Btn kind="ghost" small onClick={() => onUpdateLead(lead.id, { status: "booked" }, "Back to booked")}>
              ↩ BACK TO BOOKED
            </Btn>
          )}
          {!djView && st === "lost" && (
            <Btn kind="ghost" small onClick={() => onUpdateLead(lead.id, { status: "checking" }, "Reopened — back to pipeline")}>
              ↩ REOPEN
            </Btn>
          )}
          {!djView && (
            <Btn kind="ghost" small onClick={() => setEditing(true)}>EDIT</Btn>
          )}
        </div>
        {!djView && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
            {lead.source && (
              <span style={{ fontSize: 12.5, color: T.dim }}>
                {new Date(lead.created_at).toLocaleDateString("en-US")} via {lead.source}
              </span>
            )}
            <Btn kind="danger" small onClick={() => onDeleteLead(lead.id)}>DELETE</Btn>
          </div>
        )}
        </div>
        )}
          </>
        )}
      </div>
    </div>
  );
}

function ImportForm({
  onSave, onCancel, ping, companySettings,
}: {
  onSave: (fields: LeadInsert) => void;
  onCancel: () => void;
  ping: (m: string) => void;
  companySettings: CompanySettings | null;
}) {
  const [raw, setRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [parsed, setParsed] = useState<null | {
    name: string; fianceName: string; contact: string; date: string; location: string;
    djTier: string; prodTier: string; upgrades: string; vision: string; payout: string;
    travelZone: string; travelRate: string;
  }>(null);

  const parse = async () => {
    if (!raw.trim()) return;
    setBusy(true);
    try {
      const res = await fetch("/api/parse-lead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw }),
      });
      const data = await res.json();
      if (!res.ok) { ping(data.error || "Couldn't parse that — you can add it manually"); setBusy(false); return; }
      const suggestedPayout = data.djTier && data.prodTier ? tierRate(companySettings, data.djTier, data.prodTier) : 0;
      const zone = data.travelZone || guessTravelZone(data.location || "") || "";
      const suggestedTravel = zone ? travelRate(companySettings, zone) : 0;
      setParsed({
        ...data,
        fianceName: data.fiance || "",
        payout: suggestedPayout ? String(suggestedPayout) : "",
        travelZone: zone,
        travelRate: suggestedTravel ? String(suggestedTravel) : "",
      });
    } catch {
      ping("Couldn't parse that — you can add it manually");
    }
    setBusy(false);
  };

  const save = () => {
    if (!parsed) return;
    onSave({
      client_name: parsed.name, fiance_name: parsed.fianceName, contact: parsed.contact, event_date: parsed.date || null,
      location: parsed.location, dj_tier: (parsed.djTier || null) as DjTier | null,
      prod_tier: (parsed.prodTier || null) as ProdTier | null, upgrades: parsed.upgrades,
      client_vision: parsed.vision, source: "honeybook", status: "checking",
      payout: parsed.payout ? Number(parsed.payout) : null,
      travel_zone: (parsed.travelZone || null) as TravelZone | null,
      travel_rate: parsed.travelRate ? Number(parsed.travelRate) : null,
    });
  };

  return (
    <div style={{ background: T.raised, border: `1px solid ${T.teal}55`, borderRadius: 10, padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontWeight: 800, letterSpacing: "0.1em", fontSize: 12, color: T.accent }}>IMPORT FROM HONEYBOOK</div>
      <div style={{ fontSize: 12.5, color: T.dim }}>
        Paste the HoneyBook inquiry notification (the email text or the inquiry details) and it&apos;ll be parsed into a lead automatically.
      </div>
      <TextArea value={raw} onChange={(e) => setRaw(e.target.value)} placeholder="Paste the whole inquiry here…" style={{ minHeight: 110 }} />
      {!parsed ? (
        <div style={{ display: "flex", gap: 8 }}>
          <Btn kind="primary" onClick={parse} disabled={busy}>{busy ? "PARSING…" : "PARSE INQUIRY"}</Btn>
          <Btn onClick={onCancel}>CANCEL</Btn>
        </div>
      ) : (
        <>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.14em", color: T.green }}>CHECK IT BEFORE IT GOES LIVE</div>
          <SectionLabel>CLIENT</SectionLabel>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <Field label="CLIENT"><Input value={parsed.name} onChange={(e) => setParsed({ ...parsed, name: e.target.value })} /></Field>
            <Field label="FIANCÉ / PARTNER"><Input value={parsed.fianceName} onChange={(e) => setParsed({ ...parsed, fianceName: e.target.value })} /></Field>
            <Field label="EVENT DATE"><Input type="date" value={parsed.date} onChange={(e) => setParsed({ ...parsed, date: e.target.value })} /></Field>
          </div>
          <SectionLabel>EVENT</SectionLabel>
          <Field label="LOCATION"><Input value={parsed.location} onChange={(e) => setParsed({ ...parsed, location: e.target.value })} placeholder="The Colony House, Anaheim" /></Field>
          <TierPicker djTier={parsed.djTier} prodTier={parsed.prodTier} onChange={({ djTier, prodTier }) => {
            const next = { ...parsed, djTier, prodTier };
            if (!parsed.payout && djTier && djTier !== "Any" && prodTier) next.payout = String(tierRate(companySettings, djTier, prodTier));
            setParsed(next);
          }} />
          <SectionLabel>PRICING</SectionLabel>
          <Field label="DJ PAYOUT ($) — SHOWN TO DJs">
            <div style={{ display: "flex", gap: 6 }}>
              <Input type="number" value={parsed.payout} onChange={(e) => setParsed({ ...parsed, payout: e.target.value })} style={{ flex: 1 }} />
              {parsed.djTier && parsed.djTier !== "Any" && parsed.prodTier && (
                <Btn small onClick={() => setParsed({ ...parsed, payout: String(tierRate(companySettings, parsed.djTier, parsed.prodTier)) })}>
                  USE ${tierRate(companySettings, parsed.djTier, parsed.prodTier)}
                </Btn>
              )}
            </div>
          </Field>
          <Field label="TRAVEL FEE ($) — ESTIMATED FROM LOCATION">
            <Input type="number" value={parsed.travelRate} onChange={(e) => setParsed({ ...parsed, travelRate: e.target.value })} />
          </Field>
          <SectionLabel>DETAILS</SectionLabel>
          <Field label="UPGRADES"><Input value={parsed.upgrades} onChange={(e) => setParsed({ ...parsed, upgrades: e.target.value })} placeholder="Guac Booth, CO2, cold sparks…" /></Field>
          <Field label="CLIENT VISION"><TextArea value={parsed.vision} onChange={(e) => setParsed({ ...parsed, vision: e.target.value })} /></Field>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn kind="primary" onClick={save}>PUT IT ON THE BOARD</Btn>
            <Btn onClick={() => setParsed(null)}>RE-PARSE</Btn>
          </div>
        </>
      )}
    </div>
  );
}

function ManualForm({
  onSave, onCancel, ping, companySettings,
}: {
  onSave: (fields: LeadInsert) => void;
  onCancel: () => void;
  ping: (m: string) => void;
  companySettings: CompanySettings | null;
}) {
  const [f, setF] = useState({
    name: "", fianceName: "", contact: "", date: "", location: "", djTier: "", prodTier: "",
    upgrades: "", vision: "", source: "", djNotes: "", payout: "",
    travelZone: "", travelRate: "",
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <div style={{ background: T.raised, border: `1px solid ${T.line}`, borderRadius: 10, padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontWeight: 800, letterSpacing: "0.1em", fontSize: 12, color: T.accent }}>ADD LEAD MANUALLY</div>
      <SectionLabel>CLIENT</SectionLabel>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Field label="CLIENT"><Input value={f.name} onChange={set("name")} placeholder="Jess" /></Field>
        <Field label="FIANCÉ / PARTNER"><Input value={f.fianceName} onChange={set("fianceName")} placeholder="Marco" /></Field>
        <Field label="CONTACT"><Input value={f.contact} onChange={set("contact")} placeholder="email or phone" /></Field>
        <Field label="EVENT DATE"><Input type="date" value={f.date} onChange={set("date")} /></Field>
      </div>
      <SectionLabel>EVENT</SectionLabel>
      <Field label="LOCATION">
        <Input
          value={f.location}
          onChange={(e) => {
            const location = e.target.value;
            const next = { ...f, location };
            if (!f.travelZone) {
              const guessed = guessTravelZone(location);
              if (guessed) { next.travelZone = guessed; next.travelRate = String(travelRate(companySettings, guessed)); }
            }
            setF(next);
          }}
          placeholder="The Colony House, Anaheim"
        />
      </Field>
      <TierPicker djTier={f.djTier} prodTier={f.prodTier} onChange={({ djTier, prodTier }) => {
        const next = { ...f, djTier, prodTier };
        if (!f.payout && djTier && djTier !== "Any" && prodTier) next.payout = String(tierRate(companySettings, djTier, prodTier));
        setF(next);
      }} />
      <Field label="UPGRADES"><Input value={f.upgrades} onChange={set("upgrades")} placeholder="Guac Booth, CO2, uplighting…" /></Field>
      <Field label="CLIENT VISION"><TextArea value={f.vision} onChange={set("vision")} /></Field>
      <SectionLabel>PRICING</SectionLabel>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Field label="SOURCE"><Input value={f.source} onChange={set("source")} placeholder="HoneyBook / IG / referral" /></Field>
        <Field label="DJ PAYOUT ($) — SHOWN TO DJs">
          <div style={{ display: "flex", gap: 6 }}>
            <Input type="number" value={f.payout} onChange={set("payout")} style={{ flex: 1 }} />
            {f.djTier && f.djTier !== "Any" && f.prodTier && (
              <Btn small onClick={() => setF({ ...f, payout: String(tierRate(companySettings, f.djTier, f.prodTier)) })}>
                USE ${tierRate(companySettings, f.djTier, f.prodTier)}
              </Btn>
            )}
          </div>
        </Field>
        <Field label="TRAVEL FEE ($) — ESTIMATED FROM LOCATION">
          <Input type="number" value={f.travelRate} onChange={set("travelRate")} />
        </Field>
      </div>
      <SectionLabel>NOTES</SectionLabel>
      <Field label="NOTES FOR DJs (SHOWN ON DATE CHECK)"><TextArea value={f.djNotes} onChange={set("djNotes")} placeholder="Outdoor ceremony, load-in 3pm…" /></Field>
      <div style={{ display: "flex", gap: 8 }}>
        <Btn kind="primary" onClick={() => {
          if (!f.name.trim() && !f.date) { ping("Give it at least a name or a date"); return; }
          onSave({
            client_name: f.name, fiance_name: f.fianceName, contact: f.contact, event_date: f.date || null, location: f.location,
            dj_tier: (f.djTier || null) as DjTier | null, prod_tier: (f.prodTier || null) as ProdTier | null,
            upgrades: f.upgrades, client_vision: f.vision, source: "manual",
            dj_notes: f.djNotes, payout: f.payout ? Number(f.payout) : null, status: "checking",
            travel_zone: (f.travelZone || null) as TravelZone | null,
            travel_rate: f.travelRate ? Number(f.travelRate) : null,
          });
        }}>SAVE LEAD</Btn>
        <Btn onClick={onCancel}>CANCEL</Btn>
      </div>
    </div>
  );
}

function generatePassword() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  return Array.from({ length: 10 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

// Self-service — a DJ uploads their own photo directly to Storage (RLS on
// the bucket restricts writes to the uploader's own folder or the owner),
// no server route needed. Upsert-by-fixed-filename means re-uploading
// just replaces the old photo rather than accumulating orphaned files.
function AvatarUpload({
  userId, currentUrl, onChanged, ping,
}: { userId: string; currentUrl: string | null; onChanged: () => void; ping: (m: string) => void }) {
  const supabase = useMemo(() => createClient(), []);
  const [uploading, setUploading] = useState(false);

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) { ping("Please pick an image file"); return; }
    setUploading(true);
    const ext = file.name.split(".").pop()?.toLowerCase() || "jpg";
    const path = `${userId}/avatar.${ext}`;
    const { error: uploadError } = await supabase.storage.from("avatars").upload(path, file, { upsert: true, cacheControl: "3600" });
    if (uploadError) { ping(uploadError.message || "Couldn't upload photo"); setUploading(false); return; }
    const { data } = supabase.storage.from("avatars").getPublicUrl(path);
    // Cache-bust so the new photo shows immediately instead of the
    // browser reusing whatever it already cached at this same URL.
    const url = `${data.publicUrl}?t=${Date.now()}`;
    const { error } = await supabase.from("dj_profiles").update({ avatar_url: url }).eq("user_id", userId);
    setUploading(false);
    if (error) { ping(error.message || "Couldn't save photo"); return; }
    ping("Photo updated");
    onChanged();
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <Avatar url={currentUrl} name="Your photo" size={44} />
      <label style={{ cursor: uploading ? "default" : "pointer" }}>
        <input type="file" accept="image/*" onChange={handleFile} disabled={uploading} style={{ display: "none" }} />
        <span style={{
          fontFamily: "inherit", fontSize: 12, fontWeight: 700, letterSpacing: "0.04em",
          padding: "6px 12px", borderRadius: 6, border: `1px solid ${T.line}`, color: T.dim,
        }}>
          {uploading ? "UPLOADING…" : currentUrl ? "CHANGE PHOTO" : "UPLOAD PHOTO"}
        </span>
      </label>
    </div>
  );
}

function RosterEmailEditor({
  userId, currentEmail, onChanged, ping,
}: { userId: string; currentEmail: string; onChanged: () => void; ping: (m: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(currentEmail);
  const [busy, setBusy] = useState(false);

  if (!editing) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 12, color: T.dim }}>{currentEmail}</span>
        <button
          onClick={() => { setValue(currentEmail); setEditing(true); }}
          style={{ fontFamily: "inherit", background: "none", border: "none", color: T.dim, textDecoration: "underline", fontSize: 11, cursor: "pointer", padding: 0 }}
        >
          EDIT
        </button>
      </div>
    );
  }

  const save = async () => {
    const trimmed = value.trim();
    if (!trimmed || trimmed === currentEmail) { setEditing(false); return; }
    setBusy(true);
    const res = await fetch(`/api/roster/${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: trimmed }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { ping(data.error || "Couldn't update the email — try again"); return; }
    ping("Email updated — they'll log in with the new address next time");
    setEditing(false);
    onChanged();
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        type="email"
        disabled={busy}
        style={{ fontSize: 12, padding: "4px 8px", width: "auto", minWidth: 190 }}
      />
      <Btn small kind="primary" onClick={save} disabled={busy}>{busy ? "SAVING…" : "SAVE"}</Btn>
      <Btn small onClick={() => setEditing(false)} disabled={busy}>CANCEL</Btn>
    </div>
  );
}

// Tucked at the bottom of Roster behind a plain text toggle rather than
// its own tab — this is a debugging/audit tool Austin reaches for
// occasionally, not something that needs top-level nav real estate.
function EmailLogSection({ ping }: { ping: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [emails, setEmails] = useState<{ id: string; to_email: string; subject: string; html: string; failed: boolean; created_at: string }[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [hours, setHours] = useState(48);

  const load = async (h: number) => {
    setLoading(true);
    const res = await fetch(`/api/email-log?hours=${h}`);
    const data = await res.json().catch(() => ({}));
    setLoading(false);
    if (!res.ok) { ping(data.error || "Couldn't load the email log"); return; }
    setEmails(data.emails ?? []);
  };

  const toggleOpen = () => {
    const next = !open;
    setOpen(next);
    if (next) load(hours);
  };

  const changeWindow = (h: number) => {
    setHours(h);
    load(h);
  };

  const windows = [{ label: "48H", h: 48 }, { label: "7 DAYS", h: 24 * 7 }, { label: "30 DAYS", h: 24 * 30 }];

  return (
    <div style={{ marginTop: 4, paddingTop: 14, borderTop: `1px solid ${T.line}` }}>
      <button
        onClick={toggleOpen}
        style={{ background: "none", border: "none", color: T.dim, fontSize: 11.5, fontFamily: "inherit", cursor: "pointer", textDecoration: "underline", padding: 0 }}
      >
        {open ? "Hide email log" : "Show email log"}
      </button>
      {open && (
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", gap: 6 }}>
            {windows.map((w) => (
              <button
                key={w.h}
                onClick={() => changeWindow(w.h)}
                style={{
                  fontFamily: "inherit", fontSize: 11, fontWeight: 700, letterSpacing: "0.04em",
                  padding: "4px 10px", borderRadius: 20, cursor: "pointer",
                  background: hours === w.h ? T.teal : "transparent",
                  color: hours === w.h ? T.text : T.dim,
                  border: `1px solid ${hours === w.h ? T.teal : T.line}`,
                }}
              >
                {w.label}
              </button>
            ))}
          </div>
          {loading && <div style={{ fontSize: 12, color: T.dim }}>Loading…</div>}
          {!loading && emails.length === 0 && <Empty text="No emails sent in this window." />}
          {!loading && emails.map((e) => {
            const expanded = expandedId === e.id;
            return (
              <div key={e.id} style={{ background: T.surface, border: `1px solid ${T.line}`, borderRadius: 8, padding: "10px 14px" }}>
                <div
                  onClick={() => setExpandedId(expanded ? null : e.id)}
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, cursor: "pointer" }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 13 }}>{e.subject}</div>
                    <div style={{ fontSize: 11.5, color: T.dim }}>{e.to_email}</div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                    {e.failed && <Tag color={T.red}>FAILED</Tag>}
                    <span style={{ fontSize: 11, color: T.dim, whiteSpace: "nowrap" }}>{new Date(e.created_at).toLocaleString("en-US")}</span>
                    <span style={{ color: T.dim }}>{expanded ? "▲" : "▼"}</span>
                  </div>
                </div>
                {expanded && (
                  <iframe
                    // Empty sandbox — no scripts, forms, or same-origin access.
                    // Some fields these emails interpolate (e.g. a lead's
                    // location) aren't HTML-escaped, so this is rendered as an
                    // untrusted document rather than trusted app content.
                    sandbox=""
                    srcDoc={e.html}
                    style={{ marginTop: 10, width: "100%", height: 260, border: `1px solid ${T.line}`, borderRadius: 6, background: "#fff" }}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Roster({
  roster, musicianRoster, rosterProfiles, leads, leadMusicians, onChanged, onSetTiers, onSetNotify, onSetInstrument, ping, confirm,
}: {
  roster: RosterUser[];
  musicianRoster: RosterUser[];
  rosterProfiles: { user_id: string; dj_tier_visibility: DjTier[]; instrument: Instrument | null; notify_email: boolean }[];
  leads: LeadRow[];
  leadMusicians: LeadMusicianRow[];
  onChanged: () => void;
  onSetTiers: (djId: string, tiers: DjTier[]) => void;
  onSetNotify: (djId: string, enabled: boolean) => void;
  onSetInstrument: (musicianId: string, instrument: Instrument) => void;
  ping: (m: string) => void;
  confirm: (message: string, confirmLabel: string) => Promise<boolean>;
}) {
  const [newRole, setNewRole] = useState<"dj" | "musician">("dj");
  const [instrument, setInstrument] = useState<Instrument | "">("");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ email: string; password: string; name: string } | null>(null);

  const create = async () => {
    if (!email.trim() || password.length < 8) return;
    if (newRole === "musician" && !instrument) { ping("Pick an instrument for this musician"); return; }
    setBusy(true);
    const res = await fetch("/api/roster", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim(), displayName: name.trim() || null, password, role: newRole, instrument: newRole === "musician" ? instrument : undefined }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) { ping(data.error || "Couldn't create that account"); return; }
    setCreated({ email: email.trim(), password, name: name.trim() });
    setEmail(""); setName(""); setPassword(""); setInstrument("");
    onChanged();
  };

  const remove = async (id: string, label: string) => {
    const ok = await confirm(`Remove ${label} from the roster? This can't be undone.`, "Remove");
    if (!ok) return;
    const res = await fetch(`/api/roster/${id}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { ping(data.error || "Couldn't remove — try again"); return; }
    ping("Removed");
    onChanged();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", gap: 6 }}>
        {(["dj", "musician"] as const).map((r) => (
          <button
            key={r}
            onClick={() => { setNewRole(r); setInstrument(""); }}
            style={{
              fontFamily: "inherit", fontSize: 12, fontWeight: 700, letterSpacing: "0.04em",
              padding: "5px 12px", borderRadius: 20, cursor: "pointer",
              background: newRole === r ? T.teal : "transparent",
              color: T.text,
              border: `1px solid ${newRole === r ? T.teal : T.line}`,
            }}
          >
            {r === "dj" ? "DJ" : "MUSICIAN"}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={newRole === "dj" ? "DJ name (e.g., DJ Marcus)" : "Musician name"} style={{ flex: 1, minWidth: 160 }} />
        <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email@example.com" type="email" style={{ flex: 1, minWidth: 200 }} />
        <Input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password (8+ chars)" style={{ flex: 1, minWidth: 160 }} />
        {newRole === "musician" && (
          <Select value={instrument} onChange={(e) => setInstrument(e.target.value as Instrument)} style={{ flex: 1, minWidth: 160 }}>
            <option value="">Pick instrument…</option>
            {MUSICIAN_INSTRUMENTS.map((i) => <option key={i} value={i}>{i}</option>)}
          </Select>
        )}
        <Btn onClick={() => setPassword(generatePassword())}>GENERATE</Btn>
        <Btn kind="primary" onClick={create} disabled={busy}>{busy ? "ADDING…" : newRole === "dj" ? "ADD DJ" : "ADD MUSICIAN"}</Btn>
      </div>
      {created && (
        <div style={{ background: T.raised, border: `1px solid ${T.green}66`, borderRadius: 8, padding: 14, fontSize: 13 }}>
          <div style={{ fontWeight: 800, color: T.green, marginBottom: 6 }}>ACCOUNT CREATED — TELL {(created.name || created.email).toUpperCase()}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span>Email: <strong>{created.email}</strong></span>
            <Btn small ariaLabel="Copy email" onClick={() => { navigator.clipboard.writeText(created.email); ping("Email copied"); }}>COPY</Btn>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
            <span>Password: <strong>{created.password}</strong></span>
            <Btn small ariaLabel="Copy password" onClick={() => { navigator.clipboard.writeText(created.password); ping("Password copied"); }}>COPY</Btn>
          </div>
          <div style={{ color: T.dim, marginTop: 6, fontSize: 12 }}>Copy this down now — it won&apos;t be shown again here.</div>
          <Btn small style={{ marginTop: 8 }} onClick={() => setCreated(null)}>DISMISS</Btn>
        </div>
      )}
      <SectionLabel>DJS</SectionLabel>
      {roster.length === 0 && <Empty text="No DJs yet. Add your Residents and Associates with an email + password, then tell them what it is." />}
      {roster.map((dj) => {
        const profile = rosterProfiles.find((p) => p.user_id === dj.id);
        const tiers = profile?.dj_tier_visibility ?? [];
        const notifyEnabled = profile?.notify_email ?? false;
        // assigned_dj_id alone isn't enough — a lead can be assigned during
        // the meeting stage (Pending) before it's actually marked booked,
        // so counting every assignment here would credit a DJ for gigs
        // that were never confirmed.
        const djLeads = leads.filter((l) => l.assigned_dj_id === dj.id && ["booked", "played"].includes(leadStatus(l)));
        const bookingCount = djLeads.length;
        const bookingTotal = djLeads.reduce((sum, l) => sum + totalPayout(l), 0);
        return (
          <div key={dj.id} style={{ background: T.surface, border: `1px solid ${T.line}`, borderRadius: 8, padding: "10px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
              <div>
                <div style={{ fontWeight: 700 }}>{dj.display_name || "(pending sign-in)"}</div>
                <RosterEmailEditor userId={dj.id} currentEmail={dj.email} onChanged={onChanged} ping={ping} />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ fontSize: 12, color: T.dim, textAlign: "right", whiteSpace: "nowrap" }}>
                  {bookingCount} gig{bookingCount !== 1 ? "s" : ""}{bookingTotal ? ` · $${bookingTotal}` : ""}
                </div>
                <Btn kind="danger" small onClick={() => remove(dj.id, dj.display_name || dj.email)}>REMOVE</Btn>
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.14em", color: T.dim }}>TIERS</span>
              {DJ_TIERS.map((t) => {
                const active = tiers.includes(t);
                return (
                  <button
                    key={t}
                    onClick={() => onSetTiers(dj.id, active ? tiers.filter((x) => x !== t) : [...tiers, t])}
                    style={{
                      fontFamily: "inherit", fontSize: 12, fontWeight: 700, letterSpacing: "0.04em",
                      padding: "4px 10px", borderRadius: 20, cursor: "pointer",
                      background: active ? T.teal : "transparent",
                      color: active ? T.text : T.dim,
                      border: `1px solid ${active ? T.teal : T.line}`,
                    }}
                  >
                    {t}
                  </button>
                );
              })}
              {tiers.length === 0 && <span style={{ fontSize: 11, color: T.red }}>not qualified for any tier yet</span>}
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.14em", color: T.dim }}>NOTIFICATION EMAILS</span>
              <button
                onClick={() => onSetNotify(dj.id, !notifyEnabled)}
                style={{
                  fontFamily: "inherit", fontSize: 12, fontWeight: 700, letterSpacing: "0.04em",
                  padding: "4px 10px", borderRadius: 20, cursor: "pointer",
                  background: notifyEnabled ? T.green : "transparent",
                  color: notifyEnabled ? "#06210F" : T.dim,
                  border: `1px solid ${notifyEnabled ? T.green : T.line}`,
                }}
              >
                {notifyEnabled ? "ON — LIVE FOR THIS DJ" : "OFF — TESTING ONLY"}
              </button>
            </div>
          </div>
        );
      })}

      <SectionLabel>MUSICIANS</SectionLabel>
      {musicianRoster.length === 0 && <Empty text="No musicians yet. Add your Saxophonist and Violinist with an email + password, then tell them what it is." />}
      {musicianRoster.map((m) => {
        const profile = rosterProfiles.find((p) => p.user_id === m.id);
        const notifyEnabled = profile?.notify_email ?? false;
        const bookings = leadMusicians.filter((lm) => lm.musician_id === m.id);
        const bookingCount = bookings.length;
        const bookingTotal = bookings.reduce((sum, lm) => sum + (lm.payout || 0), 0);
        return (
          <div key={m.id} style={{ background: T.surface, border: `1px solid ${T.line}`, borderRadius: 8, padding: "10px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
              <div>
                <div style={{ fontWeight: 700, display: "flex", alignItems: "center", gap: 8 }}>
                  {m.display_name || "(pending sign-in)"}
                </div>
                <RosterEmailEditor userId={m.id} currentEmail={m.email} onChanged={onChanged} ping={ping} />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ fontSize: 12, color: T.dim, textAlign: "right", whiteSpace: "nowrap" }}>
                  {bookingCount} gig{bookingCount !== 1 ? "s" : ""}{bookingTotal ? ` · $${bookingTotal}` : ""}
                </div>
                <Btn kind="danger" small onClick={() => remove(m.id, m.display_name || m.email)}>REMOVE</Btn>
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.14em", color: T.dim }}>INSTRUMENT</span>
              {MUSICIAN_INSTRUMENTS.map((i) => {
                const active = profile?.instrument === i;
                return (
                  <button
                    key={i}
                    onClick={() => onSetInstrument(m.id, i)}
                    style={{
                      fontFamily: "inherit", fontSize: 12, fontWeight: 700, letterSpacing: "0.04em",
                      padding: "4px 10px", borderRadius: 20, cursor: "pointer",
                      background: active ? T.teal : "transparent",
                      color: active ? T.text : T.dim,
                      border: `1px solid ${active ? T.teal : T.line}`,
                    }}
                  >
                    {i}
                  </button>
                );
              })}
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.14em", color: T.dim }}>NOTIFICATION EMAILS</span>
              <button
                onClick={() => onSetNotify(m.id, !notifyEnabled)}
                style={{
                  fontFamily: "inherit", fontSize: 12, fontWeight: 700, letterSpacing: "0.04em",
                  padding: "4px 10px", borderRadius: 20, cursor: "pointer",
                  background: notifyEnabled ? T.green : "transparent",
                  color: notifyEnabled ? "#06210F" : T.dim,
                  border: `1px solid ${notifyEnabled ? T.green : T.line}`,
                }}
              >
                {notifyEnabled ? "ON — LIVE FOR THIS MUSICIAN" : "OFF — TESTING ONLY"}
              </button>
            </div>
          </div>
        );
      })}

      <EmailLogSection ping={ping} />
    </div>
  );
}

function MusicianLeadCard({
  lead, booking, myAnswer, onSetAvail, onRetractAvail, busy, highlighted,
}: {
  lead: LeadRow;
  booking?: LeadMusicianRow;
  myAnswer?: "available" | "pass";
  onSetAvail?: (leadId: string, answer: "available" | "pass") => void;
  onRetractAvail?: (leadId: string) => void;
  busy?: boolean;
  highlighted?: boolean;
}) {
  const d = fmtDate(lead.event_date);
  const names = [lead.client_name, lead.fiance_name].filter(Boolean).join(" + ") || "Unnamed lead";
  const services = booking?.services || [];
  // Before a booking exists this card is a date check — it just needs a
  // response tag and the available/pass buttons, not services/payout
  // (those aren't decided until Austin actually books the musician).
  // Once the owner's advanced musician_stage past "new" (pending_booking,
  // planning, etc.), that stage is the more meaningful tag than my own
  // available/pass response.
  const respondedTag = lead.musician_stage !== "new"
    ? musicianStageDisplay(lead)
    : myAnswer === "available"
    ? { label: "AVAILABLE", color: T.green }
    : myAnswer === "pass"
    ? { label: "PASSED", color: T.dim }
    : { label: "DATE CHECK NEEDED", color: T.red };
  // The hold deadline matters more to a musician than most other details
  // on the card — surfaced big and prominent under the tags, not buried
  // in small dim text lower down.
  const holdUntilLabel = lead.musician_stage === "pending_booking" && lead.musician_meeting_date
    ? new Date(new Date(lead.musician_meeting_date + "T12:00:00").getTime() + 14 * 24 * 60 * 60 * 1000)
      .toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : null;
  const [expanded, setExpanded] = useState(!!highlighted);
  return (
    <div
      id={`lead-${lead.id}`}
      style={{
        display: "flex", background: T.surface,
        border: `1px solid ${highlighted ? T.accent : T.line}`,
        boxShadow: highlighted ? `0 0 0 3px ${T.accent}33` : "none",
        borderRadius: 10, overflow: "hidden",
      }}
    >
      <div className="lead-date-strip" style={{ width: 190, background: T.raised, borderRight: `1px solid ${T.line}`, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2, padding: "14px 10px", flexShrink: 0 }}>
        {d.dow && <div className="lead-date-line" style={{ fontSize: 28, fontWeight: 900, lineHeight: 1.1, whiteSpace: "nowrap", fontFamily: "var(--font-heading), serif" }}>{d.dow.toUpperCase()}</div>}
        <div className="lead-date-line" style={{ fontSize: 28, fontWeight: 900, lineHeight: 1.1, whiteSpace: "nowrap", fontFamily: "var(--font-heading), serif" }}>{d.mon} {d.day}</div>
        {d.year && <div style={{ fontSize: 11, color: T.dim, marginTop: 2 }}>{d.year}</div>}
      </div>
      <div style={{ flex: 1, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8, minWidth: 0, opacity: busy ? 0.5 : 1, pointerEvents: busy ? "none" : "auto" }}>
        <div onClick={() => setExpanded((e) => !e)} style={{ display: "flex", flexDirection: "column", gap: 6, cursor: "pointer" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
            <div style={{ minWidth: 0 }}>
              <div className="lead-name" style={{ fontWeight: 800, fontSize: 24, fontFamily: "var(--font-heading), serif", lineHeight: 1.15 }}>{names}</div>
              {(lead.dj_tier || lead.prod_tier) && (
                <div className="lead-tier" style={{ fontWeight: 700, fontSize: 19, fontFamily: "var(--font-heading), serif", lineHeight: 1.2, marginTop: 2 }}>
                  {lead.dj_tier && <span style={{ color: TIER_COLORS[lead.dj_tier] || T.blue }}>{lead.dj_tier}</span>}
                  {lead.dj_tier && lead.prod_tier && <span style={{ color: T.dim }}> + </span>}
                  {lead.prod_tier && <span style={{ color: TIER_COLORS[lead.prod_tier] || T.blue }}>{lead.prod_tier}</span>}
                </div>
              )}
              <div style={{ fontSize: 12.5, color: T.dim, marginTop: 4 }}>{lead.location || "location TBD"}</div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                {booking && lead.assigned_dj_name && <Tag color={T.violet}>DJ: {lead.assigned_dj_name}</Tag>}
                {booking && <BookedMusicianTags musicians={lead.booked_musicians} />}
                <Tag color={respondedTag.color}>{respondedTag.label}</Tag>
                <span style={{ color: T.dim, fontSize: 11, marginLeft: 2 }}>{expanded ? "▴" : "▾"}</span>
              </div>
              {holdUntilLabel && (
                <div style={{ fontSize: 16, fontWeight: 800, color: T.yellow, fontFamily: "var(--font-heading), serif" }}>
                  until {holdUntilLabel}
                </div>
              )}
              {booking?.payout != null && (
                <div style={{ fontSize: 12.5 }}>Payout: <strong style={{ color: T.text }}>${booking.payout}</strong></div>
              )}
            </div>
          </div>
        </div>
        {expanded && lead.upgrades && (
          <div style={{ fontSize: 12.5, color: T.accent }}>
            <span style={{ color: T.dim, fontWeight: 700, letterSpacing: "0.1em", fontSize: 10.5 }}>UPGRADES </span>
            {lead.upgrades}
          </div>
        )}
        {expanded && lead.client_vision && (
          <div style={{ fontSize: 12.5, color: T.dim, whiteSpace: "pre-wrap", borderLeft: `2px solid ${T.line}`, paddingLeft: 8 }}>
            {lead.client_vision}
          </div>
        )}
        {expanded && (booking ? (
          <>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {services.map((s) => <Tag key={s} color={T.blue}>{s}</Tag>)}
              {services.length === 0 && <span style={{ fontSize: 11, color: T.red }}>services not set yet — check with Austin</span>}
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {booking.paid_in_full ? (
                <Tag color={T.green}>PAID IN FULL</Tag>
              ) : booking.deposit_paid ? (
                <Tag color={T.green}>DEPOSIT PAID</Tag>
              ) : (
                <Tag color={isPastEvent(lead) ? T.red : T.dim}>DEPOSIT NOT PAID</Tag>
              )}
            </div>
          </>
        ) : onSetAvail && (
          <div style={{ display: "flex", gap: 8 }}>
            <Btn kind={myAnswer === "available" ? "green" : "primary"} small
              onClick={() => (myAnswer === "available" ? onRetractAvail?.(lead.id) : onSetAvail(lead.id, "available"))}>
              {myAnswer === "available" ? "✓ I'M AVAILABLE" : "I'M AVAILABLE"}
            </Btn>
            <Btn kind={myAnswer === "pass" ? "danger" : "ghost"} small
              onClick={() => (myAnswer === "pass" ? onRetractAvail?.(lead.id) : onSetAvail(lead.id, "pass"))}>
              {myAnswer === "pass" ? "✕ PASSED" : "PASS"}
            </Btn>
          </div>
        ))}
      </div>
    </div>
  );
}

function CompanySettings({
  settings,
  onSave,
}: {
  settings: CompanySettings;
  onSave: (patch: Database["public"]["Tables"]["company_settings"]["Update"]) => void;
}) {
  const [f, setF] = useState({
    headliner_rate: String(settings.headliner_rate),
    resident_rate: String(settings.resident_rate),
    associate_rate: String(settings.associate_rate),
    marquee_rate: String(settings.marquee_rate),
    modern_rate: String(settings.modern_rate),
    essential_rate: String(settings.essential_rate),
    travel_local_rate: String(settings.travel_local_rate),
    travel_extended_local_rate: String(settings.travel_extended_local_rate),
    travel_regional_rate: String(settings.travel_regional_rate),
    travel_central_ca_rate: String(settings.travel_central_ca_rate),
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 420 }}>
      <div style={{ fontSize: 12.5, color: T.dim }}>
        These rates are added together to suggest a DJ payout when you pick tiers on a lead — DJ tier + Production tier.
      </div>
      <div>
        <div style={{ fontWeight: 800, fontSize: 12, letterSpacing: "0.1em", color: T.accent, marginBottom: 8 }}>DJ TIER RATES</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Field label="HEADLINER ($)"><Input type="number" value={f.headliner_rate} onChange={set("headliner_rate")} /></Field>
          <Field label="RESIDENT ($)"><Input type="number" value={f.resident_rate} onChange={set("resident_rate")} /></Field>
          <Field label="ASSOCIATE ($)"><Input type="number" value={f.associate_rate} onChange={set("associate_rate")} /></Field>
        </div>
      </div>
      <div>
        <div style={{ fontWeight: 800, fontSize: 12, letterSpacing: "0.1em", color: T.accent, marginBottom: 8 }}>PRODUCTION TIER RATES</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Field label="MARQUEE ($)"><Input type="number" value={f.marquee_rate} onChange={set("marquee_rate")} /></Field>
          <Field label="MODERN ($)"><Input type="number" value={f.modern_rate} onChange={set("modern_rate")} /></Field>
          <Field label="ESSENTIAL ($)"><Input type="number" value={f.essential_rate} onChange={set("essential_rate")} /></Field>
        </div>
      </div>
      <div>
        <div style={{ fontWeight: 800, fontSize: 12, letterSpacing: "0.1em", color: T.accent, marginBottom: 8 }}>TRAVEL RATES</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Field label="LOCAL ($)"><Input type="number" value={f.travel_local_rate} onChange={set("travel_local_rate")} /></Field>
          <Field label="EXTENDED LOCAL ($)"><Input type="number" value={f.travel_extended_local_rate} onChange={set("travel_extended_local_rate")} /></Field>
          <Field label="REGIONAL ($)"><Input type="number" value={f.travel_regional_rate} onChange={set("travel_regional_rate")} /></Field>
          <Field label="CENTRAL CA ($)"><Input type="number" value={f.travel_central_ca_rate} onChange={set("travel_central_ca_rate")} /></Field>
        </div>
      </div>
      <Btn kind="primary" style={{ alignSelf: "flex-start" }} onClick={() => onSave({
        headliner_rate: Number(f.headliner_rate) || 0,
        resident_rate: Number(f.resident_rate) || 0,
        associate_rate: Number(f.associate_rate) || 0,
        marquee_rate: Number(f.marquee_rate) || 0,
        modern_rate: Number(f.modern_rate) || 0,
        essential_rate: Number(f.essential_rate) || 0,
        travel_local_rate: Number(f.travel_local_rate) || 0,
        travel_extended_local_rate: Number(f.travel_extended_local_rate) || 0,
        travel_regional_rate: Number(f.travel_regional_rate) || 0,
        travel_central_ca_rate: Number(f.travel_central_ca_rate) || 0,
      })}>
        SAVE RATES
      </Btn>
    </div>
  );
}

function DjFilterBar({
  roster, value, onChange,
}: { roster: RosterUser[]; value: string; onChange: (id: string) => void }) {
  if (roster.length === 0) return null;
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {[{ id: "all", label: "ALL" }, ...roster.map((d) => ({ id: d.id, label: d.display_name || d.email }))].map((opt) => {
        const isActive = value === opt.id;
        return (
          <button
            key={opt.id}
            onClick={() => onChange(opt.id)}
            style={{
              fontFamily: "inherit", fontSize: 12, fontWeight: 700, letterSpacing: "0.04em",
              padding: "5px 12px", borderRadius: 20, cursor: "pointer",
              background: isActive ? T.teal : "transparent",
              color: T.text,
              border: `1px solid ${isActive ? T.teal : T.line}`,
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function StatusBanner({ allCaughtUp }: { allCaughtUp: boolean }) {
  return (
    <div
      style={{
        background: allCaughtUp ? T.green + "1a" : T.accent + "1a",
        border: `1px solid ${allCaughtUp ? T.green + "55" : T.accent + "55"}`,
        borderRadius: 10, padding: "14px 18px", fontWeight: 700, fontSize: 14,
        color: allCaughtUp ? T.green : T.accent,
      }}
    >
      {allCaughtUp ? "You're all caught up. Keep up the good work!" : "You've got Date Checks. Get on top of 'em!"}
    </div>
  );
}

function StatCard({
  value, label, onClick, urgent,
}: { value: React.ReactNode; label: string; onClick?: () => void; urgent?: boolean }) {
  return (
    <div
      onClick={onClick}
      style={{
        flex: "1 1 140px", minWidth: 140, background: T.surface,
        border: `1px solid ${urgent ? T.accent + "66" : T.line}`,
        borderRadius: 10, padding: "16px 18px", cursor: onClick ? "pointer" : "default",
        display: "flex", flexDirection: "column", gap: 4,
      }}
    >
      <div style={{ fontSize: 32, fontWeight: 900, fontFamily: "var(--font-heading), serif", color: urgent ? T.accent : T.text }}>{value}</div>
      <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.14em", color: T.dim }}>{label}</div>
      {onClick && <div style={{ fontSize: 11.5, color: T.accent, marginTop: 4 }}>View →</div>}
    </div>
  );
}

function NextEventCard({
  lead, subtitle, emptyText, onView,
}: { lead: LeadRow | undefined; subtitle: string; emptyText: string; onView: () => void }) {
  if (!lead) return <Empty text={emptyText} />;
  const d = fmtDate(lead.event_date);
  const names = [lead.client_name, lead.fiance_name].filter(Boolean).join(" + ") || "Unnamed lead";
  return (
    <div
      onClick={onView}
      style={{
        display: "flex", background: T.surface, border: `1px solid ${T.accent}`,
        boxShadow: `0 0 0 3px ${T.accent}22`, borderRadius: 10, overflow: "hidden", cursor: "pointer",
      }}
    >
      <div style={{ width: 120, background: T.raised, borderRight: `1px solid ${T.line}`, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2, padding: "14px 10px", flexShrink: 0 }}>
        {d.dow && <div style={{ fontSize: 20, fontWeight: 900, fontFamily: "var(--font-heading), serif" }}>{d.dow.toUpperCase()}</div>}
        <div style={{ fontSize: 20, fontWeight: 900, fontFamily: "var(--font-heading), serif" }}>{d.mon} {d.day}</div>
        {d.year && <div style={{ fontSize: 10, color: T.dim }}>{d.year}</div>}
      </div>
      <div style={{ flex: 1, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.14em", color: T.accent }}>YOUR NEXT EVENT</div>
        <div style={{ fontWeight: 800, fontSize: 19, fontFamily: "var(--font-heading), serif" }}>{names}</div>
        {subtitle && <div style={{ fontSize: 12.5, color: T.dim }}>{subtitle}</div>}
        <div style={{ fontSize: 12.5, color: T.dim }}>{lead.location || "location TBD"}</div>
      </div>
    </div>
  );
}

const calNavBtnStyle: React.CSSProperties = {
  background: "transparent", border: `1px solid ${T.line}`, borderRadius: 6, color: T.dim,
  width: 26, height: 26, fontSize: 15, fontFamily: "inherit", cursor: "pointer", lineHeight: 1,
};

// Month grid of a talent's own gigs — a dot marks any day with a booked
// or completed event; clicking one jumps to that lead's card in the
// matching list tab rather than duplicating card content here.
function GigCalendar({
  events, onSelectEvent,
}: { events: { id: string; date: string; done: boolean }[]; onSelectEvent: (id: string, done: boolean) => void }) {
  const today = new Date();
  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth());

  const byDate = new Map<string, { id: string; done: boolean }[]>();
  for (const e of events) {
    if (!e.date) continue;
    const list = byDate.get(e.date) ?? [];
    list.push(e);
    byDate.set(e.date, list);
  }

  const pad = (n: number) => String(n).padStart(2, "0");
  const first = new Date(viewYear, viewMonth, 1);
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const cells: (number | null)[] = [
    ...Array(first.getDay()).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);
  const isToday = (day: number) => day === today.getDate() && viewMonth === today.getMonth() && viewYear === today.getFullYear();

  return (
    <div style={{ background: T.surface, border: `1px solid ${T.line}`, borderRadius: 10, padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <button
          type="button"
          aria-label="Previous month"
          onClick={() => {
            if (viewMonth === 0) { setViewMonth(11); setViewYear((y) => y - 1); }
            else setViewMonth((m) => m - 1);
          }}
          style={calNavBtnStyle}
        >
          ‹
        </button>
        <div style={{ fontWeight: 800, fontSize: 14, letterSpacing: "0.08em", fontFamily: "var(--font-heading), serif" }}>
          {first.toLocaleString("en-US", { month: "long", year: "numeric" }).toUpperCase()}
        </div>
        <button
          type="button"
          aria-label="Next month"
          onClick={() => {
            if (viewMonth === 11) { setViewMonth(0); setViewYear((y) => y + 1); }
            else setViewMonth((m) => m + 1);
          }}
          style={calNavBtnStyle}
        >
          ›
        </button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4 }}>
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
          <div key={i} style={{ fontSize: 10, fontWeight: 800, color: T.dim, textAlign: "center", padding: "2px 0" }}>{d}</div>
        ))}
        {cells.map((day, i) => {
          if (day === null) return <div key={i} />;
          const iso = `${viewYear}-${pad(viewMonth + 1)}-${pad(day)}`;
          const dayEvents = byDate.get(iso) ?? [];
          const hasEvent = dayEvents.length > 0;
          return (
            <div
              key={i}
              onClick={hasEvent ? () => onSelectEvent(dayEvents[0].id, dayEvents[0].done) : undefined}
              style={{
                aspectRatio: "1", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3,
                borderRadius: 8, cursor: hasEvent ? "pointer" : "default",
                border: isToday(day) ? `1px solid ${T.accent}` : "1px solid transparent",
                background: hasEvent ? T.raised : "transparent",
              }}
            >
              <div style={{ fontSize: 12, fontWeight: isToday(day) ? 900 : 600, color: hasEvent ? T.text : T.dim }}>{day}</div>
              {hasEvent && <span style={{ width: 5, height: 5, borderRadius: "50%", background: dayEvents[0].done ? T.blue : T.green }} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const BADGE_DEFS: { id: string; label: string; color: string; earned: (ctx: { streak: number }) => boolean }[] = [
  { id: "quick-draw", label: "QUICK DRAW · 5-STREAK", color: T.violet, earned: (ctx) => ctx.streak >= 5 },
  { id: "on-fire", label: "ON FIRE · 10-STREAK", color: T.accent, earned: (ctx) => ctx.streak >= 10 },
];

// Badges are derived entirely from counts already in state — no earned-
// badges table, so nothing to migrate if the thresholds change later.
function BadgeRow({ streak }: { streak: number }) {
  const ctx = { streak };
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {BADGE_DEFS.map((b) => {
        const earned = b.earned(ctx);
        return (
          <span
            key={b.id}
            style={{
              fontSize: 10, fontWeight: 800, letterSpacing: "0.06em", borderRadius: 4, padding: "6px 10px",
              border: `1px solid ${earned ? b.color + "66" : T.line}`,
              color: earned ? b.color : T.dim,
              background: earned ? b.color + "14" : "transparent",
              opacity: earned ? 1 : 0.5,
            }}
          >
            {b.label}
          </span>
        );
      })}
    </div>
  );
}

export default function BoardApp({
  userId,
  displayName,
  role,
}: {
  userId: string;
  displayName: string;
  role: "owner" | "dj" | "musician";
}) {
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();
  const searchParams = useSearchParams();
  const highlightLeadId = searchParams.get("lead");

  const [loading, setLoading] = useState(true);
  const [leads, setLeads] = useState<LeadRow[]>([]);
  const [roster, setRoster] = useState<RosterUser[]>([]);
  const [musicianRoster, setMusicianRoster] = useState<RosterUser[]>([]);
  const [rosterProfiles, setRosterProfiles] = useState<{ user_id: string; dj_tier_visibility: DjTier[]; instrument: Instrument | null; notify_email: boolean }[]>([]);
  const [leadMusicians, setLeadMusicians] = useState<LeadMusicianRow[]>([]);
  const [myMusicianBookings, setMyMusicianBookings] = useState<LeadMusicianRow[]>([]);
  const [availability, setAvailability] = useState<AvailabilityRow[]>([]);
  const [myAvailability, setMyAvailability] = useState<Record<string, "available" | "pass">>({});
  const [myResponseTimes, setMyResponseTimes] = useState<Record<string, string>>({});
  const [myTiers, setMyTiers] = useState<string[]>([]);
  const [myInstrument, setMyInstrument] = useState<Instrument | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardRow[]>([]);
  const [companySettings, setCompanySettings] = useState<CompanySettings | null>(null);
  const [tab, setTab] = useState("pipeline");
  const [calHighlightId, setCalHighlightId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [toasts, setToasts] = useState<{ id: number; message: string }[]>([]);
  const [showAdd, setShowAdd] = useState<"import" | "manual" | false>(false);
  const [sortBy, setSortBy] = useState<"event" | "submitted">(role === "dj" ? "submitted" : "event");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [motionDjFilter, setMotionDjFilter] = useState<string>("all");
  const [pipelineSort, setPipelineSort] = useState<SectionSort>({ by: "submitted", dir: "desc" });
  const [ownerMeetingBookedSort, setOwnerMeetingBookedSort] = useState<SectionSort>({ by: "submitted", dir: "asc" });
  const [ownerFollowUpSort, setOwnerFollowUpSort] = useState<SectionSort>({ by: "submitted", dir: "asc" });
  const [needAvailSort, setNeedAvailSort] = useState<SectionSort>({ by: "submitted", dir: "asc" });
  const [markedAvailSort, setMarkedAvailSort] = useState<SectionSort>({ by: "submitted", dir: "asc" });
  const [pendingBookingSort, setPendingBookingSort] = useState<SectionSort>({ by: "submitted", dir: "asc" });
  const [awaitingSelectionSort, setAwaitingSelectionSort] = useState<SectionSort>({ by: "submitted", dir: "asc" });
  const [needAvailMusicianSort, setNeedAvailMusicianSort] = useState<SectionSort>({ by: "submitted", dir: "asc" });
  const [markedAvailMusicianSort, setMarkedAvailMusicianSort] = useState<SectionSort>({ by: "submitted", dir: "asc" });
  const [pendingBookingMusicianSort, setPendingBookingMusicianSort] = useState<SectionSort>({ by: "submitted", dir: "asc" });
  const [confirmState, setConfirmState] = useState<{ message: string; confirmLabel: string; resolve: (v: boolean) => void } | null>(null);
  const [busyLeadId, setBusyLeadId] = useState<string | null>(null);

  // Clicking the already-active sort pill flips direction; switching to the
  // other field resets to ascending as a sensible default.
  const handleSortChange = useCallback((v: "event" | "submitted") => {
    setSortBy((prev) => {
      if (prev === v) { setSortDir((d) => (d === "asc" ? "desc" : "asc")); return prev; }
      setSortDir("asc");
      return v;
    });
  }, []);

  const sortLeads = useCallback((list: LeadRow[]) => {
    const base = sortBy === "event" ? byDate : bySubmitted;
    const dirMult = sortDir === "asc" ? 1 : -1;
    return [...list].sort((a, b) => base(a, b) * dirMult);
  }, [sortBy, sortDir]);

  const ping = useCallback((m: string) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, message: m }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 5000);
  }, []);

  const confirmAction = useCallback((message: string, confirmLabel: string) => {
    return new Promise<boolean>((resolve) => setConfirmState({ message, confirmLabel, resolve }));
  }, []);

  // Supabase/Postgres error text (constraint names, column names) isn't
  // meaningful to a non-technical user — log it for us, show them plain
  // language instead.
  const friendlyError = useCallback((error: { message: string }) => {
    console.error(error.message);
    return "Something went wrong — try again.";
  }, []);

  const loadData = useCallback(async () => {
    const { data: leadsData } = await supabase.from("leads_feed").select("*").order("created_at", { ascending: false });
    setLeads(leadsData ?? []);

    if (role === "owner") {
      const { data: rosterData } = await supabase.from("users").select("id,email,display_name").eq("role", "dj").order("display_name");
      setRoster(rosterData ?? []);
      const { data: musicianData } = await supabase.from("users").select("id,email,display_name").eq("role", "musician").order("display_name");
      setMusicianRoster(musicianData ?? []);
      const allRosterIds = [...(rosterData ?? []), ...(musicianData ?? [])].map((d) => d.id);
      const { data: profilesData } = await supabase
        .from("dj_profiles")
        .select("user_id, dj_tier_visibility, instrument, notify_email")
        .in("user_id", allRosterIds.length ? allRosterIds : ["00000000-0000-0000-0000-000000000000"]);
      setRosterProfiles(profilesData ?? []);
      const { data: availData } = await supabase.from("availability_responses").select("lead_id,dj_user_id,response");
      setAvailability(availData ?? []);
      // Austin can mark himself available on a Pipeline lead too — his own
      // response lives in the same table as every DJ's, just keyed by his
      // own userId, so it's already in availData above.
      setMyAvailability(Object.fromEntries((availData ?? []).filter((r) => r.dj_user_id === userId).map((r) => [r.lead_id, r.response])));
      const { data: leadMusiciansData } = await supabase.from("lead_musicians").select("*");
      setLeadMusicians(leadMusiciansData ?? []);
      const { data: settingsData } = await supabase.from("company_settings").select("*").eq("id", 1).single();
      setCompanySettings(settingsData ?? null);
    } else if (role === "dj") {
      const { data: mine } = await supabase.from("availability_responses").select("lead_id,response,responded_at").eq("dj_user_id", userId);
      setMyAvailability(Object.fromEntries((mine ?? []).map((r) => [r.lead_id, r.response])));
      setMyResponseTimes(Object.fromEntries((mine ?? []).map((r) => [r.lead_id, r.responded_at])));
      const { data: prof } = await supabase.from("dj_profiles").select("dj_tier_visibility").eq("user_id", userId).single();
      setMyTiers(prof?.dj_tier_visibility ?? []);
      const { data: leaderboardData } = await supabase.from("dj_leaderboard").select("*");
      setLeaderboard(leaderboardData ?? []);
    } else {
      const { data: myBookings } = await supabase.from("lead_musicians").select("*").eq("musician_id", userId);
      setMyMusicianBookings(myBookings ?? []);
      const { data: mine } = await supabase.from("availability_responses").select("lead_id,response,responded_at").eq("dj_user_id", userId);
      setMyAvailability(Object.fromEntries((mine ?? []).map((r) => [r.lead_id, r.response])));
      setMyResponseTimes(Object.fromEntries((mine ?? []).map((r) => [r.lead_id, r.responded_at])));
      const { data: prof } = await supabase.from("dj_profiles").select("instrument").eq("user_id", userId).single();
      setMyInstrument((prof?.instrument as Instrument | null) ?? null);
    }
    setLoading(false);
  }, [supabase, role, userId]);

  // Initial fetch on mount — an accepted exception to "don't setState in effects",
  // not derived/redundant state, so the react-hooks rule is a false positive here.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { loadData(); }, [loadData]);
  useEffect(() => {
    const onVis = () => document.visibilityState === "visible" && loadData();
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [loadData]);

  useEffect(() => {
    if (!highlightLeadId || leads.length === 0) return;
    document.getElementById(`lead-${highlightLeadId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlightLeadId, leads]);

  // Calendar-driven jumps switch tabs first, so the target card doesn't
  // exist in the DOM until the destination tab's own render commits —
  // re-run on `tab` too, not just calHighlightId, so the scroll fires
  // post-switch.
  useEffect(() => {
    if (!calHighlightId) return;
    document.getElementById(`lead-${calHighlightId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [calHighlightId, tab]);

  const logout = async () => {
    await supabase.auth.signOut();
    router.push("/login");
  };

  const fetchLeadHistory = useCallback(async (leadId: string): Promise<EventRow[]> => {
    const { data } = await supabase.from("events").select("*").eq("lead_id", leadId).order("created_at", { ascending: false });
    return data ?? [];
  }, [supabase]);

  const saveDjTiers = async (djId: string, tiers: DjTier[]) => {
    const { error } = await supabase.from("dj_profiles").update({ dj_tier_visibility: tiers }).eq("user_id", djId);
    if (error) { ping(friendlyError(error)); return; }
    ping("Tiers updated");
    loadData();
  };

  const saveDjNotify = async (djId: string, enabled: boolean) => {
    const { error } = await supabase.from("dj_profiles").update({ notify_email: enabled }).eq("user_id", djId);
    if (error) { ping(friendlyError(error)); return; }
    ping(enabled ? "Emails turned on for this DJ" : "Emails turned off for this DJ");
    loadData();
  };

  const saveMusicianInstrument = async (musicianId: string, instrument: Instrument) => {
    const { error } = await supabase.from("dj_profiles").update({ instrument }).eq("user_id", musicianId);
    if (error) { ping(friendlyError(error)); return; }
    ping(`Instrument set to ${instrument}`);
    loadData();
  };

  const bookMusician = async (leadId: string, musicianId: string) => {
    const { error } = await supabase.from("lead_musicians").insert({ lead_id: leadId, musician_id: musicianId });
    if (error) { ping(friendlyError(error)); return; }
    ping("Musician booked on this lead");
    loadData();
  };

  // Musician stage now moves through button-driven actions instead of a
  // free-form selector, mirroring the DJ pipeline's checking → meeting →
  // booked flow.
  const musicianMeetingBooked = async (leadId: string) => {
    const today = new Date().toISOString().slice(0, 10);
    const { error } = await supabase.from("leads").update({ musician_stage: "pending_booking", musician_meeting_date: today }).eq("id", leadId);
    if (error) { ping(friendlyError(error)); return; }
    ping("Musician meeting booked — 14-day hold started");
    loadData();
    fetch("/api/notify/musician-hold", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ leadId }),
    }).catch(() => {});
  };

  // Manual fast-path for a musician nobody's asked about yet — simulates
  // "said available" + "meeting booked" in one click, for a lead whose
  // original inquiry never mentioned an instrument (see the MUSICIAN
  // REQUESTED toggle in EditLeadForm, which is what makes the Musicians
  // section appear on the card in the first place). Only sets the stage/
  // meeting date if this is the first musician on hold for this lead —
  // adding a second candidate later shouldn't restart the first one's
  // 14-day clock.
  const addMusicianToHold = async (leadId: string, musicianId: string) => {
    const lead = leads.find((l) => l.id === leadId);
    const { error: availError } = await supabase
      .from("availability_responses")
      .upsert({ lead_id: leadId, dj_user_id: musicianId, response: "available" }, { onConflict: "lead_id,dj_user_id" });
    if (availError) { ping(friendlyError(availError)); return; }
    if (lead?.musician_stage !== "pending_booking") {
      const today = new Date().toISOString().slice(0, 10);
      const { error } = await supabase.from("leads").update({ musician_stage: "pending_booking", musician_meeting_date: today }).eq("id", leadId);
      if (error) { ping(friendlyError(error)); return; }
    }
    ping("Added to hold");
    loadData();
    fetch("/api/notify/musician-hold", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ leadId, musicianId }),
    }).catch(() => {});
  };

  // Booking a musician here also finalizes the lead as booked (whether or
  // not a musician stays attached) — from Pending Booking, "booked" always
  // means the event itself is confirmed either way.
  const markMusicianBooked = async (leadId: string, musicianId: string | null) => {
    if (musicianId) {
      const { error: bookError } = await supabase.from("lead_musicians").insert({ lead_id: leadId, musician_id: musicianId });
      if (bookError) { ping(friendlyError(bookError)); return; }
      const { error } = await supabase.from("leads").update({ status: "booked" }).eq("id", leadId);
      if (error) { ping(friendlyError(error)); return; }
    } else {
      const { error } = await supabase.from("leads").update({ status: "booked", musician_stage: "archived" }).eq("id", leadId);
      if (error) { ping(friendlyError(error)); return; }
    }
    ping("Marked booked");
    loadData();
  };

  const markMusicianLost = async (leadId: string) => {
    const { error } = await supabase.from("leads").update({ status: "lost", musician_stage: "archived" }).eq("id", leadId);
    if (error) { ping(friendlyError(error)); return; }
    ping("Marked lost");
    loadData();
  };

  // Only rolls the lead's DJ-side status back to checking if no DJ is
  // assigned — if one is, that booking is presumably real and unrelated
  // to the musician mistake being undone here, so it's left alone.
  const undoMusicianPlanning = async (leadId: string, targetStage: "new" | "pending_booking", hasAssignedDj: boolean) => {
    // Going all the way back to "new" means the meeting itself was
    // premature too, not just the booking — clear the meeting date along
    // with it so a stale date doesn't linger on a lead nobody's pitched yet.
    const patch: LeadUpdate = { musician_stage: targetStage };
    if (targetStage === "new") patch.musician_meeting_date = null;
    if (!hasAssignedDj) patch.status = "checking";
    const { error } = await supabase.from("leads").update(patch).eq("id", leadId);
    if (error) { ping(friendlyError(error)); return; }
    ping(`Musician stage reverted to ${targetStage === "new" ? "New" : "Pending Booking"}`);
    loadData();
  };

  const unbookMusician = async (id: string, label: string) => {
    const ok = await confirmAction(`Remove ${label} from this lead?`, "Remove");
    if (!ok) return;
    const { error } = await supabase.from("lead_musicians").delete().eq("id", id);
    if (error) { ping(friendlyError(error)); return; }
    ping("Musician removed from this lead");
    loadData();
  };

  // Owner-only correction for a mis-click — RLS already lets the owner
  // delete any availability_responses row, not just their own.
  const ownerRetractAvail = async (leadId: string, targetUserId: string, label: string) => {
    const ok = await confirmAction(`Remove ${label}'s response on this lead?`, "Remove");
    if (!ok) return;
    const { error } = await supabase.from("availability_responses").delete().eq("lead_id", leadId).eq("dj_user_id", targetUserId);
    if (error) { ping(friendlyError(error)); return; }
    ping("Response removed");
    loadData();
  };

  const updateMusicianBooking = async (id: string, patch: { services?: MusicianService[]; payout?: number | null; deposit_paid?: boolean; paid_in_full?: boolean }, msg?: string) => {
    const { error } = await supabase.from("lead_musicians").update(patch).eq("id", id);
    if (error) { ping(friendlyError(error)); return; }
    if (msg) ping(msg);
    loadData();
  };

  const setAvail = async (leadId: string, answer: "available" | "pass") => {
    const lead = leads.find((l) => l.id === leadId);
    const isMyHeadlinerPass = role === "owner" && answer === "pass" && lead?.dj_tier === "Headliner";
    setMyAvailability((prev) => ({ ...prev, [leadId]: answer }));
    setBusyLeadId(leadId);
    const { error } = await supabase
      .from("availability_responses")
      .upsert({ lead_id: leadId, dj_user_id: userId, response: answer }, { onConflict: "lead_id,dj_user_id" });
    setBusyLeadId(null);
    if (error) { ping(friendlyError(error)); return; }
    ping(
      isMyHeadlinerPass
        ? "Passed — Headliner DJs can see this lead now"
        : role === "owner" && answer === "available"
        ? "Marked yourself available — moved to your ready-to-book list"
        : answer === "available" ? "Marked available — visible on the board now" : "Passed on this date"
    );
    loadData();
    // Also covers the Headliner-release case: this same endpoint decides
    // server-side whether an owner's pass should notify qualified DJs.
    fetch("/api/notify/availability", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ leadId }),
    }).catch(() => {});
  };

  // Undoes an available/pass response entirely — back to "no response
  // yet" — for a DJ who's no longer sure, rather than forcing a choice
  // between the two.
  const retractAvail = async (leadId: string) => {
    setMyAvailability((prev) => {
      const next = { ...prev };
      delete next[leadId];
      return next;
    });
    setBusyLeadId(leadId);
    const { error } = await supabase
      .from("availability_responses")
      .delete()
      .eq("lead_id", leadId)
      .eq("dj_user_id", userId);
    setBusyLeadId(null);
    if (error) { ping(friendlyError(error)); return; }
    ping("Response retracted");
    loadData();
  };

  const updateLead = async (id: string, patch: LeadUpdate, msg?: string) => {
    setBusyLeadId(id);
    const { error } = await supabase.from("leads").update(patch).eq("id", id);
    setBusyLeadId(null);
    if (error) { ping(friendlyError(error)); return; }
    if (msg) ping(msg);
    loadData();
  };

  const deleteLead = async (id: string) => {
    const ok = await confirmAction("Delete this lead entirely? This can't be undone.", "Delete lead");
    if (!ok) return;
    setBusyLeadId(id);
    const { error } = await supabase.from("leads").delete().eq("id", id);
    setBusyLeadId(null);
    if (error) { ping(friendlyError(error)); return; }
    ping("Lead deleted");
    loadData();
  };

  const saveNotes = async (id: string, notes: string) => {
    setBusyLeadId(id);
    const res = await fetch(`/api/leads/${id}/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes }),
    });
    setBusyLeadId(null);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { ping(data.error || "Couldn't save notes"); return; }
    ping("Notes saved");
    loadData();
  };

  const saveSettings = async (patch: Database["public"]["Tables"]["company_settings"]["Update"]) => {
    const { error } = await supabase.from("company_settings").update(patch).eq("id", 1);
    if (error) { ping(friendlyError(error)); return; }
    ping("Rates updated");
    loadData();
  };

  const addLead = async (fields: LeadInsert) => {
    const { data, error } = await supabase.from("leads").insert(fields).select("id").single();
    if (error) { ping(friendlyError(error)); return; }
    ping("Lead is on the board — date check is live");
    setShowAdd(false);
    loadData();
    fetch("/api/notify/new-lead", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ leadId: data.id }),
    }).catch(() => {});
  };

  if (loading) {
    return (
      <div style={{ background: T.bg, minHeight: "100vh", display: "grid", placeItems: "center", color: T.dim, fontFamily: "var(--font-body), system-ui, sans-serif" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Lamp color={T.accent} pulse />
          <span style={{ letterSpacing: "0.2em", fontSize: 12, fontWeight: 700 }}>LOADING THE BOARD…</span>
        </div>
      </div>
    );
  }

  const active = leads.filter((l) => !["played", "lost"].includes(leadStatus(l)));
  const checking = active.filter((l) => ["checking", "ready"].includes(leadStatus(l)));
  const inMotion = active.filter((l) => ["meeting", "booked"].includes(leadStatus(l)));
  const archived = leads.filter((l) => ["played", "lost"].includes(leadStatus(l)));

  // Search runs across every lead this role can already see (leads_feed
  // has already scoped that server-side), regardless of which tab it'd
  // normally live in — that's the whole point, vs. filtering one tab.
  const searchActive = searchQuery.trim().length > 0;
  const searchResults = searchActive ? sortLeads(leads.filter((l) => matchesSearch(l, searchQuery))) : [];

  // Headliner leads are hidden from every DJ (see leads_feed) until Austin
  // has personally passed on them — he gets first refusal. Until he
  // answers, they're pulled out of the normal pipeline sections into
  // their own "your call" section up top; once answered, they rejoin the
  // normal flow like any other lead.
  const isAwaitingMyHeadlinerCall = (l: LeadRow) => l.dj_tier === "Headliner" && !myAvailability[l.id];
  const headlinerAwaitingMe = checking.filter(isAwaitingMyHeadlinerCall);

  // Meeting-stage leads split by DJ assignment, mirroring the DJ side's
  // own Pending tab: MEETINGS is meeting-booked but nobody picked yet,
  // PENDING is a DJ (Austin included) already assigned and just waiting
  // to close. Then booked gigs split by whether the date's already passed
  // (the daily cron eventually sweeps those into Archive as "played", but
  // Past is the real-time view before that happens).
  const meetingLeads = inMotion.filter((l) => leadStatus(l) === "meeting" && !l.assigned_dj_id);
  const pendingLeads = inMotion.filter((l) => leadStatus(l) === "meeting" && !!l.assigned_dj_id);
  const bookedLeads = inMotion.filter((l) => leadStatus(l) === "booked");
  const upcomingBooked = bookedLeads.filter((l) => !isPastEvent(l));
  const pastBooked = bookedLeads.filter((l) => isPastEvent(l));
  const djFilter = (list: LeadRow[]) => motionDjFilter === "all" ? list : list.filter((l) => l.assigned_dj_id === motionDjFilter);
  const filteredMeetings = djFilter(meetingLeads);
  const filteredPending = djFilter(pendingLeads);
  const filteredUpcoming = djFilter(upcomingBooked);
  const filteredPast = djFilter(pastBooked);

  // No dj_tier on the lead means no tier restriction applies. But an empty
  // myTiers means the owner hasn't qualified this DJ for any tier yet — that
  // no longer means "show everything" (a preference default), it means
  // "not qualified for anything yet" (an eligibility default).
  const tierVisible = (l: LeadRow) => !l.dj_tier || l.dj_tier === "Any" || myTiers.includes(l.dj_tier);
  const myChecks = checking.filter(tierVisible);
  // Date Checks splits into two: ones I haven't answered yet, and ones
  // I've already marked myself available for but Austin hasn't booked a
  // meeting on yet. Passing sends it to Archive instead (still reversible
  // from there — the available/pass buttons stay on the card).
  const needsMe = myChecks.filter((l) => !myAvailability[l.id]);
  const myMarkedAvailable = myChecks.filter((l) => myAvailability[l.id] === "available");
  const myArchive = myChecks.filter((l) => myAvailability[l.id] === "pass");
  const myRespondedLeads = Object.keys(myAvailability)
    .map((leadId) => {
      const lead = leads.find((l) => l.id === leadId);
      const respondedAt = myResponseTimes[leadId];
      return lead && respondedAt ? { leadCreatedAt: lead.created_at, respondedAt } : null;
    })
    .filter((r): r is { leadCreatedAt: string; respondedAt: string } => r !== null);
  const myStreak = computeResponseStreak(myRespondedLeads, needsMe);
  // Pending splits into two: leads Austin has actually assigned to me
  // (status "meeting", assigned_dj_id = me) waiting on me to follow up and
  // get it booked, and leads where I said available and Austin has booked
  // the meeting but hasn't picked which DJ gets it yet — every DJ who said
  // yes sees those until a specific one is chosen.
  const myAssignedMeeting = active.filter((l) => l.assigned_dj_id === userId && leadStatus(l) === "meeting");
  const myAwaitingSelection = active.filter((l) => !l.assigned_dj_id && leadStatus(l) === "meeting" && myAvailability[l.id] === "available");
  const myPending = [...myAssignedMeeting, ...myAwaitingSelection];
  const myGigs = leads.filter((l) => l.assigned_dj_id === userId && ["booked", "played"].includes(leadStatus(l)));
  const myUpcoming = myGigs.filter((l) => !isPastEvent(l));
  const myCompleted = myGigs.filter((l) => isPastEvent(l));
  const completedLeaderboard = [...leaderboard].sort((a, b) => b.completed_total - a.completed_total);
  const bookedLeaderboard = [...leaderboard].sort((a, b) => b.booked_total - a.booked_total);
  const nextDjEvent = [...myUpcoming].sort(byDate)[0];
  // Same "all bookings ever, any status" total the Leaderboard already
  // shows for every DJ (completed + booked combined) — reusing it here
  // keeps the two numbers from ever disagreeing with each other.
  const myLeaderboardRow = leaderboard.find((r) => r.dj_id === userId);
  const myMoneyMade = (myLeaderboardRow?.completed_total ?? 0) + (myLeaderboardRow?.booked_total ?? 0);

  const myMusicianLeadIds = new Set(myMusicianBookings.map((b) => b.lead_id));
  const myMusicianLeads = leads.filter((l) => myMusicianLeadIds.has(l.id));
  // Planning/Complete mirror musician_stage directly — booking a musician
  // auto-advances the lead to 'planning' (see trg_advance_musician_stage),
  // and the daily cron flips it to 'complete' once the event's passed.
  const myMusicianPlanning = myMusicianLeads.filter((l) => !isPastEvent(l));
  const myMusicianComplete = myMusicianLeads.filter((l) => isPastEvent(l));
  const nextMusicianEvent = [...myMusicianPlanning].sort(byDate)[0];
  const nextMusicianBooking = nextMusicianEvent ? myMusicianBookings.find((b) => b.lead_id === nextMusicianEvent.id) : undefined;
  const myMusicianMoneyMade = myMusicianBookings.reduce((sum, b) => sum + (b.payout ?? 0), 0);

  // A musician's date-check pool is filtered by instrument keyword in the
  // upgrades or vision text — there's no per-musician visibility list to
  // configure, so no instrument means no matches rather than "show
  // everything."
  const instrumentVisible = (l: LeadRow) => !!myInstrument && instrumentMentioned(l, myInstrument);
  // Every tab below keys off musician_stage rather than the DJ-side
  // status — the two pipelines run independently (see leads_feed and the
  // musician_stage column comment in schema.sql).
  const newMusicianLeads = leads.filter((l) => l.musician_stage === "new");
  const myMusicianChecks = newMusicianLeads.filter(instrumentVisible).filter((l) => !myMusicianLeadIds.has(l.id));
  const needsMeMusician = myMusicianChecks.filter((l) => !myAvailability[l.id]);
  const myMusicianMarkedAvailable = myMusicianChecks.filter((l) => myAvailability[l.id] === "available");
  const myMusicianRespondedLeads = Object.keys(myAvailability)
    .map((leadId) => {
      const lead = leads.find((l) => l.id === leadId);
      const respondedAt = myResponseTimes[leadId];
      return lead && respondedAt ? { leadCreatedAt: lead.created_at, respondedAt } : null;
    })
    .filter((r): r is { leadCreatedAt: string; respondedAt: string } => r !== null);
  const myMusicianStreak = computeResponseStreak(myMusicianRespondedLeads, needsMeMusician);
  // Pending Booking: Austin's had the intro call and the 14-day hold is
  // on. Stays visible to every musician of that instrument who said
  // available until it either books (drops into Planning) or the owner
  // moves it on.
  const myMusicianPendingBooking = leads.filter((l) =>
    l.musician_stage === "pending_booking" && instrumentVisible(l) && myAvailability[l.id] === "available" && !myMusicianLeadIds.has(l.id)
  );
  // Archive: dead ends — the owner called it archived or booked-with-no-
  // musician, or I personally passed while it was still fresh.
  const myMusicianArchive = leads.filter((l) =>
    instrumentVisible(l) && !myMusicianLeadIds.has(l.id)
    && (["archived", "booked_no_musician"].includes(l.musician_stage) || myAvailability[l.id] === "pass")
  );

  // Austin can pick up leads like any DJ, but his account stays
  // role="owner" — dj_leaderboard and the Roster page both query
  // strictly on role='dj', so he's automatically excluded from the
  // Leaderboard and DJ management just by never being a "real" DJ
  // roster member. This only adds him to the assign-DJ dropdown's
  // options, client-side.
  const assignableRoster: RosterUser[] = role === "owner" ? [...roster, { id: userId, email: displayName, display_name: displayName }] : roster;

  const ownerTabs = [
    { id: "pipeline", label: "PIPELINE", count: checking.length },
    { id: "pending", label: "PENDING", count: meetingLeads.length + pendingLeads.length },
    { id: "upcoming", label: "UPCOMING", count: upcomingBooked.length },
    { id: "past", label: "PAST", count: pastBooked.length },
    { id: "archive", label: "ARCHIVE", count: archived.length },
    { id: "roster", label: "ROSTER", count: roster.length },
    { id: "settings", label: "SETTINGS", count: 0 },
  ];
  const djTabs = [
    { id: "home", label: "HOME", count: 0 },
    { id: "checks", label: "DATE CHECKS", count: needsMe.length },
    { id: "pending", label: "PENDING", count: myPending.length },
    { id: "upcoming", label: "UPCOMING", count: myUpcoming.filter((l) => leadStatus(l) === "booked").length },
    { id: "completed", label: "COMPLETED", count: 0 },
    { id: "archive", label: "ARCHIVE", count: myArchive.length },
    { id: "leaderboard", label: "LEADERBOARD", count: 0 },
  ];
  const musicianTabs = [
    { id: "musician-home", label: "HOME", count: 0 },
    { id: "musician-checks", label: "DATE CHECKS", count: needsMeMusician.length },
    { id: "musician-pending", label: "PENDING", count: myMusicianPendingBooking.length },
    { id: "musician-upcoming", label: "UPCOMING", count: myMusicianPlanning.length },
    { id: "musician-completed", label: "PAST", count: 0 },
    { id: "musician-archive", label: "ARCHIVE", count: myMusicianArchive.length },
  ];
  const tabs = role === "owner" ? ownerTabs : role === "dj" ? djTabs : musicianTabs;
  const activeTab = tabs.some((t) => t.id === tab) ? tab : tabs[0].id;

  const goToCalendarEvent = (leadId: string, targetTab: string) => {
    setCalHighlightId(leadId);
    setTab(targetTab);
  };

  return (
    <div style={{ background: T.bg, minHeight: "100vh", color: T.text, fontFamily: "var(--font-body), system-ui, -apple-system, sans-serif" }}>
      <style>{`
        @keyframes lampPulse { 0%,100% { opacity: 1 } 50% { opacity: .35 } }
        .lamp-pulse { animation: lampPulse 1.8s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) { .lamp-pulse { animation: none; } }
        @media (max-width: 480px) {
          .lead-date-strip { width: 108px !important; gap: 8px !important; padding: 10px 6px !important; }
          .lead-date-line { font-size: 19px !important; }
          .lead-name { font-size: 19px !important; }
          .lead-tier { font-size: 15px !important; }
        }
        select option { background: ${T.surface}; color: ${T.text}; }
        input:focus, select:focus, textarea:focus { border-color: ${T.accent} !important; }
        button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid ${T.accent}; outline-offset: 2px; }
      `}</style>

      <header style={{ borderBottom: `1px solid ${T.line}`, padding: "16px 16px 0", position: "sticky", top: 0, background: T.bg, zIndex: 10 }}>
        <div style={{ maxWidth: 860, margin: "0 auto" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Lamp color={T.accent} pulse />
              <div>
                <div style={{ fontWeight: 900, fontSize: 18, letterSpacing: "0.14em", fontFamily: "var(--font-heading), serif" }}>AUSTO</div>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.34em", color: T.dim, marginTop: -2 }}>GIG BOARD</div>
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 12, color: T.dim }}>{displayName} · {role === "owner" ? "Owner" : role === "dj" ? "DJ" : "Musician"}</span>
              <Btn small ariaLabel="Refresh board" onClick={() => { loadData(); ping("Board refreshed"); }}>↻</Btn>
              <Btn small onClick={logout}>LOG OUT</Btn>
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
            <div style={{ position: "relative", width: "100%", maxWidth: 260 }}>
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search by name or date…"
                aria-label="Search leads by name or event date"
                style={{ paddingRight: searchQuery ? 30 : 10 }}
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
                  aria-label="Clear search"
                  style={{
                    position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)",
                    background: "none", border: "none", color: T.dim, cursor: "pointer", fontSize: 14, lineHeight: 1, padding: 4,
                  }}
                >
                  ✕
                </button>
              )}
            </div>
          </div>

          <nav style={{ display: "flex", gap: 4, marginTop: 14, overflowX: "auto" }}>
            {tabs.map((t) => {
              const isActive = t.id === activeTab;
              return (
                <button key={t.id} onClick={() => { setTab(t.id); setSearchQuery(""); }} style={{
                  fontFamily: "inherit", background: "none", border: "none",
                  borderBottom: `2px solid ${isActive ? T.accent : "transparent"}`,
                  color: isActive ? T.text : T.dim, fontWeight: 800, fontSize: 12,
                  letterSpacing: "0.12em", padding: "10px 12px", cursor: "pointer", whiteSpace: "nowrap",
                }}>
                  {t.label}
                  {t.count > 0 && <span style={{ marginLeft: 6, color: isActive ? T.accent : T.dim, fontSize: 11 }}>{t.count}</span>}
                </button>
              );
            })}
          </nav>
        </div>
      </header>

      <main style={{ maxWidth: 860, margin: "0 auto", padding: 16, display: "flex", flexDirection: "column", gap: 12, paddingBottom: 60 }}>
        {searchActive && (
          <>
            <div style={{ fontSize: 11, color: T.dim }}>
              {searchResults.length} result{searchResults.length !== 1 ? "s" : ""} for &ldquo;{searchQuery}&rdquo; — across every status
            </div>
            {searchResults.length > 0 && <SortToggle sortBy={sortBy} sortDir={sortDir} onChange={handleSortChange} />}
            {searchResults.length === 0 && <Empty text="No leads match that name or date." />}
            {searchResults.map((l) => (
              <div key={l.id} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: "0.14em", color: T.dim }}>{stageLabel(l)}</div>
                {role === "musician" ? (
                  <MusicianLeadCard
                    lead={l}
                    booking={myMusicianBookings.find((b) => b.lead_id === l.id)}
                    myAnswer={myAvailability[l.id]}
                    onSetAvail={setAvail}
                    busy={busyLeadId === l.id}
                    highlighted={l.id === highlightLeadId}
                  />
                ) : (
                  <LeadCard
                    lead={l} djView={role === "dj"} roster={role === "owner" ? assignableRoster : roster} availability={availability}
                    myAnswer={myAvailability[l.id]} highlighted={l.id === highlightLeadId} busy={busyLeadId === l.id} userId={userId}
                    onFetchHistory={fetchLeadHistory} musicianRoster={musicianRoster} rosterProfiles={rosterProfiles} leadMusicians={leadMusicians}
                    onBookMusician={bookMusician} onUnbookMusician={unbookMusician} onUpdateMusicianBooking={updateMusicianBooking} onAddMusicianToHold={addMusicianToHold} onMusicianMeetingBooked={musicianMeetingBooked} onMarkMusicianBooked={markMusicianBooked} onMarkMusicianLost={markMusicianLost} onUndoMusicianPlanning={undoMusicianPlanning} onRemoveAvailability={ownerRetractAvail}
                    onSetAvail={setAvail} onRetractAvail={retractAvail} onUpdateLead={updateLead} onDeleteLead={deleteLead} onSaveNotes={saveNotes}
                  />
                )}
              </div>
            ))}
          </>
        )}

        {!searchActive && (
        <>
        {role === "owner" && activeTab === "pipeline" && (
          <>
            {!showAdd && (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Btn kind="primary" onClick={() => setShowAdd("import")}>+ IMPORT FROM HONEYBOOK</Btn>
                <Btn onClick={() => setShowAdd("manual")}>+ ADD MANUALLY</Btn>
              </div>
            )}
            {showAdd === "import" && <ImportForm onSave={addLead} onCancel={() => setShowAdd(false)} ping={ping} companySettings={companySettings} />}
            {showAdd === "manual" && <ManualForm onSave={addLead} onCancel={() => setShowAdd(false)} ping={ping} companySettings={companySettings} />}
            {headlinerAwaitingMe.length > 0 && (
              <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.16em", color: TIER_COLORS.Headliner }}>HEADLINER LEADS — YOUR CALL</div>
            )}
            {sortSection(headlinerAwaitingMe, pipelineSort).map((l) => (
              <LeadCard key={l.id} lead={l} roster={assignableRoster} availability={availability} myAnswer={myAvailability[l.id]} highlighted={l.id === highlightLeadId} busy={busyLeadId === l.id} userId={userId} onFetchHistory={fetchLeadHistory} musicianRoster={musicianRoster} rosterProfiles={rosterProfiles} leadMusicians={leadMusicians} onBookMusician={bookMusician} onUnbookMusician={unbookMusician} onUpdateMusicianBooking={updateMusicianBooking} onAddMusicianToHold={addMusicianToHold} onMusicianMeetingBooked={musicianMeetingBooked} onMarkMusicianBooked={markMusicianBooked} onMarkMusicianLost={markMusicianLost} onUndoMusicianPlanning={undoMusicianPlanning} onRemoveAvailability={ownerRetractAvail} onSetAvail={setAvail} onRetractAvail={retractAvail} onUpdateLead={updateLead} onDeleteLead={deleteLead} onSaveNotes={saveNotes} />
            ))}
            {checking.length > 0 && <SortToggle sortBy={pipelineSort.by} sortDir={pipelineSort.dir} onChange={toggleSectionSort(setPipelineSort)} />}
            {checking.length === 0 && !showAdd && (
              <Empty text="No leads in date check. Import a HoneyBook inquiry and your roster gets pinged for availability." />
            )}
            {checking.filter((l) => leadStatus(l) === "ready" && !isAwaitingMyHeadlinerCall(l)).length > 0 && (
              <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.16em", color: T.green }}>DJ AVAILABLE — CONTACT THESE LEADS</div>
            )}
            {sortSection(checking.filter((l) => leadStatus(l) === "ready" && !isAwaitingMyHeadlinerCall(l)), pipelineSort).map((l) => (
              <LeadCard key={l.id} lead={l} roster={assignableRoster} availability={availability} myAnswer={myAvailability[l.id]} highlighted={l.id === highlightLeadId} busy={busyLeadId === l.id} userId={userId} onFetchHistory={fetchLeadHistory} musicianRoster={musicianRoster} rosterProfiles={rosterProfiles} leadMusicians={leadMusicians} onBookMusician={bookMusician} onUnbookMusician={unbookMusician} onUpdateMusicianBooking={updateMusicianBooking} onAddMusicianToHold={addMusicianToHold} onMusicianMeetingBooked={musicianMeetingBooked} onMarkMusicianBooked={markMusicianBooked} onMarkMusicianLost={markMusicianLost} onUndoMusicianPlanning={undoMusicianPlanning} onRemoveAvailability={ownerRetractAvail} onSetAvail={setAvail} onRetractAvail={retractAvail} onUpdateLead={updateLead} onDeleteLead={deleteLead} onSaveNotes={saveNotes} />
            ))}
            {checking.filter((l) => leadStatus(l) === "checking" && !isAwaitingMyHeadlinerCall(l)).length > 0 && (
              <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.16em", color: T.accent, marginTop: 4 }}>WAITING ON DATE CHECKS</div>
            )}
            {sortSection(checking.filter((l) => leadStatus(l) === "checking"), pipelineSort).map((l) => (
              <LeadCard key={l.id} lead={l} roster={assignableRoster} availability={availability} myAnswer={myAvailability[l.id]} highlighted={l.id === highlightLeadId} busy={busyLeadId === l.id} userId={userId} onFetchHistory={fetchLeadHistory} musicianRoster={musicianRoster} rosterProfiles={rosterProfiles} leadMusicians={leadMusicians} onBookMusician={bookMusician} onUnbookMusician={unbookMusician} onUpdateMusicianBooking={updateMusicianBooking} onAddMusicianToHold={addMusicianToHold} onMusicianMeetingBooked={musicianMeetingBooked} onMarkMusicianBooked={markMusicianBooked} onMarkMusicianLost={markMusicianLost} onUndoMusicianPlanning={undoMusicianPlanning} onRemoveAvailability={ownerRetractAvail} onSetAvail={setAvail} onRetractAvail={retractAvail} onUpdateLead={updateLead} onDeleteLead={deleteLead} onSaveNotes={saveNotes} />
            ))}
          </>
        )}

        {role === "owner" && activeTab === "pending" && (
          <>
            <DjFilterBar roster={roster} value={motionDjFilter} onChange={setMotionDjFilter} />
            {filteredMeetings.length === 0 && filteredPending.length === 0 && (
              <Empty text={motionDjFilter === "all" ? "No meetings booked yet. When a date check comes back green, book the meeting and it moves here." : "Nothing pending for this DJ yet."} />
            )}
            {filteredMeetings.length > 0 && (
              <>
                <SectionLabel>MEETING BOOKED</SectionLabel>
                <SortToggle sortBy={ownerMeetingBookedSort.by} sortDir={ownerMeetingBookedSort.dir} onChange={toggleSectionSort(setOwnerMeetingBookedSort)} />
                {sortSection(filteredMeetings, ownerMeetingBookedSort).map((l) => (
                  <LeadCard key={l.id} lead={l} roster={assignableRoster} availability={availability} myAnswer={myAvailability[l.id]} highlighted={l.id === highlightLeadId} busy={busyLeadId === l.id} userId={userId} onFetchHistory={fetchLeadHistory} musicianRoster={musicianRoster} rosterProfiles={rosterProfiles} leadMusicians={leadMusicians} onBookMusician={bookMusician} onUnbookMusician={unbookMusician} onUpdateMusicianBooking={updateMusicianBooking} onAddMusicianToHold={addMusicianToHold} onMusicianMeetingBooked={musicianMeetingBooked} onMarkMusicianBooked={markMusicianBooked} onMarkMusicianLost={markMusicianLost} onUndoMusicianPlanning={undoMusicianPlanning} onRemoveAvailability={ownerRetractAvail} onSetAvail={setAvail} onRetractAvail={retractAvail} onUpdateLead={updateLead} onDeleteLead={deleteLead} onSaveNotes={saveNotes} />
                ))}
              </>
            )}
            {filteredPending.length > 0 && (
              <>
                <SectionLabel>FOLLOW UP</SectionLabel>
                <SortToggle sortBy={ownerFollowUpSort.by} sortDir={ownerFollowUpSort.dir} onChange={toggleSectionSort(setOwnerFollowUpSort)} />
                {sortSection(filteredPending, ownerFollowUpSort).map((l) => (
                  <LeadCard key={l.id} lead={l} roster={assignableRoster} availability={availability} myAnswer={myAvailability[l.id]} highlighted={l.id === highlightLeadId} busy={busyLeadId === l.id} userId={userId} onFetchHistory={fetchLeadHistory} musicianRoster={musicianRoster} rosterProfiles={rosterProfiles} leadMusicians={leadMusicians} onBookMusician={bookMusician} onUnbookMusician={unbookMusician} onUpdateMusicianBooking={updateMusicianBooking} onAddMusicianToHold={addMusicianToHold} onMusicianMeetingBooked={musicianMeetingBooked} onMarkMusicianBooked={markMusicianBooked} onMarkMusicianLost={markMusicianLost} onUndoMusicianPlanning={undoMusicianPlanning} onRemoveAvailability={ownerRetractAvail} onSetAvail={setAvail} onRetractAvail={retractAvail} onUpdateLead={updateLead} onDeleteLead={deleteLead} onSaveNotes={saveNotes} />
                ))}
              </>
            )}
          </>
        )}

        {role === "owner" && activeTab === "upcoming" && (
          <>
            <DjFilterBar roster={roster} value={motionDjFilter} onChange={setMotionDjFilter} />
            {filteredUpcoming.length > 0 && <SortToggle sortBy={sortBy} sortDir={sortDir} onChange={handleSortChange} />}
            {filteredUpcoming.length === 0 && (
              <Empty text={motionDjFilter === "all" ? "No upcoming booked gigs yet." : "No upcoming booked gigs for this DJ yet."} />
            )}
            {sortLeads(filteredUpcoming).map((l) => (
              <LeadCard key={l.id} lead={l} roster={assignableRoster} availability={availability} myAnswer={myAvailability[l.id]} highlighted={l.id === highlightLeadId} busy={busyLeadId === l.id} userId={userId} onFetchHistory={fetchLeadHistory} musicianRoster={musicianRoster} rosterProfiles={rosterProfiles} leadMusicians={leadMusicians} onBookMusician={bookMusician} onUnbookMusician={unbookMusician} onUpdateMusicianBooking={updateMusicianBooking} onAddMusicianToHold={addMusicianToHold} onMusicianMeetingBooked={musicianMeetingBooked} onMarkMusicianBooked={markMusicianBooked} onMarkMusicianLost={markMusicianLost} onUndoMusicianPlanning={undoMusicianPlanning} onRemoveAvailability={ownerRetractAvail} onSetAvail={setAvail} onRetractAvail={retractAvail} onUpdateLead={updateLead} onDeleteLead={deleteLead} onSaveNotes={saveNotes} />
            ))}
          </>
        )}

        {role === "owner" && activeTab === "past" && (
          <>
            <DjFilterBar roster={roster} value={motionDjFilter} onChange={setMotionDjFilter} />
            {filteredPast.length > 0 && <SortToggle sortBy={sortBy} sortDir={sortDir} onChange={handleSortChange} />}
            {filteredPast.length === 0 && (
              <Empty text={motionDjFilter === "all" ? "Nothing here — booked gigs whose date has passed show up until marked completed." : "No past booked gigs for this DJ yet."} />
            )}
            {sortLeads(filteredPast).map((l) => (
              <LeadCard key={l.id} lead={l} roster={assignableRoster} availability={availability} myAnswer={myAvailability[l.id]} highlighted={l.id === highlightLeadId} busy={busyLeadId === l.id} userId={userId} onFetchHistory={fetchLeadHistory} musicianRoster={musicianRoster} rosterProfiles={rosterProfiles} leadMusicians={leadMusicians} onBookMusician={bookMusician} onUnbookMusician={unbookMusician} onUpdateMusicianBooking={updateMusicianBooking} onAddMusicianToHold={addMusicianToHold} onMusicianMeetingBooked={musicianMeetingBooked} onMarkMusicianBooked={markMusicianBooked} onMarkMusicianLost={markMusicianLost} onUndoMusicianPlanning={undoMusicianPlanning} onRemoveAvailability={ownerRetractAvail} onSetAvail={setAvail} onRetractAvail={retractAvail} onUpdateLead={updateLead} onDeleteLead={deleteLead} onSaveNotes={saveNotes} />
            ))}
          </>
        )}

        {role === "owner" && activeTab === "archive" && (
          <>
            {archived.length === 0 && <Empty text="Completed and lost leads end up here." />}
            {archived.map((l) => (
              <LeadCard key={l.id} lead={l} roster={assignableRoster} availability={availability} myAnswer={myAvailability[l.id]} highlighted={l.id === highlightLeadId} busy={busyLeadId === l.id} userId={userId} onFetchHistory={fetchLeadHistory} musicianRoster={musicianRoster} rosterProfiles={rosterProfiles} leadMusicians={leadMusicians} onBookMusician={bookMusician} onUnbookMusician={unbookMusician} onUpdateMusicianBooking={updateMusicianBooking} onAddMusicianToHold={addMusicianToHold} onMusicianMeetingBooked={musicianMeetingBooked} onMarkMusicianBooked={markMusicianBooked} onMarkMusicianLost={markMusicianLost} onUndoMusicianPlanning={undoMusicianPlanning} onRemoveAvailability={ownerRetractAvail} onSetAvail={setAvail} onRetractAvail={retractAvail} onUpdateLead={updateLead} onDeleteLead={deleteLead} onSaveNotes={saveNotes} />
            ))}
          </>
        )}

        {role === "owner" && activeTab === "roster" && (
          <Roster roster={roster} musicianRoster={musicianRoster} rosterProfiles={rosterProfiles} leads={leads} leadMusicians={leadMusicians} onChanged={loadData} onSetTiers={saveDjTiers} onSetNotify={saveDjNotify} onSetInstrument={saveMusicianInstrument} ping={ping} confirm={confirmAction} />
        )}

        {role === "owner" && activeTab === "settings" && companySettings && (
          <CompanySettings settings={companySettings} onSave={saveSettings} />
        )}

        {role === "dj" && activeTab === "home" && (
          <>
            <StatusBanner allCaughtUp={needsMe.length === 0} />
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <StatCard value={needsMe.length} label="DATE CHECKS" urgent={needsMe.length > 0} onClick={() => setTab("checks")} />
              <StatCard value={myUpcoming.length} label="EVENTS BOOKED" onClick={() => setTab("upcoming")} />
              <StatCard value={myCompleted.length} label="EVENTS COMPLETED" onClick={() => setTab("completed")} />
              <StatCard value={`$${myMoneyMade}`} label="EARNED FROM BOOKINGS" />
              <StatCard value={myStreak} label="RESPONSE STREAK" />
            </div>
            <BadgeRow streak={myStreak} />
            <NextEventCard
              lead={nextDjEvent}
              subtitle={nextDjEvent ? tierStr(nextDjEvent) : ""}
              emptyText="No upcoming events booked yet."
              onView={() => setTab("upcoming")}
            />
            <SectionLabel>YOUR CALENDAR</SectionLabel>
            <GigCalendar
              events={[
                ...myUpcoming.filter((l) => l.event_date).map((l) => ({ id: l.id, date: l.event_date as string, done: false })),
                ...myCompleted.filter((l) => l.event_date).map((l) => ({ id: l.id, date: l.event_date as string, done: true })),
              ]}
              onSelectEvent={(id, done) => goToCalendarEvent(id, done ? "completed" : "upcoming")}
            />
          </>
        )}

        {role === "dj" && activeTab === "checks" && (
          <>
            {roster.length === 0 && checking.length === 0 && <Empty text="No open date checks yet." />}
            <div style={{ fontSize: 11, color: T.dim }}>
              {myTiers.length === 0
                ? "No tiers assigned yet — ask Austin to set your tiers in Roster."
                : `Your tiers: ${myTiers.join(", ")}`}
            </div>
            {myTiers.length > 0 && myChecks.length === 0 && checking.length > 0 && (
              <Empty text="No date checks match your assigned tiers right now." />
            )}
            {checking.length === 0 && <Empty text="No open date checks. New ones light up amber when they drop." />}
            {needsMe.length > 0 ? (
              <>
                <SectionLabel large>NEED AVAILABILITY</SectionLabel>
                <SortToggle sortBy={needAvailSort.by} sortDir={needAvailSort.dir} onChange={toggleSectionSort(setNeedAvailSort)} />
                {sortSection(needsMe, needAvailSort).map((l) => (
                  <LeadCard key={l.id} lead={l} djView roster={roster} availability={availability} myAnswer={myAvailability[l.id]} highlighted={l.id === highlightLeadId} busy={busyLeadId === l.id} userId={userId} onFetchHistory={fetchLeadHistory} musicianRoster={musicianRoster} rosterProfiles={rosterProfiles} leadMusicians={leadMusicians} onBookMusician={bookMusician} onUnbookMusician={unbookMusician} onUpdateMusicianBooking={updateMusicianBooking} onAddMusicianToHold={addMusicianToHold} onMusicianMeetingBooked={musicianMeetingBooked} onMarkMusicianBooked={markMusicianBooked} onMarkMusicianLost={markMusicianLost} onUndoMusicianPlanning={undoMusicianPlanning} onRemoveAvailability={ownerRetractAvail} onSetAvail={setAvail} onRetractAvail={retractAvail} onUpdateLead={updateLead} onDeleteLead={deleteLead} onSaveNotes={saveNotes} />
                ))}
              </>
            ) : myChecks.length > 0 && <Empty text="All caught up!" />}
            {myMarkedAvailable.length > 0 && (
              <>
                <SectionLabel large>MARKED AVAILABLE</SectionLabel>
                <SortToggle sortBy={markedAvailSort.by} sortDir={markedAvailSort.dir} onChange={toggleSectionSort(setMarkedAvailSort)} />
                {sortSection(myMarkedAvailable, markedAvailSort).map((l) => (
                  <LeadCard key={l.id} lead={l} djView roster={roster} availability={availability} myAnswer={myAvailability[l.id]} highlighted={l.id === highlightLeadId} busy={busyLeadId === l.id} userId={userId} onFetchHistory={fetchLeadHistory} musicianRoster={musicianRoster} rosterProfiles={rosterProfiles} leadMusicians={leadMusicians} onBookMusician={bookMusician} onUnbookMusician={unbookMusician} onUpdateMusicianBooking={updateMusicianBooking} onAddMusicianToHold={addMusicianToHold} onMusicianMeetingBooked={musicianMeetingBooked} onMarkMusicianBooked={markMusicianBooked} onMarkMusicianLost={markMusicianLost} onUndoMusicianPlanning={undoMusicianPlanning} onRemoveAvailability={ownerRetractAvail} onSetAvail={setAvail} onRetractAvail={retractAvail} onUpdateLead={updateLead} onDeleteLead={deleteLead} onSaveNotes={saveNotes} />
                ))}
              </>
            )}
          </>
        )}

        {role === "dj" && activeTab === "pending" && (
          <>
            {myPending.length === 0 && (
              <Empty text="Leads you're available for, or that Austin has assigned you to, land here until he marks it booked." />
            )}
            {myAssignedMeeting.length > 0 && (
              <>
                <SectionLabel large>PENDING BOOKING</SectionLabel>
                <SortToggle sortBy={pendingBookingSort.by} sortDir={pendingBookingSort.dir} onChange={toggleSectionSort(setPendingBookingSort)} />
                {sortSection(myAssignedMeeting, pendingBookingSort).map((l) => (
                  <LeadCard key={l.id} lead={l} djView roster={roster} availability={availability} myAnswer={myAvailability[l.id]} highlighted={l.id === highlightLeadId} busy={busyLeadId === l.id} userId={userId} onFetchHistory={fetchLeadHistory} musicianRoster={musicianRoster} rosterProfiles={rosterProfiles} leadMusicians={leadMusicians} onBookMusician={bookMusician} onUnbookMusician={unbookMusician} onUpdateMusicianBooking={updateMusicianBooking} onAddMusicianToHold={addMusicianToHold} onMusicianMeetingBooked={musicianMeetingBooked} onMarkMusicianBooked={markMusicianBooked} onMarkMusicianLost={markMusicianLost} onUndoMusicianPlanning={undoMusicianPlanning} onRemoveAvailability={ownerRetractAvail} onSetAvail={setAvail} onRetractAvail={retractAvail} onUpdateLead={updateLead} onDeleteLead={deleteLead} onSaveNotes={saveNotes} />
                ))}
              </>
            )}
            {myAwaitingSelection.length > 0 && (
              <>
                <SectionLabel large>SCHEDULED TO MEET WITH AUSTO</SectionLabel>
                <SortToggle sortBy={awaitingSelectionSort.by} sortDir={awaitingSelectionSort.dir} onChange={toggleSectionSort(setAwaitingSelectionSort)} />
                {sortSection(myAwaitingSelection, awaitingSelectionSort).map((l) => (
                  <LeadCard key={l.id} lead={l} djView roster={roster} availability={availability} myAnswer={myAvailability[l.id]} highlighted={l.id === highlightLeadId} busy={busyLeadId === l.id} userId={userId} onFetchHistory={fetchLeadHistory} musicianRoster={musicianRoster} rosterProfiles={rosterProfiles} leadMusicians={leadMusicians} onBookMusician={bookMusician} onUnbookMusician={unbookMusician} onUpdateMusicianBooking={updateMusicianBooking} onAddMusicianToHold={addMusicianToHold} onMusicianMeetingBooked={musicianMeetingBooked} onMarkMusicianBooked={markMusicianBooked} onMarkMusicianLost={markMusicianLost} onUndoMusicianPlanning={undoMusicianPlanning} onRemoveAvailability={ownerRetractAvail} onSetAvail={setAvail} onRetractAvail={retractAvail} onUpdateLead={updateLead} onDeleteLead={deleteLead} onSaveNotes={saveNotes} />
                ))}
              </>
            )}
          </>
        )}

        {role === "dj" && activeTab === "archive" && (
          <>
            {myArchive.length === 0 && (
              <Empty text="Leads you've passed on land here. Your availability's still visible on each one if that changes." />
            )}
            {myArchive.length > 0 && <SortToggle sortBy={sortBy} sortDir={sortDir} onChange={handleSortChange} />}
            {sortLeads(myArchive).map((l) => (
              <LeadCard key={l.id} lead={l} djView roster={roster} availability={availability} myAnswer={myAvailability[l.id]} highlighted={l.id === highlightLeadId} busy={busyLeadId === l.id} userId={userId} onFetchHistory={fetchLeadHistory} musicianRoster={musicianRoster} rosterProfiles={rosterProfiles} leadMusicians={leadMusicians} onBookMusician={bookMusician} onUnbookMusician={unbookMusician} onUpdateMusicianBooking={updateMusicianBooking} onAddMusicianToHold={addMusicianToHold} onMusicianMeetingBooked={musicianMeetingBooked} onMarkMusicianBooked={markMusicianBooked} onMarkMusicianLost={markMusicianLost} onUndoMusicianPlanning={undoMusicianPlanning} onRemoveAvailability={ownerRetractAvail} onSetAvail={setAvail} onRetractAvail={retractAvail} onUpdateLead={updateLead} onDeleteLead={deleteLead} onSaveNotes={saveNotes} />
            ))}
          </>
        )}

        {role === "dj" && activeTab === "upcoming" && (
          <>
            {myUpcoming.length === 0 && <Empty text="No booked gigs yet — answer date checks and Austin books from there." />}
            {myUpcoming.sort(byDate).map((l) => (
              <LeadCard key={l.id} lead={l} djView roster={roster} availability={availability} myAnswer={myAvailability[l.id]} highlighted={l.id === highlightLeadId || l.id === calHighlightId} busy={busyLeadId === l.id} userId={userId} onFetchHistory={fetchLeadHistory} musicianRoster={musicianRoster} rosterProfiles={rosterProfiles} leadMusicians={leadMusicians} onBookMusician={bookMusician} onUnbookMusician={unbookMusician} onUpdateMusicianBooking={updateMusicianBooking} onAddMusicianToHold={addMusicianToHold} onMusicianMeetingBooked={musicianMeetingBooked} onMarkMusicianBooked={markMusicianBooked} onMarkMusicianLost={markMusicianLost} onUndoMusicianPlanning={undoMusicianPlanning} onRemoveAvailability={ownerRetractAvail} onSetAvail={setAvail} onRetractAvail={retractAvail} onUpdateLead={updateLead} onDeleteLead={deleteLead} onSaveNotes={saveNotes} />
            ))}
          </>
        )}

        {role === "dj" && activeTab === "completed" && (
          <>
            {myCompleted.length === 0 && <Empty text="Completed gigs show up here once the event has passed and you've been paid in full." />}
            {myCompleted.sort((a, b) => byDate(b, a)).map((l) => (
              <LeadCard key={l.id} lead={l} djView roster={roster} availability={availability} myAnswer={myAvailability[l.id]} highlighted={l.id === highlightLeadId || l.id === calHighlightId} busy={busyLeadId === l.id} userId={userId} onFetchHistory={fetchLeadHistory} musicianRoster={musicianRoster} rosterProfiles={rosterProfiles} leadMusicians={leadMusicians} onBookMusician={bookMusician} onUnbookMusician={unbookMusician} onUpdateMusicianBooking={updateMusicianBooking} onAddMusicianToHold={addMusicianToHold} onMusicianMeetingBooked={musicianMeetingBooked} onMarkMusicianBooked={markMusicianBooked} onMarkMusicianLost={markMusicianLost} onUndoMusicianPlanning={undoMusicianPlanning} onRemoveAvailability={ownerRetractAvail} onSetAvail={setAvail} onRetractAvail={retractAvail} onUpdateLead={updateLead} onDeleteLead={deleteLead} onSaveNotes={saveNotes} />
            ))}
          </>
        )}

        {role === "dj" && activeTab === "leaderboard" && (
          <>
            <a
              href="/leaderboard-winner.png"
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: 11.5, fontWeight: 700, color: T.dim, textDecoration: "underline", alignSelf: "flex-start" }}
            >
              Gentleman, your winner
            </a>
            <AvatarUpload userId={userId} currentUrl={myLeaderboardRow?.avatar_url ?? null} onChanged={loadData} ping={ping} />
            <SectionLabel>EVENTS BOOKED</SectionLabel>
            <DjBarChart
              userId={userId}
              unit="event"
              rows={bookedLeaderboard.map((r) => ({ dj_id: r.dj_id, display_name: r.display_name, email: r.email, avatar_url: r.avatar_url, count: r.booked_count, total: r.booked_total }))}
            />
            <SectionLabel>EVENTS COMPLETED</SectionLabel>
            <DjBarChart
              userId={userId}
              unit="event"
              rows={completedLeaderboard.map((r) => ({ dj_id: r.dj_id, display_name: r.display_name, email: r.email, avatar_url: r.avatar_url, count: r.completed_count, total: r.completed_total }))}
            />
          </>
        )}

        {role === "musician" && activeTab === "musician-home" && (
          <>
            <StatusBanner allCaughtUp={needsMeMusician.length === 0} />
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <StatCard value={needsMeMusician.length} label="DATE CHECKS" urgent={needsMeMusician.length > 0} onClick={() => setTab("musician-checks")} />
              <StatCard value={myMusicianPlanning.length} label="EVENTS BOOKED" onClick={() => setTab("musician-upcoming")} />
              <StatCard value={myMusicianComplete.length} label="EVENTS COMPLETED" onClick={() => setTab("musician-completed")} />
              <StatCard value={`$${myMusicianMoneyMade}`} label="EARNED FROM BOOKINGS" />
              <StatCard value={myMusicianStreak} label="RESPONSE STREAK" />
            </div>
            <BadgeRow streak={myMusicianStreak} />
            <NextEventCard
              lead={nextMusicianEvent}
              subtitle={nextMusicianBooking?.services?.join(", ") || ""}
              emptyText="No upcoming events booked yet."
              onView={() => setTab("musician-upcoming")}
            />
            <SectionLabel>YOUR CALENDAR</SectionLabel>
            <GigCalendar
              events={[
                ...myMusicianPlanning.filter((l) => l.event_date).map((l) => ({ id: l.id, date: l.event_date as string, done: false })),
                ...myMusicianComplete.filter((l) => l.event_date).map((l) => ({ id: l.id, date: l.event_date as string, done: true })),
              ]}
              onSelectEvent={(id, done) => goToCalendarEvent(id, done ? "musician-completed" : "musician-upcoming")}
            />
          </>
        )}

        {role === "musician" && activeTab === "musician-checks" && (
          <>
            {!myInstrument && <Empty text="No instrument on file yet — ask Austin to set it in Roster." />}
            {myInstrument && newMusicianLeads.length === 0 && <Empty text="No open date checks. New ones show up here when a lead mentions your instrument." />}
            {myInstrument && newMusicianLeads.length > 0 && myMusicianChecks.length === 0 && (
              <Empty text="No open leads mention your instrument right now." />
            )}
            {needsMeMusician.length > 0 ? (
              <>
                <SectionLabel large>NEED AVAILABILITY</SectionLabel>
                <SortToggle sortBy={needAvailMusicianSort.by} sortDir={needAvailMusicianSort.dir} onChange={toggleSectionSort(setNeedAvailMusicianSort)} />
                {sortSection(needsMeMusician, needAvailMusicianSort).map((l) => (
                  <MusicianLeadCard key={l.id} lead={l} myAnswer={myAvailability[l.id]} onSetAvail={setAvail} onRetractAvail={retractAvail} busy={busyLeadId === l.id} highlighted={l.id === highlightLeadId} />
                ))}
              </>
            ) : myMusicianChecks.length > 0 && <Empty text="All caught up!" />}
            {myMusicianMarkedAvailable.length > 0 && (
              <>
                <SectionLabel large>MARKED AVAILABLE</SectionLabel>
                <SortToggle sortBy={markedAvailMusicianSort.by} sortDir={markedAvailMusicianSort.dir} onChange={toggleSectionSort(setMarkedAvailMusicianSort)} />
                {sortSection(myMusicianMarkedAvailable, markedAvailMusicianSort).map((l) => (
                  <MusicianLeadCard key={l.id} lead={l} myAnswer={myAvailability[l.id]} onSetAvail={setAvail} onRetractAvail={retractAvail} busy={busyLeadId === l.id} highlighted={l.id === highlightLeadId} />
                ))}
              </>
            )}
          </>
        )}

        {role === "musician" && activeTab === "musician-pending" && (
          <>
            {myMusicianPendingBooking.length === 0 && (
              <Empty text="Leads where Austin's had the intro call and the hold is on land here until it books or falls through." />
            )}
            {myMusicianPendingBooking.length > 0 && <SortToggle sortBy={pendingBookingMusicianSort.by} sortDir={pendingBookingMusicianSort.dir} onChange={toggleSectionSort(setPendingBookingMusicianSort)} />}
            {sortSection(myMusicianPendingBooking, pendingBookingMusicianSort).map((l) => (
              <MusicianLeadCard key={l.id} lead={l} myAnswer={myAvailability[l.id]} onSetAvail={setAvail} onRetractAvail={retractAvail} busy={busyLeadId === l.id} highlighted={l.id === highlightLeadId} />
            ))}
          </>
        )}

        {role === "musician" && activeTab === "musician-archive" && (
          <>
            {myMusicianArchive.length === 0 && (
              <Empty text="Leads that went cold — whether Austin closed it out or you passed — land here. Your response is still visible if anything changes." />
            )}
            {myMusicianArchive.length > 0 && <SortToggle sortBy={sortBy} sortDir={sortDir} onChange={handleSortChange} />}
            {sortLeads(myMusicianArchive).map((l) => (
              <MusicianLeadCard key={l.id} lead={l} myAnswer={myAvailability[l.id]} onSetAvail={setAvail} onRetractAvail={retractAvail} busy={busyLeadId === l.id} highlighted={l.id === highlightLeadId} />
            ))}
          </>
        )}

        {role === "musician" && activeTab === "musician-upcoming" && (
          <>
            {myMusicianPlanning.length === 0 && <Empty text="No gigs booked yet — Austin will add you to a lead once a client books live music." />}
            {myMusicianPlanning.sort(byDate).map((l) => {
              const booking = myMusicianBookings.find((b) => b.lead_id === l.id);
              return booking ? <MusicianLeadCard key={l.id} lead={l} booking={booking} highlighted={l.id === highlightLeadId || l.id === calHighlightId} /> : null;
            })}
          </>
        )}

        {role === "musician" && activeTab === "musician-completed" && (
          <>
            {myMusicianComplete.length === 0 && <Empty text="Completed gigs show up here once the event has passed." />}
            {myMusicianComplete.sort((a, b) => byDate(b, a)).map((l) => {
              const booking = myMusicianBookings.find((b) => b.lead_id === l.id);
              return booking ? <MusicianLeadCard key={l.id} lead={l} booking={booking} highlighted={l.id === highlightLeadId || l.id === calHighlightId} /> : null;
            })}
          </>
        )}
        </>
        )}
      </main>

      {toasts.length > 0 && (
        <div style={{
          position: "fixed", bottom: 18, left: "50%", transform: "translateX(-50%)",
          display: "flex", flexDirection: "column", gap: 8, alignItems: "center", zIndex: 50,
        }}>
          {toasts.map((t) => (
            <div key={t.id} style={{
              background: T.raised, border: `1px solid ${T.accent}66`, color: T.text,
              padding: "10px 18px", borderRadius: 8, fontSize: 13, fontWeight: 700,
              boxShadow: "0 6px 24px rgba(0,0,0,.5)",
              maxWidth: "90vw", textAlign: "center",
            }}>
              {t.message}
            </div>
          ))}
        </div>
      )}

      {confirmState && (
        <div
          role="presentation"
          onClick={() => { confirmState.resolve(false); setConfirmState(null); }}
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,.6)",
            display: "grid", placeItems: "center", zIndex: 60, padding: 16,
          }}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
            style={{
              background: T.surface, border: `1px solid ${T.line}`, borderRadius: 10,
              padding: 20, maxWidth: 360, width: "100%", display: "flex", flexDirection: "column", gap: 16,
              boxShadow: "0 12px 40px rgba(0,0,0,.5)",
            }}
          >
            <div style={{ fontSize: 14, lineHeight: 1.5 }}>{confirmState.message}</div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <Btn kind="ghost" small onClick={() => { confirmState.resolve(false); setConfirmState(null); }}>CANCEL</Btn>
              <Btn kind="danger" small onClick={() => { confirmState.resolve(true); setConfirmState(null); }}>{confirmState.confirmLabel.toUpperCase()}</Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
