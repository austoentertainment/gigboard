"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { Database, DjTier, ProdTier, TravelZone, Instrument, MusicianService } from "@/lib/supabase/types";
import { tierRate, travelRate, guessTravelZone } from "@/lib/rates";
import { INSTRUMENT_KEYWORD } from "@/lib/instruments";
import {
  T, DJ_TIERS, LEAD_STATUS, fmtDate,
  Lamp, Tag, Btn, Field, Input, Select, TextArea, Empty, TierPicker, SectionLabel,
  MUSICIAN_INSTRUMENTS, MUSICIAN_SERVICES, TIER_COLORS,
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
const bySubmitted = (a: LeadRow, b: LeadRow) => (new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

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

function AvailChips({ lead, roster, availability }: { lead: LeadRow; roster: RosterUser[]; availability: AvailabilityRow[] }) {
  const responses = availability.filter((r) => r.lead_id === lead.id);
  const rosterMap = Object.fromEntries(roster.map((d) => [d.id, d.display_name || d.email]));
  const noReply = roster.filter((d) => !responses.some((r) => r.dj_user_id === d.id)).map((d) => d.display_name || d.email);
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
      {responses.map((r) => (
        <span key={r.dj_user_id} style={{
          fontSize: 11.5, fontWeight: 700, padding: "3px 8px", borderRadius: 20,
          background: r.response === "available" ? T.green + "22" : T.red + "18",
          color: r.response === "available" ? T.green : T.red,
          border: `1px solid ${r.response === "available" ? T.green : T.red}44`,
        }}>
          {rosterMap[r.dj_user_id] || "?"} {r.response === "available" ? "✓" : "✕"}
        </span>
      ))}
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

function MusicianBookingRow({
  musician, instrument, booking, onUnbook, onUpdate,
}: {
  musician: RosterUser;
  instrument: Instrument | null | undefined;
  booking: LeadMusicianRow;
  onUnbook: (id: string, label: string) => void;
  onUpdate: (id: string, patch: { services?: MusicianService[]; payout?: number | null }, msg?: string) => void;
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
    </div>
  );
}

function MusicianBooking({
  leadId, musicianRoster, rosterProfiles, bookings, onBook, onUnbook, onUpdate,
}: {
  leadId: string;
  musicianRoster: RosterUser[];
  rosterProfiles: { user_id: string; instrument: Instrument | null }[];
  bookings: LeadMusicianRow[];
  onBook: (leadId: string, musicianId: string) => void;
  onUnbook: (id: string, label: string) => void;
  onUpdate: (id: string, patch: { services?: MusicianService[]; payout?: number | null }, msg?: string) => void;
}) {
  if (musicianRoster.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.14em", color: T.dim }}>MUSICIANS</span>
      {musicianRoster.map((m) => {
        const instrument = rosterProfiles.find((p) => p.user_id === m.id)?.instrument;
        const booking = bookings.find((b) => b.musician_id === m.id);
        if (!booking) {
          return (
            <Btn key={m.id} kind="ghost" small style={{ alignSelf: "flex-start" }} onClick={() => onBook(leadId, m.id)}>
              + BOOK {m.display_name || m.email}{instrument ? ` (${instrument})` : ""}
            </Btn>
          );
        }
        return (
          <MusicianBookingRow key={m.id} musician={m} instrument={instrument} booking={booking} onUnbook={onUnbook} onUpdate={onUpdate} />
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
    notes: lead.owner_notes || "",
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
      <SectionLabel>NOTES</SectionLabel>
      <Field label="PRIVATE NOTES (OWNER ONLY)"><TextArea value={f.notes} onChange={set("notes")} /></Field>
      <Field label="NOTES FOR DJs (SHOWN ON DATE CHECK)"><TextArea value={f.djNotes} onChange={set("djNotes")} /></Field>
      <div style={{ fontSize: 11.5, color: T.dim }}>Payout, travel, and deposit status are edited directly on the card, not here.</div>
      <div style={{ display: "flex", gap: 8 }}>
        <Btn kind="primary" onClick={() => onSave({
          client_name: f.name, fiance_name: f.fianceName, contact: f.contact, event_date: f.date || null,
          location: f.location, dj_tier: (f.djTier || null) as DjTier | null, prod_tier: (f.prodTier || null) as ProdTier | null,
          upgrades: f.upgrades, client_vision: f.vision, owner_notes: f.notes, dj_notes: f.djNotes,
        })}>SAVE CHANGES</Btn>
        <Btn onClick={onCancel}>CANCEL</Btn>
      </div>
    </div>
  );
}

function LeadCard({
  lead, djView, roster, availability, myAnswer, highlighted, busy, userId, onFetchHistory,
  musicianRoster, rosterProfiles, leadMusicians, onBookMusician, onUnbookMusician, onUpdateMusicianBooking,
  onSetAvail, onUpdateLead, onDeleteLead, onSaveNotes,
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
  onUpdateMusicianBooking: (id: string, patch: { services?: MusicianService[]; payout?: number | null }, msg?: string) => void;
  onSetAvail: (leadId: string, answer: "available" | "pass") => void;
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
  // "Follow Up" is a per-DJ view, not a stored lead status — the lead itself
  // is still "ready" (someone's available) until the owner books a meeting,
  // but a DJ who already said yes needs their own copy to read "waiting on
  // Austin" rather than the generic "DJ AVAILABLE" call-to-action.
  const iAmFollowingUp = djView && st === "ready" && myAnswer === "available";
  // Same idea for a DJ who's passed — the lead is unchanged for everyone
  // else, but their own Archive copy should read "PASSED", not the
  // generic checking/ready label.
  const iHavePassed = djView && myAnswer === "pass" && ["checking", "ready"].includes(st);
  const statusLabel = !djView && ["booked", "played"].includes(st) && assignedDjName
    ? assignedDjName
    : iAmFollowingUp ? "FOLLOW UP" : iHavePassed ? "PASSED" : s.label;
  const statusColor = iAmFollowingUp ? T.violet : iHavePassed ? T.dim : s.color;

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
        {expanded && !djView && lead.owner_notes && <div style={{ fontSize: 12.5, color: T.dim, whiteSpace: "pre-wrap" }}>{lead.owner_notes}</div>}

        {expanded && !djView && ["checking", "ready", "meeting"].includes(st) && <AvailChips lead={lead} roster={roster} availability={availability} />}

        {expanded && ["meeting", "booked", "played"].includes(st) && <MeetingNotesEditor lead={lead} onSave={onSaveNotes} />}

        {expanded && !djView && ["meeting", "booked", "played"].includes(st) && (
          <MusicianBooking
            leadId={lead.id}
            musicianRoster={musicianRoster}
            rosterProfiles={rosterProfiles}
            bookings={leadMusicians.filter((lm) => lm.lead_id === lead.id)}
            onBook={onBookMusician}
            onUnbook={onUnbookMusician}
            onUpdate={onUpdateMusicianBooking}
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
          {djView && ["checking", "ready"].includes(st) && (
            <>
              <Btn kind={myAnswer === "available" ? "green" : "primary"} small onClick={() => onSetAvail(lead.id, "available")}>
                {myAnswer === "available" ? "✓ I'M AVAILABLE" : "I'M AVAILABLE"}
              </Btn>
              <Btn kind={myAnswer === "pass" ? "danger" : "ghost"} small onClick={() => onSetAvail(lead.id, "pass")}>
                {myAnswer === "pass" ? "✕ PASSED" : "PASS"}
              </Btn>
            </>
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
                {(availDjIds.length ? roster.filter((d) => availDjIds.includes(d.id)) : roster).map((d) => (
                  <option key={d.id} value={d.id}>{d.display_name || d.email}{availDjIds.includes(d.id) ? " (available)" : ""}</option>
                ))}
              </Select>
              <Btn
                kind="primary"
                small
                disabled={!selectedDjId || selectedDjId === lead.assigned_dj_id}
                onClick={() => {
                  const name = roster.find((d) => d.id === selectedDjId)?.display_name || "DJ";
                  onUpdateLead(lead.id, { assigned_dj_id: selectedDjId }, `${name} assigned — waiting on booking`);
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
            if (!parsed.payout && djTier && prodTier) next.payout = String(tierRate(companySettings, djTier, prodTier));
            setParsed(next);
          }} />
          <SectionLabel>PRICING</SectionLabel>
          <Field label="DJ PAYOUT ($) — SHOWN TO DJs">
            <div style={{ display: "flex", gap: 6 }}>
              <Input type="number" value={parsed.payout} onChange={(e) => setParsed({ ...parsed, payout: e.target.value })} style={{ flex: 1 }} />
              {parsed.djTier && parsed.prodTier && (
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
    upgrades: "", vision: "", source: "", notes: "", djNotes: "", payout: "",
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
        if (!f.payout && djTier && prodTier) next.payout = String(tierRate(companySettings, djTier, prodTier));
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
            {f.djTier && f.prodTier && (
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
      <Field label="PRIVATE NOTES (OWNER ONLY)"><TextArea value={f.notes} onChange={set("notes")} /></Field>
      <Field label="NOTES FOR DJs (SHOWN ON DATE CHECK)"><TextArea value={f.djNotes} onChange={set("djNotes")} placeholder="Outdoor ceremony, load-in 3pm…" /></Field>
      <div style={{ display: "flex", gap: 8 }}>
        <Btn kind="primary" onClick={() => {
          if (!f.name.trim() && !f.date) { ping("Give it at least a name or a date"); return; }
          onSave({
            client_name: f.name, fiance_name: f.fianceName, contact: f.contact, event_date: f.date || null, location: f.location,
            dj_tier: (f.djTier || null) as DjTier | null, prod_tier: (f.prodTier || null) as ProdTier | null,
            upgrades: f.upgrades, client_vision: f.vision, source: "manual", owner_notes: f.notes,
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

function Roster({
  roster, musicianRoster, rosterProfiles, leads, leadMusicians, onChanged, onSetTiers, onSetNotify, ping, confirm,
}: {
  roster: RosterUser[];
  musicianRoster: RosterUser[];
  rosterProfiles: { user_id: string; dj_tier_visibility: DjTier[]; instrument: Instrument | null; notify_email: boolean }[];
  leads: LeadRow[];
  leadMusicians: LeadMusicianRow[];
  onChanged: () => void;
  onSetTiers: (djId: string, tiers: DjTier[]) => void;
  onSetNotify: (djId: string, enabled: boolean) => void;
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
        const djLeads = leads.filter((l) => l.assigned_dj_id === dj.id);
        const bookingCount = djLeads.length;
        const bookingTotal = djLeads.reduce((sum, l) => sum + totalPayout(l), 0);
        return (
          <div key={dj.id} style={{ background: T.surface, border: `1px solid ${T.line}`, borderRadius: 8, padding: "10px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
              <div>
                <div style={{ fontWeight: 700 }}>{dj.display_name || "(pending sign-in)"}</div>
                <div style={{ fontSize: 12, color: T.dim }}>{dj.email}</div>
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
                  {profile?.instrument && <Tag color={T.blue}>{profile.instrument}</Tag>}
                </div>
                <div style={{ fontSize: 12, color: T.dim }}>{m.email}</div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ fontSize: 12, color: T.dim, textAlign: "right", whiteSpace: "nowrap" }}>
                  {bookingCount} gig{bookingCount !== 1 ? "s" : ""}{bookingTotal ? ` · $${bookingTotal}` : ""}
                </div>
                <Btn kind="danger" small onClick={() => remove(m.id, m.display_name || m.email)}>REMOVE</Btn>
              </div>
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
    </div>
  );
}

function MusicianLeadCard({
  lead, booking, myAnswer, onSetAvail, busy, highlighted,
}: {
  lead: LeadRow;
  booking?: LeadMusicianRow;
  myAnswer?: "available" | "pass";
  onSetAvail?: (leadId: string, answer: "available" | "pass") => void;
  busy?: boolean;
  highlighted?: boolean;
}) {
  const d = fmtDate(lead.event_date);
  const names = [lead.client_name, lead.fiance_name].filter(Boolean).join(" + ") || "Unnamed lead";
  const services = booking?.services || [];
  // Before a booking exists this card is a date check — it just needs a
  // response tag and the available/pass buttons, not services/payout
  // (those aren't decided until Austin actually books the musician).
  const respondedTag = myAnswer === "available"
    ? { label: "AVAILABLE", color: T.green }
    : myAnswer === "pass"
    ? { label: "PASSED", color: T.dim }
    : { label: "NEEDS RESPONSE", color: T.accent };
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
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div style={{ fontWeight: 800, fontSize: 15, fontFamily: "var(--font-heading), serif" }}>{names}</div>
          {!booking && <Tag color={respondedTag.color}>{respondedTag.label}</Tag>}
        </div>
        <div style={{ fontSize: 12.5, color: T.dim }}>{lead.location || "location TBD"}</div>
        {booking ? (
          <>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {services.map((s) => <Tag key={s} color={T.blue}>{s}</Tag>)}
              {services.length === 0 && <span style={{ fontSize: 11, color: T.red }}>services not set yet — check with Austin</span>}
            </div>
            <div style={{ fontSize: 12.5 }}>
              {booking.payout != null
                ? <>Payout: <strong style={{ color: T.text }}>${booking.payout}</strong></>
                : <span style={{ color: T.dim }}>Payout not set yet</span>}
            </div>
          </>
        ) : onSetAvail && (
          <div style={{ display: "flex", gap: 8 }}>
            <Btn kind={myAnswer === "available" ? "green" : "primary"} small onClick={() => onSetAvail(lead.id, "available")}>
              {myAnswer === "available" ? "✓ I'M AVAILABLE" : "I'M AVAILABLE"}
            </Btn>
            <Btn kind={myAnswer === "pass" ? "danger" : "ghost"} small onClick={() => onSetAvail(lead.id, "pass")}>
              {myAnswer === "pass" ? "✕ PASSED" : "PASS"}
            </Btn>
          </div>
        )}
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
  const [myTiers, setMyTiers] = useState<string[]>([]);
  const [myInstrument, setMyInstrument] = useState<Instrument | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardRow[]>([]);
  const [companySettings, setCompanySettings] = useState<CompanySettings | null>(null);
  const [tab, setTab] = useState("pipeline");
  const [toasts, setToasts] = useState<{ id: number; message: string }[]>([]);
  const [showAdd, setShowAdd] = useState<"import" | "manual" | false>(false);
  const [sortBy, setSortBy] = useState<"event" | "submitted">(role === "dj" ? "submitted" : "event");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [motionDjFilter, setMotionDjFilter] = useState<string>("all");
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
      const { data: leadMusiciansData } = await supabase.from("lead_musicians").select("*");
      setLeadMusicians(leadMusiciansData ?? []);
      const { data: settingsData } = await supabase.from("company_settings").select("*").eq("id", 1).single();
      setCompanySettings(settingsData ?? null);
    } else if (role === "dj") {
      const { data: mine } = await supabase.from("availability_responses").select("lead_id,response").eq("dj_user_id", userId);
      setMyAvailability(Object.fromEntries((mine ?? []).map((r) => [r.lead_id, r.response])));
      const { data: prof } = await supabase.from("dj_profiles").select("dj_tier_visibility").eq("user_id", userId).single();
      setMyTiers(prof?.dj_tier_visibility ?? []);
      const { data: leaderboardData } = await supabase.from("dj_leaderboard").select("*");
      setLeaderboard(leaderboardData ?? []);
    } else {
      const { data: myBookings } = await supabase.from("lead_musicians").select("*").eq("musician_id", userId);
      setMyMusicianBookings(myBookings ?? []);
      const { data: mine } = await supabase.from("availability_responses").select("lead_id,response").eq("dj_user_id", userId);
      setMyAvailability(Object.fromEntries((mine ?? []).map((r) => [r.lead_id, r.response])));
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

  const bookMusician = async (leadId: string, musicianId: string) => {
    const { error } = await supabase.from("lead_musicians").insert({ lead_id: leadId, musician_id: musicianId });
    if (error) { ping(friendlyError(error)); return; }
    ping("Musician booked on this lead");
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

  const updateMusicianBooking = async (id: string, patch: { services?: MusicianService[]; payout?: number | null }, msg?: string) => {
    const { error } = await supabase.from("lead_musicians").update(patch).eq("id", id);
    if (error) { ping(friendlyError(error)); return; }
    if (msg) ping(msg);
    loadData();
  };

  const setAvail = async (leadId: string, answer: "available" | "pass") => {
    setMyAvailability((prev) => ({ ...prev, [leadId]: answer }));
    setBusyLeadId(leadId);
    const { error } = await supabase
      .from("availability_responses")
      .upsert({ lead_id: leadId, dj_user_id: userId, response: answer }, { onConflict: "lead_id,dj_user_id" });
    setBusyLeadId(null);
    if (error) { ping(friendlyError(error)); return; }
    ping(answer === "available" ? "Marked available — Austin's been signaled" : "Passed on this date");
    loadData();
    if (answer === "available") {
      fetch("/api/notify/availability", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leadId }),
      }).catch(() => {});
    }
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

  const filteredMotion = motionDjFilter === "all" ? inMotion : inMotion.filter((l) => l.assigned_dj_id === motionDjFilter);

  // No dj_tier on the lead means no tier restriction applies. But an empty
  // myTiers means the owner hasn't qualified this DJ for any tier yet — that
  // no longer means "show everything" (a preference default), it means
  // "not qualified for anything yet" (an eligibility default).
  const tierVisible = (l: LeadRow) => !l.dj_tier || myTiers.includes(l.dj_tier);
  const myChecks = checking.filter(tierVisible);
  // Once I've responded, the lead moves out of Date Checks — "available"
  // goes to Pending, "pass" goes to Archive — leaving only the ones I
  // haven't answered yet.
  const needsMe = myChecks.filter((l) => !myAvailability[l.id]);
  // Once Austin assigns me to a meeting, it stays in Pending too — as
  // "MEETING BOOKED" — until he marks it Booked, which is what moves it
  // into Upcoming.
  const myPending = [
    ...myChecks.filter((l) => myAvailability[l.id] === "available"),
    ...active.filter((l) => l.assigned_dj_id === userId && leadStatus(l) === "meeting"),
  ];
  // A pass is reversible — the card in Archive still shows the
  // available/pass buttons, so flipping back to available moves it
  // straight into Pending.
  const myArchive = myChecks.filter((l) => myAvailability[l.id] === "pass");
  const myGigs = leads.filter((l) => l.assigned_dj_id === userId && ["booked", "played"].includes(leadStatus(l)));
  const myUpcoming = myGigs.filter((l) => !isPastEvent(l));
  const myCompleted = myGigs.filter((l) => isPastEvent(l));
  const rankedLeaderboard = [...leaderboard].sort((a, b) => b.booking_total - a.booking_total);
  const nextDjEvent = [...myUpcoming].sort(byDate)[0];
  // Same "all bookings ever, any status" total the Leaderboard already
  // shows for every DJ — reusing it here keeps the two numbers from ever
  // disagreeing with each other.
  const myMoneyMade = rankedLeaderboard.find((r) => r.dj_id === userId)?.booking_total ?? 0;

  const myMusicianLeadIds = new Set(myMusicianBookings.map((b) => b.lead_id));
  const myMusicianLeads = leads.filter((l) => myMusicianLeadIds.has(l.id));
  const myMusicianUpcoming = myMusicianLeads.filter((l) => !isPastEvent(l));
  const myMusicianCompleted = myMusicianLeads.filter((l) => isPastEvent(l));
  const nextMusicianEvent = [...myMusicianUpcoming].sort(byDate)[0];
  const nextMusicianBooking = nextMusicianEvent ? myMusicianBookings.find((b) => b.lead_id === nextMusicianEvent.id) : undefined;
  const myMusicianMoneyMade = myMusicianBookings.reduce((sum, b) => sum + (b.payout ?? 0), 0);

  // A musician's "date check" pool mirrors a DJ's, just filtered by
  // instrument keyword in the upgrades text instead of tier — there's no
  // per-musician visibility list to configure, so no instrument means no
  // matches rather than "show everything."
  const instrumentKeyword = myInstrument ? INSTRUMENT_KEYWORD[myInstrument] : null;
  const instrumentVisible = (l: LeadRow) => !!instrumentKeyword && (l.upgrades || "").toLowerCase().includes(instrumentKeyword);
  // Austin can book a musician directly at any pipeline stage, independent
  // of the DJ-side status — so a lead can already be an Upcoming booking
  // while still sitting at "checking" overall. Once booked, it belongs
  // only in Upcoming/Completed, not back in the date-check pool.
  const myMusicianChecks = checking.filter(instrumentVisible).filter((l) => !myMusicianLeadIds.has(l.id));
  const needsMeMusician = myMusicianChecks.filter((l) => !myAvailability[l.id]);
  const myMusicianPending = myMusicianChecks.filter((l) => myAvailability[l.id] === "available");
  const myMusicianArchive = myMusicianChecks.filter((l) => myAvailability[l.id] === "pass");

  const ownerTabs = [
    { id: "pipeline", label: "PIPELINE", count: checking.length },
    { id: "motion", label: "MEETINGS & BOOKED", count: inMotion.length },
    { id: "archive", label: "ARCHIVE", count: archived.length },
    { id: "roster", label: "ROSTER", count: roster.length },
    { id: "settings", label: "SETTINGS", count: 0 },
  ];
  const djTabs = [
    { id: "home", label: "HOME", count: 0 },
    { id: "checks", label: "DATE CHECKS", count: needsMe.length },
    { id: "pending", label: "PENDING", count: myPending.length },
    { id: "archive", label: "ARCHIVE", count: myArchive.length },
    { id: "upcoming", label: "UPCOMING", count: myUpcoming.filter((l) => leadStatus(l) === "booked").length },
    { id: "completed", label: "COMPLETED", count: 0 },
    { id: "leaderboard", label: "LEADERBOARD", count: 0 },
  ];
  const musicianTabs = [
    { id: "musician-home", label: "HOME", count: 0 },
    { id: "musician-checks", label: "DATE CHECKS", count: needsMeMusician.length },
    { id: "musician-pending", label: "PENDING", count: myMusicianPending.length },
    { id: "musician-archive", label: "ARCHIVE", count: myMusicianArchive.length },
    { id: "musician-upcoming", label: "UPCOMING", count: myMusicianUpcoming.length },
    { id: "musician-completed", label: "COMPLETED", count: 0 },
  ];
  const tabs = role === "owner" ? ownerTabs : role === "dj" ? djTabs : musicianTabs;
  const activeTab = tabs.some((t) => t.id === tab) ? tab : tabs[0].id;

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

          <nav style={{ display: "flex", gap: 4, marginTop: 14, overflowX: "auto" }}>
            {tabs.map((t) => {
              const isActive = t.id === activeTab;
              return (
                <button key={t.id} onClick={() => setTab(t.id)} style={{
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
            {checking.length > 0 && <SortToggle sortBy={sortBy} sortDir={sortDir} onChange={handleSortChange} />}
            {checking.length === 0 && !showAdd && (
              <Empty text="No leads in date check. Import a HoneyBook inquiry and your roster gets pinged for availability." />
            )}
            {checking.filter((l) => leadStatus(l) === "ready").length > 0 && (
              <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.16em", color: T.green }}>DJ AVAILABLE — CONTACT THESE LEADS</div>
            )}
            {sortLeads(checking.filter((l) => leadStatus(l) === "ready")).map((l) => (
              <LeadCard key={l.id} lead={l} roster={roster} availability={availability} highlighted={l.id === highlightLeadId} busy={busyLeadId === l.id} userId={userId} onFetchHistory={fetchLeadHistory} musicianRoster={musicianRoster} rosterProfiles={rosterProfiles} leadMusicians={leadMusicians} onBookMusician={bookMusician} onUnbookMusician={unbookMusician} onUpdateMusicianBooking={updateMusicianBooking} onSetAvail={setAvail} onUpdateLead={updateLead} onDeleteLead={deleteLead} onSaveNotes={saveNotes} />
            ))}
            {checking.filter((l) => leadStatus(l) === "checking").length > 0 && (
              <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.16em", color: T.accent, marginTop: 4 }}>WAITING ON DATE CHECKS</div>
            )}
            {sortLeads(checking.filter((l) => leadStatus(l) === "checking")).map((l) => (
              <LeadCard key={l.id} lead={l} roster={roster} availability={availability} highlighted={l.id === highlightLeadId} busy={busyLeadId === l.id} userId={userId} onFetchHistory={fetchLeadHistory} musicianRoster={musicianRoster} rosterProfiles={rosterProfiles} leadMusicians={leadMusicians} onBookMusician={bookMusician} onUnbookMusician={unbookMusician} onUpdateMusicianBooking={updateMusicianBooking} onSetAvail={setAvail} onUpdateLead={updateLead} onDeleteLead={deleteLead} onSaveNotes={saveNotes} />
            ))}
          </>
        )}

        {role === "owner" && activeTab === "motion" && (
          <>
            {roster.length > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {[{ id: "all", label: "ALL" }, ...roster.map((d) => ({ id: d.id, label: d.display_name || d.email }))].map((opt) => {
                  const isActive = motionDjFilter === opt.id;
                  return (
                    <button
                      key={opt.id}
                      onClick={() => setMotionDjFilter(opt.id)}
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
            )}

            {filteredMotion.length > 0 && <SortToggle sortBy={sortBy} sortDir={sortDir} onChange={handleSortChange} />}
            {filteredMotion.length === 0 && (
              <Empty text={motionDjFilter === "all" ? "Nothing in motion. When a date check comes back green, book the meeting and it moves here." : "No meetings or bookings for this DJ yet."} />
            )}
            {sortLeads(filteredMotion).map((l) => (
              <LeadCard key={l.id} lead={l} roster={roster} availability={availability} highlighted={l.id === highlightLeadId} busy={busyLeadId === l.id} userId={userId} onFetchHistory={fetchLeadHistory} musicianRoster={musicianRoster} rosterProfiles={rosterProfiles} leadMusicians={leadMusicians} onBookMusician={bookMusician} onUnbookMusician={unbookMusician} onUpdateMusicianBooking={updateMusicianBooking} onSetAvail={setAvail} onUpdateLead={updateLead} onDeleteLead={deleteLead} onSaveNotes={saveNotes} />
            ))}
          </>
        )}

        {role === "owner" && activeTab === "archive" && (
          <>
            {archived.length === 0 && <Empty text="Completed and lost leads end up here." />}
            {archived.map((l) => (
              <LeadCard key={l.id} lead={l} roster={roster} availability={availability} highlighted={l.id === highlightLeadId} busy={busyLeadId === l.id} userId={userId} onFetchHistory={fetchLeadHistory} musicianRoster={musicianRoster} rosterProfiles={rosterProfiles} leadMusicians={leadMusicians} onBookMusician={bookMusician} onUnbookMusician={unbookMusician} onUpdateMusicianBooking={updateMusicianBooking} onSetAvail={setAvail} onUpdateLead={updateLead} onDeleteLead={deleteLead} onSaveNotes={saveNotes} />
            ))}
          </>
        )}

        {role === "owner" && activeTab === "roster" && (
          <Roster roster={roster} musicianRoster={musicianRoster} rosterProfiles={rosterProfiles} leads={leads} leadMusicians={leadMusicians} onChanged={loadData} onSetTiers={saveDjTiers} onSetNotify={saveDjNotify} ping={ping} confirm={confirmAction} />
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
            </div>
            <NextEventCard
              lead={nextDjEvent}
              subtitle={nextDjEvent ? tierStr(nextDjEvent) : ""}
              emptyText="No upcoming events booked yet."
              onView={() => setTab("upcoming")}
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
            {myChecks.length > 0 && needsMe.length === 0 && (
              <Empty text="You've responded to everything here — check Pending or Archive." />
            )}
            {needsMe.length > 0 && <SortToggle sortBy={sortBy} sortDir={sortDir} onChange={handleSortChange} />}
            {sortLeads(needsMe).map((l) => (
              <LeadCard key={l.id} lead={l} djView roster={roster} availability={availability} myAnswer={myAvailability[l.id]} highlighted={l.id === highlightLeadId} busy={busyLeadId === l.id} userId={userId} onFetchHistory={fetchLeadHistory} musicianRoster={musicianRoster} rosterProfiles={rosterProfiles} leadMusicians={leadMusicians} onBookMusician={bookMusician} onUnbookMusician={unbookMusician} onUpdateMusicianBooking={updateMusicianBooking} onSetAvail={setAvail} onUpdateLead={updateLead} onDeleteLead={deleteLead} onSaveNotes={saveNotes} />
            ))}
          </>
        )}

        {role === "dj" && activeTab === "pending" && (
          <>
            {myPending.length === 0 && (
              <Empty text="Leads you're available for, or that Austin has assigned you to, land here until he marks it booked." />
            )}
            {myPending.length > 0 && <SortToggle sortBy={sortBy} sortDir={sortDir} onChange={handleSortChange} />}
            {sortLeads(myPending).map((l) => (
              <LeadCard key={l.id} lead={l} djView roster={roster} availability={availability} myAnswer={myAvailability[l.id]} highlighted={l.id === highlightLeadId} busy={busyLeadId === l.id} userId={userId} onFetchHistory={fetchLeadHistory} musicianRoster={musicianRoster} rosterProfiles={rosterProfiles} leadMusicians={leadMusicians} onBookMusician={bookMusician} onUnbookMusician={unbookMusician} onUpdateMusicianBooking={updateMusicianBooking} onSetAvail={setAvail} onUpdateLead={updateLead} onDeleteLead={deleteLead} onSaveNotes={saveNotes} />
            ))}
          </>
        )}

        {role === "dj" && activeTab === "archive" && (
          <>
            {myArchive.length === 0 && (
              <Empty text="Leads you've passed on land here. Your availability's still visible on each one if that changes." />
            )}
            {myArchive.length > 0 && <SortToggle sortBy={sortBy} sortDir={sortDir} onChange={handleSortChange} />}
            {sortLeads(myArchive).map((l) => (
              <LeadCard key={l.id} lead={l} djView roster={roster} availability={availability} myAnswer={myAvailability[l.id]} highlighted={l.id === highlightLeadId} busy={busyLeadId === l.id} userId={userId} onFetchHistory={fetchLeadHistory} musicianRoster={musicianRoster} rosterProfiles={rosterProfiles} leadMusicians={leadMusicians} onBookMusician={bookMusician} onUnbookMusician={unbookMusician} onUpdateMusicianBooking={updateMusicianBooking} onSetAvail={setAvail} onUpdateLead={updateLead} onDeleteLead={deleteLead} onSaveNotes={saveNotes} />
            ))}
          </>
        )}

        {role === "dj" && activeTab === "upcoming" && (
          <>
            {myUpcoming.length === 0 && <Empty text="No booked gigs yet — answer date checks and Austin books from there." />}
            {myUpcoming.sort(byDate).map((l) => (
              <LeadCard key={l.id} lead={l} djView roster={roster} availability={availability} myAnswer={myAvailability[l.id]} highlighted={l.id === highlightLeadId} busy={busyLeadId === l.id} userId={userId} onFetchHistory={fetchLeadHistory} musicianRoster={musicianRoster} rosterProfiles={rosterProfiles} leadMusicians={leadMusicians} onBookMusician={bookMusician} onUnbookMusician={unbookMusician} onUpdateMusicianBooking={updateMusicianBooking} onSetAvail={setAvail} onUpdateLead={updateLead} onDeleteLead={deleteLead} onSaveNotes={saveNotes} />
            ))}
          </>
        )}

        {role === "dj" && activeTab === "completed" && (
          <>
            {myCompleted.length === 0 && <Empty text="Completed gigs show up here once the event has passed and you've been paid in full." />}
            {myCompleted.sort((a, b) => byDate(b, a)).map((l) => (
              <LeadCard key={l.id} lead={l} djView roster={roster} availability={availability} myAnswer={myAvailability[l.id]} highlighted={l.id === highlightLeadId} busy={busyLeadId === l.id} userId={userId} onFetchHistory={fetchLeadHistory} musicianRoster={musicianRoster} rosterProfiles={rosterProfiles} leadMusicians={leadMusicians} onBookMusician={bookMusician} onUnbookMusician={unbookMusician} onUpdateMusicianBooking={updateMusicianBooking} onSetAvail={setAvail} onUpdateLead={updateLead} onDeleteLead={deleteLead} onSaveNotes={saveNotes} />
            ))}
          </>
        )}

        {role === "dj" && activeTab === "leaderboard" && (
          <>
            {rankedLeaderboard.length === 0 && <Empty text="Once DJs start booking gigs, standings show up here." />}
            {rankedLeaderboard.map((row, i) => {
              const isMe = row.dj_id === userId;
              return (
                <div
                  key={row.dj_id}
                  style={{
                    background: T.surface, border: `1px solid ${isMe ? T.accent : T.line}`, borderRadius: 8,
                    padding: "10px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
                    <div style={{ fontFamily: "var(--font-heading), serif", fontSize: 16, fontWeight: 900, color: T.dim, width: 24, flexShrink: 0 }}>{i + 1}</div>
                    <div style={{ fontWeight: 700 }}>{row.display_name || row.email}{isMe && <span style={{ color: T.dim, fontWeight: 400 }}> (you)</span>}</div>
                  </div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: T.text, textAlign: "right", whiteSpace: "nowrap" }}>
                    {row.booking_count} gig{row.booking_count !== 1 ? "s" : ""}{row.booking_total ? ` · $${row.booking_total}` : ""}
                  </div>
                </div>
              );
            })}
          </>
        )}

        {role === "musician" && activeTab === "musician-home" && (
          <>
            <StatusBanner allCaughtUp={needsMeMusician.length === 0} />
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <StatCard value={needsMeMusician.length} label="DATE CHECKS" urgent={needsMeMusician.length > 0} onClick={() => setTab("musician-checks")} />
              <StatCard value={myMusicianUpcoming.length} label="EVENTS BOOKED" onClick={() => setTab("musician-upcoming")} />
              <StatCard value={myMusicianCompleted.length} label="EVENTS COMPLETED" onClick={() => setTab("musician-completed")} />
              <StatCard value={`$${myMusicianMoneyMade}`} label="EARNED FROM BOOKINGS" />
            </div>
            <NextEventCard
              lead={nextMusicianEvent}
              subtitle={nextMusicianBooking?.services?.join(", ") || ""}
              emptyText="No upcoming events booked yet."
              onView={() => setTab("musician-upcoming")}
            />
          </>
        )}

        {role === "musician" && activeTab === "musician-checks" && (
          <>
            {!myInstrument && <Empty text="No instrument on file yet — ask Austin to set it in Roster." />}
            {myInstrument && checking.length === 0 && <Empty text="No open date checks. New ones show up here when a lead mentions your instrument." />}
            {myInstrument && checking.length > 0 && myMusicianChecks.length === 0 && (
              <Empty text="No open leads mention your instrument right now." />
            )}
            {myMusicianChecks.length > 0 && needsMeMusician.length === 0 && (
              <Empty text="You've responded to everything here — check Pending or Archive." />
            )}
            {needsMeMusician.length > 0 && <SortToggle sortBy={sortBy} sortDir={sortDir} onChange={handleSortChange} />}
            {sortLeads(needsMeMusician).map((l) => (
              <MusicianLeadCard key={l.id} lead={l} myAnswer={myAvailability[l.id]} onSetAvail={setAvail} busy={busyLeadId === l.id} highlighted={l.id === highlightLeadId} />
            ))}
          </>
        )}

        {role === "musician" && activeTab === "musician-pending" && (
          <>
            {myMusicianPending.length === 0 && (
              <Empty text="Leads you're available for land here until Austin books you." />
            )}
            {myMusicianPending.length > 0 && <SortToggle sortBy={sortBy} sortDir={sortDir} onChange={handleSortChange} />}
            {sortLeads(myMusicianPending).map((l) => (
              <MusicianLeadCard key={l.id} lead={l} myAnswer={myAvailability[l.id]} onSetAvail={setAvail} busy={busyLeadId === l.id} highlighted={l.id === highlightLeadId} />
            ))}
          </>
        )}

        {role === "musician" && activeTab === "musician-archive" && (
          <>
            {myMusicianArchive.length === 0 && (
              <Empty text="Leads you've passed on land here. Your availability's still visible on each one if that changes." />
            )}
            {myMusicianArchive.length > 0 && <SortToggle sortBy={sortBy} sortDir={sortDir} onChange={handleSortChange} />}
            {sortLeads(myMusicianArchive).map((l) => (
              <MusicianLeadCard key={l.id} lead={l} myAnswer={myAvailability[l.id]} onSetAvail={setAvail} busy={busyLeadId === l.id} highlighted={l.id === highlightLeadId} />
            ))}
          </>
        )}

        {role === "musician" && activeTab === "musician-upcoming" && (
          <>
            {myMusicianUpcoming.length === 0 && <Empty text="No gigs booked yet — Austin will add you to a lead once a client books live music." />}
            {myMusicianUpcoming.sort(byDate).map((l) => {
              const booking = myMusicianBookings.find((b) => b.lead_id === l.id);
              return booking ? <MusicianLeadCard key={l.id} lead={l} booking={booking} highlighted={l.id === highlightLeadId} /> : null;
            })}
          </>
        )}

        {role === "musician" && activeTab === "musician-completed" && (
          <>
            {myMusicianCompleted.length === 0 && <Empty text="Completed gigs show up here once the event has passed." />}
            {myMusicianCompleted.sort((a, b) => byDate(b, a)).map((l) => {
              const booking = myMusicianBookings.find((b) => b.lead_id === l.id);
              return booking ? <MusicianLeadCard key={l.id} lead={l} booking={booking} highlighted={l.id === highlightLeadId} /> : null;
            })}
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
