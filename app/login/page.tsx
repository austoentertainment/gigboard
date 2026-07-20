"use client";

import { useState } from "react";
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

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");

  const sendLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setStatus("sending");
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    });
    setStatus(error ? "error" : "sent");
  };

  return (
    <div
      style={{
        background: T.bg,
        minHeight: "100vh",
        color: T.text,
        display: "grid",
        placeItems: "center",
        fontFamily: "'Archivo', system-ui, -apple-system, sans-serif",
        padding: 16,
      }}
    >
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..900&display=swap');`}</style>
      <div style={{ width: "100%", maxWidth: 360, display: "flex", flexDirection: "column", gap: 18 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, justifyContent: "center" }}>
          <span
            style={{
              display: "inline-block", width: 10, height: 10, borderRadius: "50%",
              background: T.amber, boxShadow: `0 0 8px ${T.amber}`,
            }}
          />
          <div>
            <div style={{ fontWeight: 900, fontSize: 18, letterSpacing: "0.14em", textAlign: "center" }}>AUSTO</div>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.34em", color: T.dim, marginTop: -2, textAlign: "center" }}>
              GIG BOARD
            </div>
          </div>
        </div>

        <div style={{ background: T.surface, border: `1px solid ${T.line}`, borderRadius: 10, padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
          {status === "sent" ? (
            <>
              <div style={{ fontWeight: 800, fontSize: 13, color: T.green }}>CHECK YOUR EMAIL</div>
              <div style={{ fontSize: 13, color: T.dim }}>
                Sent a sign-in link to <span style={{ color: T.text }}>{email}</span>. Tap it on this device to log in.
              </div>
            </>
          ) : (
            <form onSubmit={sendLink} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.14em", color: T.dim }}>EMAIL</span>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  style={{
                    background: T.bg, border: `1px solid ${T.line}`, borderRadius: 6, color: T.text,
                    padding: "9px 10px", fontSize: 14, fontFamily: "inherit", outline: "none",
                  }}
                />
              </label>
              <button
                type="submit"
                disabled={status === "sending"}
                style={{
                  fontFamily: "inherit", fontWeight: 700, letterSpacing: "0.06em", fontSize: 13,
                  padding: "10px 16px", borderRadius: 6, cursor: status === "sending" ? "default" : "pointer",
                  background: T.amber, color: "#1A1502", border: `1px solid ${T.amber}`,
                  opacity: status === "sending" ? 0.6 : 1,
                }}
              >
                {status === "sending" ? "SENDING…" : "SEND SIGN-IN LINK"}
              </button>
              {status === "error" && (
                <div style={{ fontSize: 12.5, color: "#F0616D" }}>Couldn&apos;t send that — check the email and try again.</div>
              )}
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
