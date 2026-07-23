"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { Database, DjTier, ProdTier, TravelZone } from "@/lib/supabase/types";
import { tierRate, travelRate, guessTravelZone } from "@/lib/rates";
import {
  T, DJ_TIERS, TRAVEL_ZONES, LEAD_STATUS, fmtDate,
  Lamp, Tag, Btn, Field, Input, Select, TextArea, Empty, TierPicker,
} from "./ui";

type LeadRow = Database["public"]["Views"]["leads_feed"]["Row"];
type LeadInsert = Database["public"]["Tables"]["leads"]["Insert"];
type LeadUpdate = Database["public"]["Tables"]["leads"]["Update"];
type CompanySettings = Database["public"]["Tables"]["company_settings"]["Row"];
type RosterUser = { id: string; email: string; display_name: string | null };
type AvailabilityRow = { lead_id: string; dj_user_id: string; response: "available" | "pass" };

const tierStr = (l: LeadRow) => [l.dj_tier, l.prod_tier].filter(Boolean).join(" + ");
const byDate = (a: LeadRow, b: LeadRow) => ((a.event_date || "9999") > (b.event_date || "9999") ? 1 : -1);
const bySubmitted = (a: LeadRow, b: LeadRow) => (new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

function SortToggle({ sortBy, onChange }: { sortBy: "event" | "submitted"; onChange: (v: "event" | "submitted") => void }) {
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
      <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.14em", color: T.dim }}>SORT</span>
      {(["event", "submitted"] as const).map((v) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          style={{
            fontFamily: "inherit", fontSize: 12, fontWeight: 700, letterSpacing: "0.04em",
            padding: "5px 12px", borderRadius: 20, cursor: "pointer",
            background: sortBy === v ? T.amber : "transparent",
            color: sortBy === v ? "#1A1502" : T.text,
            border: `1px solid ${sortBy === v ? T.amber : T.line}`,
          }}
        >
          {v === "event" ? "EVENT DATE" : "SUBMITTED"}
        </button>
      ))}
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

function TravelEditor({
  lead, companySettings, onSave,
}: {
  lead: LeadRow;
  companySettings: CompanySettings | null;
  onSave: (id: string, patch: { travel_zone: TravelZone | null; travel_rate: number | null }) => void;
}) {
  const [zone, setZone] = useState(lead.travel_zone || "");
  const [rate, setRate] = useState(lead.travel_rate != null ? String(lead.travel_rate) : "");
  const [dirty, setDirty] = useState(false);

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.14em", color: T.dim }}>TRAVEL</span>
      <Select
        value={zone}
        onChange={(e) => {
          const z = e.target.value;
          setZone(z);
          setDirty(true);
          if (!rate && z) setRate(String(travelRate(companySettings, z)));
        }}
        style={{ width: "auto", fontSize: 12, padding: "6px 8px" }}
      >
        <option value="">Pick zone…</option>
        {TRAVEL_ZONES.map((z) => <option key={z} value={z}>{z}</option>)}
      </Select>
      <Input
        type="number"
        value={rate}
        onChange={(e) => { setRate(e.target.value); setDirty(true); }}
        style={{ width: 90 }}
      />
      {dirty && (
        <Btn small kind="primary" onClick={() => {
          onSave(lead.id, { travel_zone: (zone || null) as TravelZone | null, travel_rate: rate ? Number(rate) : null });
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

function LeadCard({
  lead, djView, roster, availability, myAnswer, highlighted, companySettings,
  onSetAvail, onUpdateLead, onDeleteLead, onSaveNotes,
}: {
  lead: LeadRow;
  djView?: boolean;
  roster: RosterUser[];
  availability: AvailabilityRow[];
  myAnswer?: "available" | "pass";
  highlighted?: boolean;
  companySettings: CompanySettings | null;
  onSetAvail: (leadId: string, answer: "available" | "pass") => void;
  onUpdateLead: (id: string, patch: LeadUpdate, msg?: string) => void;
  onDeleteLead: (id: string) => void;
  onSaveNotes: (id: string, notes: string) => void;
}) {
  const st = leadStatus(lead);
  const s = LEAD_STATUS[st];
  const d = fmtDate(lead.event_date);
  const availDjIds = availability.filter((r) => r.lead_id === lead.id && r.response === "available").map((r) => r.dj_user_id);
  const tier = tierStr(lead);

  return (
    <div
      id={`lead-${lead.id}`}
      style={{
        display: "flex", background: T.surface,
        border: `1px solid ${highlighted ? T.amber : st === "ready" && !djView ? T.green + "66" : T.line}`,
        boxShadow: highlighted ? `0 0 0 3px ${T.amber}33` : "none",
        borderRadius: 10, overflow: "hidden",
      }}
    >
      <div style={{ width: 74, background: T.raised, borderRight: `1px solid ${T.line}`, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2, padding: "14px 8px", flexShrink: 0 }}>
        <Lamp color={s.color} pulse={st === "checking" || (st === "ready" && !djView)} />
        {d.dow && <div style={{ fontSize: 18, fontWeight: 900, letterSpacing: "0.06em", lineHeight: 1.2, marginTop: 4 }}>{d.dow.toUpperCase()}</div>}
        <div style={{ fontSize: 14, fontWeight: 800, letterSpacing: "0.12em", lineHeight: 1.3 }}>{d.mon}</div>
        <div style={{ fontSize: 28, fontWeight: 900, lineHeight: 1, fontFamily: "'Archivo', system-ui, sans-serif" }}>{d.day}</div>
        {d.year && <div style={{ fontSize: 10, color: T.dim, marginTop: 4 }}>{"'" + String(d.year).slice(2)}</div>}
      </div>

      <div style={{ flex: 1, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: 15 }}>
              {djView ? (tier || "Gig") : (lead.client_name || "Unnamed lead")}
            </div>
            <div style={{ fontSize: 12.5, color: T.dim, marginTop: 2 }}>
              {djView
                ? [lead.location, totalPayout(lead) ? `$${totalPayout(lead)} payout` : null].filter(Boolean).join(" · ") || "details TBD"
                : [tier, lead.location].filter(Boolean).join(" · ") || "tier TBD"}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
            {!djView && lead.needs_review && <Tag color={T.violet}>NEEDS REVIEW</Tag>}
            <Tag color={s.color}>{s.label}</Tag>
          </div>
        </div>

        {!djView && (
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 12.5, color: T.dim, alignItems: "center" }}>
            {lead.contact && <span>{lead.contact}</span>}
            {lead.source && <span>via {lead.source}</span>}
            {lead.assigned_dj_id && (
              <span>DJ: <span style={{ color: T.text, fontWeight: 700 }}>
                {roster.find((d) => d.id === lead.assigned_dj_id)?.display_name || "assigned"}
              </span></span>
            )}
            <PayoutEditor lead={lead} onSave={(id, payout) => onUpdateLead(id, { payout }, "Payout updated")} />
          </div>
        )}

        {!djView && (
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 12.5, color: T.dim, alignItems: "center" }}>
            <TravelEditor
              lead={lead}
              companySettings={companySettings}
              onSave={(id, patch) => onUpdateLead(id, patch, "Travel updated")}
            />
            {totalPayout(lead) > 0 && (
              <span>Total: <strong style={{ color: T.text }}>${totalPayout(lead)}</strong></span>
            )}
          </div>
        )}

        {lead.upgrades && (
          <div style={{ fontSize: 12.5, color: T.amber }}>
            <span style={{ color: T.dim, fontWeight: 700, letterSpacing: "0.1em", fontSize: 10.5 }}>UPGRADES </span>
            {lead.upgrades}
          </div>
        )}
        {lead.client_vision && (
          <div style={{ fontSize: 12.5, color: T.dim, whiteSpace: "pre-wrap", borderLeft: `2px solid ${T.line}`, paddingLeft: 8 }}>
            {lead.client_vision}
          </div>
        )}
        {djView && lead.dj_notes && <div style={{ fontSize: 12.5, color: T.dim, whiteSpace: "pre-wrap" }}>{lead.dj_notes}</div>}
        {!djView && lead.owner_notes && <div style={{ fontSize: 12.5, color: T.dim, whiteSpace: "pre-wrap" }}>{lead.owner_notes}</div>}

        {!djView && ["checking", "ready", "meeting"].includes(st) && <AvailChips lead={lead} roster={roster} availability={availability} />}

        {["meeting", "booked", "played"].includes(st) && <MeetingNotesEditor lead={lead} onSave={onSaveNotes} />}

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 2, alignItems: "center" }}>
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
            <Select
              value=""
              onChange={(e) => {
                const id = e.target.value;
                if (!id) return;
                const name = roster.find((d) => d.id === id)?.display_name || "DJ";
                onUpdateLead(lead.id, { status: "booked", assigned_dj_id: id }, `Booked — ${name} is on it`);
              }}
              style={{ width: "auto", fontSize: 12, padding: "6px 8px" }}
            >
              <option value="">Book it — assign DJ…</option>
              {(availDjIds.length ? roster.filter((d) => availDjIds.includes(d.id)) : roster).map((d) => (
                <option key={d.id} value={d.id}>{d.display_name || d.email}{availDjIds.includes(d.id) ? " (available)" : ""}</option>
              ))}
            </Select>
          )}
          {!djView && st === "meeting" && (
            <Btn kind="ghost" small onClick={() => onUpdateLead(lead.id, { status: "checking" }, "Back to pipeline")}>
              ← BACK TO PIPELINE
            </Btn>
          )}
          {!djView && st === "booked" && (
            <Btn kind="ghost" small onClick={() => onUpdateLead(lead.id, { status: "played" }, "Marked as played")}>
              MARK PLAYED
            </Btn>
          )}
          {!djView && !["lost", "played"].includes(st) && (
            <Btn kind="ghost" small style={{ color: T.red, borderColor: T.red + "44" }} onClick={() => onUpdateLead(lead.id, { status: "lost" }, "Marked lost")}>
              LOST
            </Btn>
          )}
          {!djView && (
            <Btn kind="ghost" small style={{ color: T.red, borderColor: T.red + "44" }} onClick={() => onDeleteLead(lead.id)}>✕</Btn>
          )}
        </div>
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
    name: string; contact: string; date: string; location: string;
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
      client_name: parsed.name, contact: parsed.contact, event_date: parsed.date || null,
      location: parsed.location, dj_tier: (parsed.djTier || null) as DjTier | null,
      prod_tier: (parsed.prodTier || null) as ProdTier | null, upgrades: parsed.upgrades,
      client_vision: parsed.vision, source: "honeybook", status: "checking",
      payout: parsed.payout ? Number(parsed.payout) : null,
      travel_zone: (parsed.travelZone || null) as TravelZone | null,
      travel_rate: parsed.travelRate ? Number(parsed.travelRate) : null,
    });
  };

  return (
    <div style={{ background: T.raised, border: `1px solid ${T.amber}55`, borderRadius: 10, padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontWeight: 800, letterSpacing: "0.1em", fontSize: 12, color: T.amber }}>IMPORT FROM HONEYBOOK</div>
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
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <Field label="CLIENT"><Input value={parsed.name} onChange={(e) => setParsed({ ...parsed, name: e.target.value })} /></Field>
            <Field label="EVENT DATE"><Input type="date" value={parsed.date} onChange={(e) => setParsed({ ...parsed, date: e.target.value })} /></Field>
          </div>
          <Field label="LOCATION"><Input value={parsed.location} onChange={(e) => setParsed({ ...parsed, location: e.target.value })} placeholder="The Colony House, Anaheim" /></Field>
          <TierPicker djTier={parsed.djTier} prodTier={parsed.prodTier} onChange={({ djTier, prodTier }) => {
            const next = { ...parsed, djTier, prodTier };
            if (!parsed.payout && djTier && prodTier) next.payout = String(tierRate(companySettings, djTier, prodTier));
            setParsed(next);
          }} />
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
          <Field label="TRAVEL ZONE / RATE ($)">
            <div style={{ display: "flex", gap: 6 }}>
              <Select
                value={parsed.travelZone}
                onChange={(e) => {
                  const z = e.target.value;
                  const next = { ...parsed, travelZone: z };
                  if (!parsed.travelRate && z) next.travelRate = String(travelRate(companySettings, z));
                  setParsed(next);
                }}
                style={{ width: "auto" }}
              >
                <option value="">Pick zone…</option>
                {TRAVEL_ZONES.map((z) => <option key={z} value={z}>{z}</option>)}
              </Select>
              <Input type="number" value={parsed.travelRate} onChange={(e) => setParsed({ ...parsed, travelRate: e.target.value })} style={{ flex: 1 }} />
              {parsed.travelZone && (
                <Btn small onClick={() => setParsed({ ...parsed, travelRate: String(travelRate(companySettings, parsed.travelZone)) })}>
                  USE ${travelRate(companySettings, parsed.travelZone)}
                </Btn>
              )}
            </div>
          </Field>
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
    name: "", contact: "", date: "", location: "", djTier: "", prodTier: "",
    upgrades: "", vision: "", source: "", notes: "", djNotes: "", payout: "",
    travelZone: "", travelRate: "",
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <div style={{ background: T.raised, border: `1px solid ${T.line}`, borderRadius: 10, padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontWeight: 800, letterSpacing: "0.1em", fontSize: 12, color: T.amber }}>ADD LEAD MANUALLY</div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Field label="CLIENT"><Input value={f.name} onChange={set("name")} placeholder="Jess & Marco" /></Field>
        <Field label="CONTACT"><Input value={f.contact} onChange={set("contact")} placeholder="email or phone" /></Field>
        <Field label="EVENT DATE"><Input type="date" value={f.date} onChange={set("date")} /></Field>
      </div>
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
        <Field label="TRAVEL ZONE / RATE ($)">
          <div style={{ display: "flex", gap: 6 }}>
            <Select
              value={f.travelZone}
              onChange={(e) => {
                const z = e.target.value;
                const next = { ...f, travelZone: z };
                if (!f.travelRate && z) next.travelRate = String(travelRate(companySettings, z));
                setF(next);
              }}
              style={{ width: "auto" }}
            >
              <option value="">Pick zone…</option>
              {TRAVEL_ZONES.map((z) => <option key={z} value={z}>{z}</option>)}
            </Select>
            <Input type="number" value={f.travelRate} onChange={set("travelRate")} style={{ flex: 1 }} />
            {f.travelZone && (
              <Btn small onClick={() => setF({ ...f, travelRate: String(travelRate(companySettings, f.travelZone)) })}>
                USE ${travelRate(companySettings, f.travelZone)}
              </Btn>
            )}
          </div>
        </Field>
      </div>
      <Field label="PRIVATE NOTES (OWNER ONLY)"><TextArea value={f.notes} onChange={set("notes")} /></Field>
      <Field label="NOTES FOR DJs (SHOWN ON DATE CHECK)"><TextArea value={f.djNotes} onChange={set("djNotes")} placeholder="Outdoor ceremony, load-in 3pm…" /></Field>
      <div style={{ display: "flex", gap: 8 }}>
        <Btn kind="primary" onClick={() => {
          if (!f.name.trim() && !f.date) { ping("Give it at least a name or a date"); return; }
          onSave({
            client_name: f.name, contact: f.contact, event_date: f.date || null, location: f.location,
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
  roster, rosterProfiles, onChanged, onSetTiers, ping,
}: {
  roster: RosterUser[];
  rosterProfiles: { user_id: string; dj_tier_visibility: DjTier[] }[];
  onChanged: () => void;
  onSetTiers: (djId: string, tiers: DjTier[]) => void;
  ping: (m: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ email: string; password: string; name: string } | null>(null);

  const create = async () => {
    if (!email.trim() || password.length < 8) return;
    setBusy(true);
    const res = await fetch("/api/roster", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim(), displayName: name.trim() || null, password }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) { ping(data.error || "Couldn't create that account"); return; }
    setCreated({ email: email.trim(), password, name: name.trim() });
    setEmail(""); setName(""); setPassword("");
    onChanged();
  };

  const remove = async (id: string, label: string) => {
    if (!window.confirm(`Remove ${label}?`)) return;
    const res = await fetch(`/api/roster/${id}`, { method: "DELETE" });
    if (!res.ok) { ping("Couldn't remove — check connection and retry"); return; }
    ping("Removed");
    onChanged();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="DJ name (e.g., DJ Marcus)" style={{ flex: 1, minWidth: 160 }} />
        <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email@example.com" type="email" style={{ flex: 1, minWidth: 200 }} />
        <Input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password (8+ chars)" style={{ flex: 1, minWidth: 160 }} />
        <Btn onClick={() => setPassword(generatePassword())}>GENERATE</Btn>
        <Btn kind="primary" onClick={create} disabled={busy}>{busy ? "ADDING…" : "ADD DJ"}</Btn>
      </div>
      {created && (
        <div style={{ background: T.raised, border: `1px solid ${T.green}66`, borderRadius: 8, padding: 14, fontSize: 13 }}>
          <div style={{ fontWeight: 800, color: T.green, marginBottom: 6 }}>ACCOUNT CREATED — TELL {(created.name || created.email).toUpperCase()}</div>
          <div>Email: <strong>{created.email}</strong></div>
          <div>Password: <strong>{created.password}</strong></div>
          <div style={{ color: T.dim, marginTop: 6, fontSize: 12 }}>Copy this down now — it won&apos;t be shown again here.</div>
          <Btn small style={{ marginTop: 8 }} onClick={() => setCreated(null)}>DISMISS</Btn>
        </div>
      )}
      {roster.length === 0 && <Empty text="No DJs yet. Add your Residents and Associates with an email + password, then tell them what it is." />}
      {roster.map((dj) => {
        const tiers = rosterProfiles.find((p) => p.user_id === dj.id)?.dj_tier_visibility ?? [];
        return (
          <div key={dj.id} style={{ background: T.surface, border: `1px solid ${T.line}`, borderRadius: 8, padding: "10px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontWeight: 700 }}>{dj.display_name || "(pending sign-in)"}</div>
                <div style={{ fontSize: 12, color: T.dim }}>{dj.email}</div>
              </div>
              <Btn kind="ghost" small style={{ color: T.red, borderColor: T.red + "44" }} onClick={() => remove(dj.id, dj.display_name || dj.email)}>✕</Btn>
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
                      background: active ? T.amber : "transparent",
                      color: active ? "#1A1502" : T.dim,
                      border: `1px solid ${active ? T.amber : T.line}`,
                    }}
                  >
                    {t}
                  </button>
                );
              })}
              {tiers.length === 0 && <span style={{ fontSize: 11, color: T.red }}>not qualified for any tier yet</span>}
            </div>
          </div>
        );
      })}
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
        <div style={{ fontWeight: 800, fontSize: 12, letterSpacing: "0.1em", color: T.amber, marginBottom: 8 }}>DJ TIER RATES</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Field label="HEADLINER ($)"><Input type="number" value={f.headliner_rate} onChange={set("headliner_rate")} /></Field>
          <Field label="RESIDENT ($)"><Input type="number" value={f.resident_rate} onChange={set("resident_rate")} /></Field>
          <Field label="ASSOCIATE ($)"><Input type="number" value={f.associate_rate} onChange={set("associate_rate")} /></Field>
        </div>
      </div>
      <div>
        <div style={{ fontWeight: 800, fontSize: 12, letterSpacing: "0.1em", color: T.amber, marginBottom: 8 }}>PRODUCTION TIER RATES</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Field label="MARQUEE ($)"><Input type="number" value={f.marquee_rate} onChange={set("marquee_rate")} /></Field>
          <Field label="MODERN ($)"><Input type="number" value={f.modern_rate} onChange={set("modern_rate")} /></Field>
          <Field label="ESSENTIAL ($)"><Input type="number" value={f.essential_rate} onChange={set("essential_rate")} /></Field>
        </div>
      </div>
      <div>
        <div style={{ fontWeight: 800, fontSize: 12, letterSpacing: "0.1em", color: T.amber, marginBottom: 8 }}>TRAVEL RATES</div>
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

export default function BoardApp({
  userId,
  displayName,
  role,
}: {
  userId: string;
  displayName: string;
  role: "owner" | "dj";
}) {
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();
  const searchParams = useSearchParams();
  const highlightLeadId = searchParams.get("lead");

  const [loading, setLoading] = useState(true);
  const [leads, setLeads] = useState<LeadRow[]>([]);
  const [roster, setRoster] = useState<RosterUser[]>([]);
  const [rosterProfiles, setRosterProfiles] = useState<{ user_id: string; dj_tier_visibility: DjTier[] }[]>([]);
  const [availability, setAvailability] = useState<AvailabilityRow[]>([]);
  const [myAvailability, setMyAvailability] = useState<Record<string, "available" | "pass">>({});
  const [myTiers, setMyTiers] = useState<string[]>([]);
  const [companySettings, setCompanySettings] = useState<CompanySettings | null>(null);
  const [tab, setTab] = useState("pipeline");
  const [toast, setToast] = useState("");
  const [showAdd, setShowAdd] = useState<"import" | "manual" | false>(false);
  const [sortBy, setSortBy] = useState<"event" | "submitted">("event");
  const [motionDjFilter, setMotionDjFilter] = useState<string>("all");

  const ping = useCallback((m: string) => { setToast(m); setTimeout(() => setToast(""), 5000); }, []);

  const loadData = useCallback(async () => {
    const { data: leadsData } = await supabase.from("leads_feed").select("*").order("created_at", { ascending: false });
    setLeads(leadsData ?? []);

    if (role === "owner") {
      const { data: rosterData } = await supabase.from("users").select("id,email,display_name").eq("role", "dj").order("display_name");
      setRoster(rosterData ?? []);
      const { data: profilesData } = await supabase
        .from("dj_profiles")
        .select("user_id, dj_tier_visibility")
        .in("user_id", (rosterData ?? []).map((d) => d.id).length ? (rosterData ?? []).map((d) => d.id) : ["00000000-0000-0000-0000-000000000000"]);
      setRosterProfiles(profilesData ?? []);
      const { data: availData } = await supabase.from("availability_responses").select("lead_id,dj_user_id,response");
      setAvailability(availData ?? []);
      const { data: settingsData } = await supabase.from("company_settings").select("*").eq("id", 1).single();
      setCompanySettings(settingsData ?? null);
    } else {
      const { data: mine } = await supabase.from("availability_responses").select("lead_id,response").eq("dj_user_id", userId);
      setMyAvailability(Object.fromEntries((mine ?? []).map((r) => [r.lead_id, r.response])));
      const { data: prof } = await supabase.from("dj_profiles").select("dj_tier_visibility").eq("user_id", userId).single();
      setMyTiers(prof?.dj_tier_visibility ?? []);
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

  const saveDjTiers = async (djId: string, tiers: DjTier[]) => {
    const { error } = await supabase.from("dj_profiles").update({ dj_tier_visibility: tiers }).eq("user_id", djId);
    if (error) { ping(`Couldn't save: ${error.message}`); return; }
    ping("Tiers updated");
    loadData();
  };

  const setAvail = async (leadId: string, answer: "available" | "pass") => {
    setMyAvailability((prev) => ({ ...prev, [leadId]: answer }));
    const { error } = await supabase
      .from("availability_responses")
      .upsert({ lead_id: leadId, dj_user_id: userId, response: answer }, { onConflict: "lead_id,dj_user_id" });
    if (error) { ping(`Couldn't save: ${error.message}`); return; }
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
    const { error } = await supabase.from("leads").update(patch).eq("id", id);
    if (error) { ping(`Couldn't save: ${error.message}`); return; }
    if (msg) ping(msg);
    loadData();
  };

  const deleteLead = async (id: string) => {
    if (!window.confirm("Delete this lead entirely?")) return;
    const { error } = await supabase.from("leads").delete().eq("id", id);
    if (error) { ping(`Couldn't delete: ${error.message}`); return; }
    ping("Lead deleted");
    loadData();
  };

  const saveNotes = async (id: string, notes: string) => {
    const res = await fetch(`/api/leads/${id}/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { ping(data.error || "Couldn't save notes"); return; }
    ping("Notes saved");
    loadData();
  };

  const saveSettings = async (patch: Database["public"]["Tables"]["company_settings"]["Update"]) => {
    const { error } = await supabase.from("company_settings").update(patch).eq("id", 1);
    if (error) { ping(`Couldn't save: ${error.message}`); return; }
    ping("Rates updated");
    loadData();
  };

  const addLead = async (fields: LeadInsert) => {
    const { data, error } = await supabase.from("leads").insert(fields).select("id").single();
    if (error) { ping(`Couldn't save: ${error.message}`); return; }
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
      <div style={{ background: T.bg, minHeight: "100vh", display: "grid", placeItems: "center", color: T.dim, fontFamily: "'Archivo', system-ui, sans-serif" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Lamp color={T.amber} pulse />
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
  const bookingStats = roster
    .map((dj) => {
      const djLeads = leads.filter((l) => l.assigned_dj_id === dj.id);
      return { dj, count: djLeads.length, total: djLeads.reduce((sum, l) => sum + totalPayout(l), 0) };
    })
    .filter((s) => s.count > 0)
    .sort((a, b) => b.count - a.count);

  // No dj_tier on the lead means no tier restriction applies. But an empty
  // myTiers means the owner hasn't qualified this DJ for any tier yet — that
  // no longer means "show everything" (a preference default), it means
  // "not qualified for anything yet" (an eligibility default).
  const tierVisible = (l: LeadRow) => !l.dj_tier || myTiers.includes(l.dj_tier);
  const myChecks = checking.filter(tierVisible);
  const needsMe = myChecks.filter((l) => !myAvailability[l.id]);
  const myGigs = leads.filter((l) => l.assigned_dj_id === userId && ["booked", "played"].includes(leadStatus(l)));

  const ownerTabs = [
    { id: "pipeline", label: "PIPELINE", count: checking.length },
    { id: "motion", label: "MEETINGS & BOOKED", count: inMotion.length },
    { id: "archive", label: "ARCHIVE", count: archived.length },
    { id: "roster", label: "ROSTER", count: roster.length },
    { id: "settings", label: "SETTINGS", count: 0 },
  ];
  const djTabs = [
    { id: "checks", label: "DATE CHECKS", count: needsMe.length },
    { id: "mine", label: "MY GIGS", count: myGigs.filter((l) => leadStatus(l) === "booked").length },
  ];
  const tabs = role === "owner" ? ownerTabs : djTabs;
  const activeTab = tabs.some((t) => t.id === tab) ? tab : tabs[0].id;

  return (
    <div style={{ background: T.bg, minHeight: "100vh", color: T.text, fontFamily: "'Archivo', system-ui, -apple-system, sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..900&display=swap');
        @keyframes lampPulse { 0%,100% { opacity: 1 } 50% { opacity: .35 } }
        .lamp-pulse { animation: lampPulse 1.8s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) { .lamp-pulse { animation: none; } }
        select option { background: ${T.surface}; color: ${T.text}; }
        input:focus, select:focus, textarea:focus { border-color: ${T.amber} !important; }
        button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid ${T.amber}; outline-offset: 2px; }
      `}</style>

      <header style={{ borderBottom: `1px solid ${T.line}`, padding: "16px 16px 0", position: "sticky", top: 0, background: T.bg, zIndex: 10 }}>
        <div style={{ maxWidth: 860, margin: "0 auto" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Lamp color={T.amber} pulse />
              <div>
                <div style={{ fontWeight: 900, fontSize: 18, letterSpacing: "0.14em", fontStretch: "125%" }}>AUSTO</div>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.34em", color: T.dim, marginTop: -2 }}>GIG BOARD</div>
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 12, color: T.dim }}>{displayName} · {role === "owner" ? "Owner" : "DJ"}</span>
              <Btn small onClick={() => { loadData(); ping("Board refreshed"); }}>↻</Btn>
              <Btn small onClick={logout}>LOG OUT</Btn>
            </div>
          </div>

          <nav style={{ display: "flex", gap: 4, marginTop: 14, overflowX: "auto" }}>
            {tabs.map((t) => {
              const isActive = t.id === activeTab;
              return (
                <button key={t.id} onClick={() => setTab(t.id)} style={{
                  fontFamily: "inherit", background: "none", border: "none",
                  borderBottom: `2px solid ${isActive ? T.amber : "transparent"}`,
                  color: isActive ? T.text : T.dim, fontWeight: 800, fontSize: 12,
                  letterSpacing: "0.12em", padding: "10px 12px", cursor: "pointer", whiteSpace: "nowrap",
                }}>
                  {t.label}
                  {t.count > 0 && <span style={{ marginLeft: 6, color: isActive ? T.amber : T.dim, fontSize: 11 }}>{t.count}</span>}
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
            {checking.length > 0 && <SortToggle sortBy={sortBy} onChange={setSortBy} />}
            {checking.length === 0 && !showAdd && (
              <Empty text="No leads in date check. Import a HoneyBook inquiry and your roster gets pinged for availability." />
            )}
            {checking.filter((l) => leadStatus(l) === "ready").length > 0 && (
              <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.16em", color: T.green }}>DJ AVAILABLE — CONTACT THESE LEADS</div>
            )}
            {checking.filter((l) => leadStatus(l) === "ready").sort(sortBy === "event" ? byDate : bySubmitted).map((l) => (
              <LeadCard key={l.id} lead={l} roster={roster} availability={availability} highlighted={l.id === highlightLeadId} companySettings={companySettings} onSetAvail={setAvail} onUpdateLead={updateLead} onDeleteLead={deleteLead} onSaveNotes={saveNotes} />
            ))}
            {checking.filter((l) => leadStatus(l) === "checking").length > 0 && (
              <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.16em", color: T.amber, marginTop: 4 }}>WAITING ON DATE CHECKS</div>
            )}
            {checking.filter((l) => leadStatus(l) === "checking").sort(sortBy === "event" ? byDate : bySubmitted).map((l) => (
              <LeadCard key={l.id} lead={l} roster={roster} availability={availability} highlighted={l.id === highlightLeadId} companySettings={companySettings} onSetAvail={setAvail} onUpdateLead={updateLead} onDeleteLead={deleteLead} onSaveNotes={saveNotes} />
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
                        background: isActive ? T.amber : "transparent",
                        color: isActive ? "#1A1502" : T.text,
                        border: `1px solid ${isActive ? T.amber : T.line}`,
                      }}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            )}

            {motionDjFilter === "all" && bookingStats.length > 0 && (
              <div style={{ background: T.raised, border: `1px solid ${T.line}`, borderRadius: 8, padding: 14 }}>
                <div style={{ fontWeight: 800, fontSize: 12, letterSpacing: "0.1em", color: T.amber, marginBottom: 8 }}>BOOKINGS BY DJ</div>
                {bookingStats.map(({ dj, count, total }) => (
                  <div key={dj.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "4px 0" }}>
                    <span>{dj.display_name || dj.email}</span>
                    <span style={{ color: T.dim }}>{count} gig{count !== 1 ? "s" : ""}{total ? ` · $${total}` : ""}</span>
                  </div>
                ))}
              </div>
            )}

            {filteredMotion.length > 0 && <SortToggle sortBy={sortBy} onChange={setSortBy} />}
            {filteredMotion.length === 0 && (
              <Empty text={motionDjFilter === "all" ? "Nothing in motion. When a date check comes back green, book the meeting and it moves here." : "No meetings or bookings for this DJ yet."} />
            )}
            {filteredMotion.sort(sortBy === "event" ? byDate : bySubmitted).map((l) => (
              <LeadCard key={l.id} lead={l} roster={roster} availability={availability} highlighted={l.id === highlightLeadId} companySettings={companySettings} onSetAvail={setAvail} onUpdateLead={updateLead} onDeleteLead={deleteLead} onSaveNotes={saveNotes} />
            ))}
          </>
        )}

        {role === "owner" && activeTab === "archive" && (
          <>
            {archived.length === 0 && <Empty text="Played and lost leads end up here." />}
            {archived.map((l) => (
              <LeadCard key={l.id} lead={l} roster={roster} availability={availability} highlighted={l.id === highlightLeadId} companySettings={companySettings} onSetAvail={setAvail} onUpdateLead={updateLead} onDeleteLead={deleteLead} onSaveNotes={saveNotes} />
            ))}
          </>
        )}

        {role === "owner" && activeTab === "roster" && (
          <Roster roster={roster} rosterProfiles={rosterProfiles} onChanged={loadData} onSetTiers={saveDjTiers} ping={ping} />
        )}

        {role === "owner" && activeTab === "settings" && companySettings && (
          <CompanySettings settings={companySettings} onSave={saveSettings} />
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
            {myChecks.sort(byDate).map((l) => (
              <LeadCard key={l.id} lead={l} djView roster={roster} availability={availability} myAnswer={myAvailability[l.id]} highlighted={l.id === highlightLeadId} companySettings={companySettings} onSetAvail={setAvail} onUpdateLead={updateLead} onDeleteLead={deleteLead} onSaveNotes={saveNotes} />
            ))}
          </>
        )}

        {role === "dj" && activeTab === "mine" && (
          <>
            {myGigs.length === 0 && <Empty text="No booked gigs yet — answer date checks and Austin books from there." />}
            {myGigs.sort(byDate).map((l) => (
              <LeadCard key={l.id} lead={l} djView roster={roster} availability={availability} myAnswer={myAvailability[l.id]} highlighted={l.id === highlightLeadId} companySettings={companySettings} onSetAvail={setAvail} onUpdateLead={updateLead} onDeleteLead={deleteLead} onSaveNotes={saveNotes} />
            ))}
          </>
        )}
      </main>

      {toast && (
        <div style={{
          position: "fixed", bottom: 18, left: "50%", transform: "translateX(-50%)",
          background: T.raised, border: `1px solid ${T.amber}66`, color: T.text,
          padding: "10px 18px", borderRadius: 8, fontSize: 13, fontWeight: 700,
          boxShadow: "0 6px 24px rgba(0,0,0,.5)", zIndex: 50,
          maxWidth: "90vw", textAlign: "center",
        }}>
          {toast}
        </div>
      )}
    </div>
  );
}
