export const T = {
  bg: "#14151F",
  surface: "#1E2030",
  raised: "#262A3D",
  line: "#32364D",
  text: "#EEEDE6",
  dim: "#9AA0B5",
  amber: "#FFB627",
  green: "#46D97C",
  violet: "#A78BFA",
  blue: "#7C8DB5",
  red: "#F0616D",
};

export const DJ_TIERS = ["Headliner", "Resident", "Associate"] as const;
export const PROD_TIERS = ["Marquee", "Modern", "Essential"] as const;
export const TRAVEL_ZONES = ["Local", "Extended Local", "Regional", "Central CA"] as const;

export const LEAD_STATUS: Record<string, { label: string; color: string }> = {
  checking: { label: "DATE CHECK", color: T.amber },
  ready: { label: "DJ AVAILABLE", color: T.green },
  meeting: { label: "MEETING BOOKED", color: T.violet },
  booked: { label: "BOOKED", color: T.green },
  played: { label: "PLAYED", color: T.blue },
  lost: { label: "LOST", color: T.red },
};

export function fmtDate(iso: string | null) {
  if (!iso) return { day: "—", mon: "TBD", dow: "", year: "" };
  const d = new Date(iso + "T12:00:00");
  return {
    day: String(d.getDate()).padStart(2, "0"),
    mon: d.toLocaleString("en-US", { month: "short" }).toUpperCase(),
    dow: d.toLocaleString("en-US", { weekday: "short" }),
    year: d.getFullYear(),
  };
}

export const Lamp = ({ color, pulse }: { color: string; pulse?: boolean }) => (
  <span
    className={pulse ? "lamp-pulse" : ""}
    style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: color, boxShadow: `0 0 8px ${color}`, flexShrink: 0 }}
  />
);

export const Tag = ({ children, color }: { children: React.ReactNode; color: string }) => (
  <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", color, border: `1px solid ${color}55`, borderRadius: 3, padding: "2px 6px", whiteSpace: "nowrap" }}>
    {children}
  </span>
);

export const Btn = ({
  children,
  onClick,
  kind = "ghost",
  small,
  disabled,
  style,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  kind?: "primary" | "green" | "danger" | "ghost";
  small?: boolean;
  disabled?: boolean;
  style?: React.CSSProperties;
}) => {
  const base: React.CSSProperties = {
    fontFamily: "inherit", fontWeight: 700, letterSpacing: "0.06em",
    fontSize: small ? 12 : 13, padding: small ? "6px 12px" : "10px 16px",
    borderRadius: 6, cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.4 : 1,
    border: "1px solid transparent", transition: "filter 120ms",
  };
  const kinds: Record<string, React.CSSProperties> = {
    primary: { background: T.amber, color: "#1A1502", borderColor: T.amber },
    green: { background: T.green, color: "#06210F", borderColor: T.green },
    danger: { background: "transparent", color: T.red, borderColor: T.red + "66" },
    ghost: { background: "transparent", color: T.dim, borderColor: T.line },
  };
  return (
    <button
      onClick={disabled ? undefined : onClick}
      style={{ ...base, ...kinds[kind], ...style }}
      onMouseEnter={(e) => (e.currentTarget.style.filter = "brightness(1.15)")}
      onMouseLeave={(e) => (e.currentTarget.style.filter = "none")}
    >
      {children}
    </button>
  );
};

export const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 130 }}>
    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.14em", color: T.dim }}>{label}</span>
    {children}
  </label>
);

const inputStyle: React.CSSProperties = {
  background: T.bg, border: `1px solid ${T.line}`, borderRadius: 6, color: T.text,
  padding: "9px 10px", fontSize: 14, fontFamily: "inherit", outline: "none", width: "100%", boxSizing: "border-box",
};
export const Input = (p: React.InputHTMLAttributes<HTMLInputElement>) => <input {...p} style={{ ...inputStyle, ...p.style }} />;
export const Select = (p: React.SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} style={{ ...inputStyle, ...p.style }} />;
export const TextArea = (p: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea {...p} style={{ ...inputStyle, minHeight: 60, resize: "vertical", ...p.style }} />
);

export const Empty = ({ text }: { text: string }) => (
  <div style={{ border: `1px dashed ${T.line}`, borderRadius: 10, padding: 24, textAlign: "center", color: T.dim, fontSize: 13 }}>{text}</div>
);

export const TierPicker = ({
  djTier,
  prodTier,
  onChange,
}: {
  djTier: string;
  prodTier: string;
  onChange: (v: { djTier: string; prodTier: string }) => void;
}) => (
  <div style={{ display: "flex", gap: 10, flexWrap: "wrap", flex: 2, minWidth: 260 }}>
    <Field label="TIER — DJ">
      <Select value={djTier} onChange={(e) => onChange({ djTier: e.target.value, prodTier })}>
        <option value="">Pick DJ tier…</option>
        {DJ_TIERS.map((t) => <option key={t}>{t}</option>)}
      </Select>
    </Field>
    <Field label="TIER — PRODUCTION">
      <Select value={prodTier} onChange={(e) => onChange({ djTier, prodTier: e.target.value })}>
        <option value="">Pick production tier…</option>
        {PROD_TIERS.map((t) => <option key={t}>{t}</option>)}
      </Select>
    </Field>
  </div>
);
