import { useState } from "react";
import { Terminal } from "./components/Terminal";

export function App() {
  const [cwd, setCwd] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("cwd") ?? "/";
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#1f1f1f" }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 12px",
          background: "#2d2d2d",
          borderBottom: "1px solid #3d3d3d",
          flexShrink: 0,
        }}
      >
        <span style={{ color: "#cccccc", fontFamily: "monospace", fontSize: 13, fontWeight: 600 }}>
          codehost
        </span>
        <span style={{ color: "#888", fontSize: 12 }}>|</span>
        <CwdInput cwd={cwd} onChange={setCwd} />
      </header>
      <Terminal wsUrl="/ws" cwd={cwd} onCwdChange={setCwd} style={{ flex: 1, minHeight: 0 }} />
    </div>
  );
}

function CwdInput({ cwd, onChange }: { cwd: string; onChange: (cwd: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(cwd);

  if (editing) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onChange(draft);
          setEditing(false);
        }}
        style={{ flex: 1 }}
      >
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => e.key === "Escape" && setEditing(false)}
          style={{
            width: "100%",
            background: "#1f1f1f",
            border: "1px solid #555",
            color: "#ccc",
            fontFamily: "monospace",
            fontSize: 12,
            padding: "2px 6px",
            borderRadius: 3,
            outline: "none",
          }}
        />
      </form>
    );
  }

  return (
    <button
      onClick={() => { setDraft(cwd); setEditing(true); }}
      title="Click to change directory"
      style={{
        background: "none",
        border: "none",
        cursor: "pointer",
        color: "#888",
        fontFamily: "monospace",
        fontSize: 12,
        padding: "2px 4px",
        borderRadius: 3,
        textAlign: "left",
        maxWidth: 500,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {cwd}
    </button>
  );
}
