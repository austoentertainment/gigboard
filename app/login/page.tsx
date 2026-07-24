"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

const T = {
  bg: "#14151F",
  surface: "#1E2030",
  raised: "#262A3D",
  line: "#32364D",
  text: "#EEEDE6",
  dim: "#9AA0B5",
  amber: "#FFB627",
  green: "#46D97C",
};

const inputStyle = {
  background: T.bg, border: `1px solid ${T.line}`, borderRadius: 6, color: T.text,
  padding: "9px 10px", fontSize: 14, fontFamily: "inherit", outline: "none", width: "100%", boxSizing: "border-box" as const,
};

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"signin" | "forgot">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);

  const signIn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) return;
    setBusy(true);
    setError("");
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) { setError(error.message); return; }
    router.push("/board");
  };

  const sendSetupLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setBusy(true);
    setError("");
    const supabase = createClient();
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/auth/callback?next=/set-password`,
    });
    setBusy(false);
    if (error) { setError(error.message); return; }
    setSent(true);
  };

  return (
    <div
      style={{
        background: T.bg, minHeight: "100vh", color: T.text, display: "grid", placeItems: "center",
        fontFamily: "var(--font-body), system-ui, -apple-system, sans-serif", padding: 16,
      }}
    >
      <div style={{ width: "100%", maxWidth: 360, display: "flex", flexDirection: "column", gap: 18 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, justifyContent: "center" }}>
          <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: T.amber, boxShadow: `0 0 8px ${T.amber}` }} />
          <div>
            <div style={{ fontWeight: 900, fontSize: 18, letterSpacing: "0.14em", textAlign: "center", fontFamily: "var(--font-heading), serif" }}>AUSTO</div>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.34em", color: T.dim, marginTop: -2, textAlign: "center" }}>GIG BOARD</div>
          </div>
        </div>

        <div style={{ background: T.surface, border: `1px solid ${T.line}`, borderRadius: 10, padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
          {mode === "signin" && (
            <form onSubmit={signIn} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.14em", color: T.dim }}>EMAIL</span>
                <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" style={inputStyle} />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.14em", color: T.dim }}>PASSWORD</span>
                <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" style={inputStyle} />
              </label>
              <button
                type="submit"
                disabled={busy}
                style={{
                  fontFamily: "inherit", fontWeight: 700, letterSpacing: "0.06em", fontSize: 13,
                  padding: "10px 16px", borderRadius: 6, cursor: busy ? "default" : "pointer",
                  background: T.amber, color: "#1A1502", border: `1px solid ${T.amber}`, opacity: busy ? 0.6 : 1,
                }}
              >
                {busy ? "SIGNING IN…" : "SIGN IN"}
              </button>
              {error && <div style={{ fontSize: 12.5, color: "#F0616D" }}>{error}</div>}
              <button
                type="button"
                onClick={() => { setMode("forgot"); setError(""); }}
                style={{ background: "none", border: "none", color: T.dim, fontSize: 12, fontFamily: "inherit", cursor: "pointer", textDecoration: "underline", padding: 0, textAlign: "left" }}
              >
                Forgot your password, or signing in for the first time?
              </button>
            </form>
          )}

          {mode === "forgot" && (
            sent ? (
              <>
                <div style={{ fontWeight: 800, fontSize: 13, color: T.green }}>CHECK YOUR EMAIL</div>
                <div style={{ fontSize: 13, color: T.dim }}>
                  Sent a link to <span style={{ color: T.text }}>{email}</span> — open it to set your password.
                </div>
              </>
            ) : (
              <form onSubmit={sendSetupLink} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ fontSize: 12.5, color: T.dim }}>
                  Enter your email and we&apos;ll send you a link to set (or reset) your password.
                </div>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.14em", color: T.dim }}>EMAIL</span>
                  <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" style={inputStyle} />
                </label>
                <button
                  type="submit"
                  disabled={busy}
                  style={{
                    fontFamily: "inherit", fontWeight: 700, letterSpacing: "0.06em", fontSize: 13,
                    padding: "10px 16px", borderRadius: 6, cursor: busy ? "default" : "pointer",
                    background: T.amber, color: "#1A1502", border: `1px solid ${T.amber}`, opacity: busy ? 0.6 : 1,
                  }}
                >
                  {busy ? "SENDING…" : "SEND SETUP LINK"}
                </button>
                {error && <div style={{ fontSize: 12.5, color: "#F0616D" }}>{error}</div>}
                <button
                  type="button"
                  onClick={() => { setMode("signin"); setError(""); }}
                  style={{ background: "none", border: "none", color: T.dim, fontSize: 12, fontFamily: "inherit", cursor: "pointer", textDecoration: "underline", padding: 0, textAlign: "left" }}
                >
                  Back to sign in
                </button>
              </form>
            )
          )}
        </div>
      </div>
    </div>
  );
}
