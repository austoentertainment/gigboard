"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { Database, DjTier, ProdTier } from "@/lib/supabase/types";
import {
  T, DJ_TIERS, LEAD_STATUS, fmtDate,
  Lamp, Tag, Btn, Field, Input, Select, TextArea, Empty, TierPicker,
} from "./ui";

type LeadRow = Database["public"]["Views"]["leads_feed"]["Row"];
type LeadInsert = Database["public"]["Tables"]["leads"]["Insert"];
type LeadUpdate = Database["public"]["Tables"]["leads"]["Update"];
type RosterUser = { id: string; email: string; display_name: string | null };
type AvailabilityRow = { lead_id: string; dj_user_id: string; response: "available" | "pass" };

const tierStr = (l: LeadRow) => [l.dj_tier, l.prod_tier].filter(Boolean).join(" + ");
const byDate = (a: LeadRow, b: LeadRow) => ((a.event_date || "9999") > (b.event_date || "9999") ? 1 : -1);

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

function LeadCard({
  lead, djView, roster, availability, myAnswer,
  onSetAvail, onUpdateLead, onDeleteLead,
}: {
  lead: LeadRow;
  djView?: boolean;
  roster: RosterUser[];
  availability: AvailabilityRow[];
  myAnswer?: "available" | "pass";
  onSetAvail: (leadId: string, answer: "available" | "pass") => void;
  onUpdateLead: (id: string, patch: LeadUpdate, msg?: string) => void;
  onDeleteLead: (id: string) => void;
}) {
  const st = leadStatus(lead);
  const s = LEAD_STATUS[st];
  const d = fmtDate(lead.event_date);
  const availDjIds = availability.filter((r) => r.lead_id === lead.id && r.response === "available").map((r) => r.dj_user_id);
  const tier = tierStr(lead);

  return (
    <div style={{ display: "flex", background: T.surface, border: `1px solid ${st === "ready" && !djView ? T.green + "66" : T.line}`, borderRadius: 10, overflow: "hidden" }}>
      <div style={{ width: 74, background: T.raised, borderRight: `1px solid ${T.line}`, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, padding: "14px 8px", flexShrink: 0 }}>
        <Lamp color={s.color} pulse={st === "checking" || (st === "ready" && !djView)} />
        <div style={{ fontSize: 26, fontWeight: 900, lineHeight: 1, fontFamily: "'Archivo', system-ui, sans-serif" }}>{d.day}</div>
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.18em", color: T.dim }}>{d.mon} {d.year ? String(d.year).slice(2) : ""}</div>
        {d.dow && <div style={{ fontSize: 10, color: T.dim }}>{d.dow}</div>}
      </div>

      <div style={{ flex: 1, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: 15 }}>
              {djView ? (tier || "Gig") : (lead.client_name || "Unnamed lead")}
            </div>
            <div style={{ fontSize: 12.5, color: T.dim, marginTop: 2 }}>
              {djView
                ? [lead.location, lead.payout ? `$${lead.payout} payout` : null].filter(Boolean).join(" · ") || "details TBD"
                : [tier, lead.location].filter(Boolean).join(" · ") || "tier TBD"}
            </div>
          </div>
          <Tag color={s.color}>{s.label}</Tag>
        </div>

        {!djView && (
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 12.5, color: T.dim }}>
            {lead.contact && <span>{lead.contact}</span>}
            {lead.source && <span>via {lead.source}</span>}
            {lead.assigned_dj_id && (
              <span>DJ: <span style={{ color: T.text, fontWeight: 700 }}>
                {roster.find((d) => d.id === lead.assigned_dj_id)?.display_name || "assigned"}
              </span></span>
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

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 2, alignItems: "center" }}>
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

function ImportForm({ onSave, onCancel, ping }: { onSave: (fields: LeadInsert) => void; onCancel: () => void; ping: (m: string) => void }) {
  const [raw, setRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [parsed, setParsed] = useState<null | {
    name: string; contact: string; date: string; location: string;
    djTier: string; prodTier: string; upgrades: string; vision: string;
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
      setParsed(data);
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
          <TierPicker djTier={parsed.djTier} prodTier={parsed.prodTier} onChange={({ djTier, prodTier }) => setParsed({ ...parsed, djTier, prodTier })} />
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

function ManualForm({ onSave, onCancel, ping }: { onSave: (fields: LeadInsert) => void; onCancel: () => void; ping: (m: string) => void }) {
  const [f, setF] = useState({
    name: "", contact: "", date: "", location: "", djTier: "", prodTier: "",
    upgrades: "", vision: "", source: "", notes: "", djNotes: "", payout: "",
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
      <Field label="LOCATION"><Input value={f.location} onChange={set("location")} placeholder="The Colony House, Anaheim" /></Field>
      <TierPicker djTier={f.djTier} prodTier={f.prodTier} onChange={({ djTier, prodTier }) => setF({ ...f, djTier, prodTier })} />
      <Field label="UPGRADES"><Input value={f.upgrades} onChange={set("upgrades")} placeholder="Guac Booth, CO2, uplighting…" /></Field>
      <Field label="CLIENT VISION"><TextArea value={f.vision} onChange={set("vision")} /></Field>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Field label="SOURCE"><Input value={f.source} onChange={set("source")} placeholder="HoneyBook / IG / referral" /></Field>
        <Field label="DJ PAYOUT ($) — SHOWN TO DJs"><Input type="number" value={f.payout} onChange={set("payout")} /></Field>
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
          });
        }}>SAVE LEAD</Btn>
        <Btn onClick={onCancel}>CANCEL</Btn>
      </div>
    </div>
  );
}

function Roster({ roster, onChanged, ping }: { roster: RosterUser[]; onChanged: () => void; ping: (m: string) => void }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const invite = async () => {
    if (!email.trim()) return;
    setBusy(true);
    const res = await fetch("/api/roster", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim(), displayName: name.trim() || null }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) { ping(data.error || "Couldn't send that invite"); return; }
    ping(`Invited ${name.trim() || email.trim()}`);
    setEmail(""); setName("");
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
        <Btn kind="primary" onClick={invite} disabled={busy}>{busy ? "INVITING…" : "INVITE"}</Btn>
      </div>
      {roster.length === 0 && <Empty text="No DJs yet. Invite your Residents and Associates — they'll get a sign-in link by email." />}
      {roster.map((dj) => (
        <div key={dj.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: T.surface, border: `1px solid ${T.line}`, borderRadius: 8, padding: "10px 14px" }}>
          <div>
            <div style={{ fontWeight: 700 }}>{dj.display_name || "(pending sign-in)"}</div>
            <div style={{ fontSize: 12, color: T.dim }}>{dj.email}</div>
          </div>
          <Btn kind="ghost" small style={{ color: T.red, borderColor: T.red + "44" }} onClick={() => remove(dj.id, dj.display_name || dj.email)}>✕</Btn>
        </div>
      ))}
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

  const [loading, setLoading] = useState(true);
  const [leads, setLeads] = useState<LeadRow[]>([]);
  const [roster, setRoster] = useState<RosterUser[]>([]);
  const [availability, setAvailability] = useState<AvailabilityRow[]>([]);
  const [myAvailability, setMyAvailability] = useState<Record<string, "available" | "pass">>({});
  const [myTiers, setMyTiers] = useState<string[]>([]);
  const [tab, setTab] = useState("pipeline");
  const [toast, setToast] = useState("");
  const [showAdd, setShowAdd] = useState<"import" | "manual" | false>(false);

  const ping = useCallback((m: string) => { setToast(m); setTimeout(() => setToast(""), 2600); }, []);

  const loadData = useCallback(async () => {
    const { data: leadsData } = await supabase.from("leads_feed").select("*").order("created_at", { ascending: false });
    setLeads(leadsData ?? []);

    if (role === "owner") {
      const { data: rosterData } = await supabase.from("users").select("id,email,display_name").eq("role", "dj").order("display_name");
      setRoster(rosterData ?? []);
      const { data: availData } = await supabase.from("availability_responses").select("lead_id,dj_user_id,response");
      setAvailability(availData ?? []);
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

  const logout = async () => {
    await supabase.auth.signOut();
    router.push("/login");
  };

  const toggleTier = async (t: string) => {
    const next = myTiers.includes(t) ? myTiers.filter((x) => x !== t) : [...myTiers, t];
    setMyTiers(next);
    await supabase.from("dj_profiles").update({ dj_tier_visibility: next as DjTier[] }).eq("user_id", userId);
  };

  const setAvail = async (leadId: string, answer: "available" | "pass") => {
    setMyAvailability((prev) => ({ ...prev, [leadId]: answer }));
    const { error } = await supabase
      .from("availability_responses")
      .upsert({ lead_id: leadId, dj_user_id: userId, response: answer }, { onConflict: "lead_id,dj_user_id" });
    if (error) { ping("Couldn't save — check connection and retry"); return; }
    ping(answer === "available" ? "Marked available — Austin's been signaled" : "Passed on this date");
    loadData();
  };

  const updateLead = async (id: string, patch: LeadUpdate, msg?: string) => {
    const { error } = await supabase.from("leads").update(patch).eq("id", id);
    if (error) { ping("Couldn't save — check connection and retry"); return; }
    if (msg) ping(msg);
    loadData();
  };

  const deleteLead = async (id: string) => {
    if (!window.confirm("Delete this lead entirely?")) return;
    const { error } = await supabase.from("leads").delete().eq("id", id);
    if (error) { ping("Couldn't delete — check connection and retry"); return; }
    ping("Lead deleted");
    loadData();
  };

  const addLead = async (fields: LeadInsert) => {
    const { error } = await supabase.from("leads").insert(fields);
    if (error) { ping("Couldn't save — check connection and retry"); return; }
    ping("Lead is on the board — date check is live");
    setShowAdd(false);
    loadData();
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

  const tierVisible = (l: LeadRow) => myTiers.length === 0 || !l.dj_tier || myTiers.includes(l.dj_tier);
  const myChecks = checking.filter(tierVisible);
  const needsMe = myChecks.filter((l) => !myAvailability[l.id]);
  const myGigs = leads.filter((l) => l.assigned_dj_id === userId && ["booked", "played"].includes(leadStatus(l)));

  const ownerTabs = [
    { id: "pipeline", label: "PIPELINE", count: checking.length },
    { id: "motion", label: "MEETINGS & BOOKED", count: inMotion.length },
    { id: "archive", label: "ARCHIVE", count: archived.length },
    { id: "roster", label: "ROSTER", count: roster.length },
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
            {showAdd === "import" && <ImportForm onSave={addLead} onCancel={() => setShowAdd(false)} ping={ping} />}
            {showAdd === "manual" && <ManualForm onSave={addLead} onCancel={() => setShowAdd(false)} ping={ping} />}
            {checking.length === 0 && !showAdd && (
              <Empty text="No leads in date check. Import a HoneyBook inquiry and your roster gets pinged for availability." />
            )}
            {checking.filter((l) => leadStatus(l) === "ready").length > 0 && (
              <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.16em", color: T.green }}>DJ AVAILABLE — CONTACT THESE LEADS</div>
            )}
            {checking.filter((l) => leadStatus(l) === "ready").sort(byDate).map((l) => (
              <LeadCard key={l.id} lead={l} roster={roster} availability={availability} onSetAvail={setAvail} onUpdateLead={updateLead} onDeleteLead={deleteLead} />
            ))}
            {checking.filter((l) => leadStatus(l) === "checking").length > 0 && (
              <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.16em", color: T.amber, marginTop: 4 }}>WAITING ON DATE CHECKS</div>
            )}
            {checking.filter((l) => leadStatus(l) === "checking").sort(byDate).map((l) => (
              <LeadCard key={l.id} lead={l} roster={roster} availability={availability} onSetAvail={setAvail} onUpdateLead={updateLead} onDeleteLead={deleteLead} />
            ))}
          </>
        )}

        {role === "owner" && activeTab === "motion" && (
          <>
            {inMotion.length === 0 && <Empty text="Nothing in motion. When a date check comes back green, book the meeting and it moves here." />}
            {inMotion.sort(byDate).map((l) => (
              <LeadCard key={l.id} lead={l} roster={roster} availability={availability} onSetAvail={setAvail} onUpdateLead={updateLead} onDeleteLead={deleteLead} />
            ))}
          </>
        )}

        {role === "owner" && activeTab === "archive" && (
          <>
            {archived.length === 0 && <Empty text="Played and lost leads end up here." />}
            {archived.map((l) => (
              <LeadCard key={l.id} lead={l} roster={roster} availability={availability} onSetAvail={setAvail} onUpdateLead={updateLead} onDeleteLead={deleteLead} />
            ))}
          </>
        )}

        {role === "owner" && activeTab === "roster" && <Roster roster={roster} onChanged={loadData} ping={ping} />}

        {role === "dj" && activeTab === "checks" && (
          <>
            {roster.length === 0 && checking.length === 0 && <Empty text="No open date checks yet." />}
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.16em", color: T.dim }}>SHOW ME</span>
              {DJ_TIERS.map((t) => {
                const on = myTiers.length === 0 || myTiers.includes(t);
                const explicit = myTiers.includes(t);
                return (
                  <button
                    key={t}
                    onClick={() => toggleTier(t)}
                    style={{
                      fontFamily: "inherit", fontSize: 12, fontWeight: 700, letterSpacing: "0.06em",
                      padding: "5px 12px", borderRadius: 20, cursor: "pointer",
                      background: explicit ? T.amber : "transparent",
                      color: explicit ? "#1A1502" : on ? T.text : T.dim,
                      border: `1px solid ${explicit ? T.amber : T.line}`,
                      opacity: on ? 1 : 0.55,
                    }}
                  >
                    {t}
                  </button>
                );
              })}
              <span style={{ fontSize: 11, color: T.dim }}>
                {myTiers.length === 0 ? "showing all tiers — tap to filter" : `filtering: ${myTiers.join(", ")}`}
              </span>
            </div>
            {myChecks.length === 0 && checking.length > 0 && (
              <Empty text="No date checks match your tier filter. Tap the tiers above to widen it." />
            )}
            {checking.length === 0 && <Empty text="No open date checks. New ones light up amber when they drop." />}
            {myChecks.sort(byDate).map((l) => (
              <LeadCard key={l.id} lead={l} djView roster={roster} availability={availability} myAnswer={myAvailability[l.id]} onSetAvail={setAvail} onUpdateLead={updateLead} onDeleteLead={deleteLead} />
            ))}
          </>
        )}

        {role === "dj" && activeTab === "mine" && (
          <>
            {myGigs.length === 0 && <Empty text="No booked gigs yet — answer date checks and Austin books from there." />}
            {myGigs.sort(byDate).map((l) => (
              <LeadCard key={l.id} lead={l} djView roster={roster} availability={availability} myAnswer={myAvailability[l.id]} onSetAvail={setAvail} onUpdateLead={updateLead} onDeleteLead={deleteLead} />
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
        }}>
          {toast}
        </div>
      )}
    </div>
  );
}
