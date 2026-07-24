"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

const T = {
  bg: "#0A1B1B",
  surface: "#0E2827",
  line: "#184E4A",
  teal: "#184E4A",
  text: "#F2EFEA",
  dim: "#90A7A2",
  accent: "#F2EFEA",
};

const inputStyle = {
  background: T.bg, border: `1px solid ${T.line}`, borderRadius: 6, color: T.text,
  padding: "9px 10px", fontSize: 14, fontFamily: "inherit", outline: "none", width: "100%", boxSizing: "border-box" as const,
};

export default function SetPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 8) { setError("Use at least 8 characters."); return; }
    if (password !== confirm) { setError("Those don't match."); return; }
    setBusy(true);
    setError("");
    const supabase = createClient();
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) { setError(error.message); return; }
    router.push("/board");
  };

  return (
    <div style={{ background: T.bg, minHeight: "100vh", color: T.text, display: "grid", placeItems: "center", fontFamily: "var(--font-body), system-ui, -apple-system, sans-serif", padding: 16 }}>
      <div style={{ width: "100%", maxWidth: 360, display: "flex", flexDirection: "column", gap: 18 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, justifyContent: "center" }}>
          <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: T.accent, boxShadow: `0 0 8px ${T.accent}` }} />
          <div>
            <div style={{ fontWeight: 900, fontSize: 18, letterSpacing: "0.14em", textAlign: "center", fontFamily: "var(--font-heading), serif" }}>AUSTO</div>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.34em", color: T.dim, marginTop: -2, textAlign: "center" }}>GIG BOARD</div>
          </div>
        </div>

        <div style={{ background: T.surface, border: `1px solid ${T.line}`, borderRadius: 10, padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ fontWeight: 800, fontSize: 13 }}>SET YOUR PASSWORD</div>
          <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.14em", color: T.dim }}>NEW PASSWORD</span>
              <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" style={inputStyle} />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.14em", color: T.dim }}>CONFIRM PASSWORD</span>
              <input type="password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Type it again" style={inputStyle} />
            </label>
            <button
              type="submit"
              disabled={busy}
              style={{
                fontFamily: "inherit", fontWeight: 700, letterSpacing: "0.06em", fontSize: 13,
                padding: "10px 16px", borderRadius: 6, cursor: busy ? "default" : "pointer",
                background: T.teal, color: T.text, border: `1px solid ${T.teal}`, opacity: busy ? 0.6 : 1,
              }}
            >
              {busy ? "SAVING…" : "SAVE PASSWORD"}
            </button>
            {error && <div style={{ fontSize: 12.5, color: "#F0616D" }}>{error}</div>}
          </form>
        </div>
      </div>
    </div>
  );
}
