export default function Header({ running }) {
  return (
    <header className="hdr">
      <div className="hdr-mark">
        <span className={`hdr-dot${running ? " live" : ""}`} />
        <span className="hdr-title">WAYFINDER</span>
      </div>
      <div className="hdr-sub">an LLM piloting a real browser, tool call by tool call</div>
    </header>
  );
}
