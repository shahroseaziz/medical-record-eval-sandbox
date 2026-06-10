/* ============================================================
   Shared UI primitives — the component foundation.
   Exposes atoms on window for the screen scripts.
   ============================================================ */
const { useState, useRef, useEffect, useLayoutEffect } = React;

/* ---------- tiny inline icons (kept to primitives) ---------- */
function Icon({ name, size = 16, stroke = 1.75, color = 'currentColor', style }) {
  const p = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    stroke: color, strokeWidth: stroke, strokeLinecap: 'round', strokeLinejoin: 'round', style };
  const paths = {
    check: <polyline points="20 6 9 17 4 12" />,
    x: <g><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></g>,
    minus: <line x1="5" y1="12" x2="19" y2="12" />,
    arrow: <g><line x1="5" y1="12" x2="19" y2="12" /><polyline points="13 6 19 12 13 18" /></g>,
    arrowL: <g><line x1="19" y1="12" x2="5" y2="12" /><polyline points="11 18 5 12 11 6" /></g>,
    play: <polygon points="6 4 20 12 6 20 6 4" fill={color} stroke="none" />,
    spark: <g><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" /></g>,
    eye: <g><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></g>,
    layers: <g><polygon points="12 2 22 8.5 12 15 2 8.5 12 2" /><polyline points="2 15.5 12 22 22 15.5" /></g>,
    doc: <g><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><polyline points="14 2 14 8 20 8" /></g>,
    target: <g><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r="0.6" fill={color} /></g>,
    flask: <g><path d="M9 3h6M10 3v6l-5.2 8.4A2 2 0 0 0 6.5 21h11a2 2 0 0 0 1.7-3.1L14 9V3" /><line x1="8" y1="14" x2="16" y2="14" /></g>,
    scale: <g><path d="M12 3v18M5 7h14M5 7l-3 6h6ZM19 7l-3 6h6Z" /></g>,
    reset: <g><path d="M3 12a9 9 0 1 0 3-6.7" /><polyline points="3 4 3 9 8 9" /></g>,
    chevron: <polyline points="6 9 12 15 18 9" />,
    info: <g><circle cx="12" cy="12" r="9" /><line x1="12" y1="11" x2="12" y2="16" /><circle cx="12" cy="8" r="0.6" fill={color} /></g>,
    grip: <g><circle cx="9" cy="6" r="1" fill={color} stroke="none"/><circle cx="9" cy="12" r="1" fill={color} stroke="none"/><circle cx="9" cy="18" r="1" fill={color} stroke="none"/><circle cx="15" cy="6" r="1" fill={color} stroke="none"/><circle cx="15" cy="12" r="1" fill={color} stroke="none"/><circle cx="15" cy="18" r="1" fill={color} stroke="none"/></g>,
  };
  return <svg {...p}>{paths[name]}</svg>;
}

/* ---------- Gloss: just-in-time inline jargon ---------- */
/* A dotted-underline term. Hover/focus/click reveals a small card:
   plain-language line first, then the "real" definition. */
function Gloss({ term, plain, real, children }) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState({ x: 0, y: 0, above: false });
  const ref = useRef(null);
  const reposition = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const above = r.top > 230;
    setCoords({ x: r.left + r.width / 2, y: above ? r.top - 8 : r.bottom + 8, above });
  };
  useLayoutEffect(() => { if (open) reposition(); }, [open]);
  useEffect(() => {
    if (!open) return;
    const h = () => setOpen(false);
    window.addEventListener('scroll', h, true);
    window.addEventListener('resize', h);
    return () => { window.removeEventListener('scroll', h, true); window.removeEventListener('resize', h); };
  }, [open]);

  return (
    <span
      ref={ref}
      tabIndex={0}
      role="button"
      aria-label={`${term}: ${plain}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
      style={{
        position: 'relative', cursor: 'help', color: 'var(--accent-ink)',
        fontWeight: 500, textDecoration: 'underline',
        textDecorationStyle: 'dotted', textDecorationColor: 'var(--accent-line)',
        textUnderlineOffset: '3px', whiteSpace: 'nowrap',
      }}
    >
      {children || term}
      {open && ReactDOM.createPortal(
        <span
          role="tooltip"
          style={{
            position: 'fixed', left: coords.x, top: coords.y,
            transform: `translate(-50%, ${coords.above ? '-100%' : '0'})`,
            zIndex: 9999, width: 296, maxWidth: '78vw',
            background: 'var(--surface)', border: '1px solid var(--line-2)',
            borderRadius: 'var(--r-md)', boxShadow: 'var(--sh-lg)',
            padding: '13px 15px', textAlign: 'left', whiteSpace: 'normal',
            animation: 'fadeUp .14s ease both', pointerEvents: 'none',
          }}
        >
          <span style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: 10.5,
            letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--accent)', marginBottom: 6 }}>
            {term}
          </span>
          <span style={{ display: 'block', fontSize: 13.5, lineHeight: 1.5, color: 'var(--ink)', fontWeight: 500 }}>
            {plain}
          </span>
          {real && (
            <span style={{ display: 'block', fontSize: 12, lineHeight: 1.55, color: 'var(--ink-3)',
              marginTop: 7, paddingTop: 7, borderTop: '1px solid var(--line)' }}>
              {real}
            </span>
          )}
        </span>,
        document.body
      )}
    </span>
  );
}

/* ---------- Button ---------- */
function Btn({ variant = 'primary', size = 'md', icon, iconR, children, style, ...rest }) {
  const sizes = {
    sm: { padding: '7px 13px', fontSize: 13, gap: 6 },
    md: { padding: '10px 18px', fontSize: 14.5, gap: 8 },
    lg: { padding: '14px 26px', fontSize: 16, gap: 9 },
  };
  const variants = {
    primary: { background: 'var(--accent)', color: '#fff', border: '1px solid transparent', boxShadow: 'var(--sh-accent)' },
    press:   { background: 'var(--accent-press)', color: '#fff', border: '1px solid transparent' },
    soft:    { background: 'var(--accent-soft)', color: 'var(--accent-ink)', border: '1px solid var(--accent-line)' },
    ghost:   { background: 'transparent', color: 'var(--ink-2)', border: '1px solid var(--line-2)' },
    bare:    { background: 'transparent', color: 'var(--ink-2)', border: '1px solid transparent' },
    dark:    { background: 'var(--ink)', color: '#fff', border: '1px solid transparent' },
  };
  const [hover, setHover] = useState(false);
  const disabled = rest.disabled;
  return (
    <button
      {...rest}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        ...sizes[size], ...variants[variant],
        fontFamily: 'var(--font-ui)', fontWeight: 600, borderRadius: 'var(--r-pill)',
        cursor: disabled ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap',
        opacity: disabled ? 0.45 : 1,
        transform: hover && !disabled ? 'translateY(-1px)' : 'none',
        transition: 'transform .14s ease, background .14s ease, box-shadow .14s ease',
        ...style,
      }}
    >
      {icon && <Icon name={icon} size={size === 'lg' ? 18 : 16} />}
      {children}
      {iconR && <Icon name={iconR} size={size === 'lg' ? 18 : 16} />}
    </button>
  );
}

/* ---------- Verdict chip (supported / unsupported / partial) ---------- */
const VERDICT = {
  supported:   { c: 'var(--pass)', ink: 'var(--pass-ink)', bg: 'var(--pass-soft)', ln: 'var(--pass-line)', icon: 'check', label: 'supported' },
  unsupported: { c: 'var(--fail)', ink: 'var(--fail-ink)', bg: 'var(--fail-soft)', ln: 'var(--fail-line)', icon: 'x', label: 'unsupported' },
  partial:     { c: 'var(--partial)', ink: 'var(--partial-ink)', bg: 'var(--partial-soft)', ln: 'var(--partial-line)', icon: 'minus', label: 'partial' },
};
function VerdictChip({ verdict, size = 'md' }) {
  const v = VERDICT[verdict];
  const sm = size === 'sm';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: sm ? 4 : 5,
      padding: sm ? '2px 7px 2px 5px' : '3px 9px 3px 6px', borderRadius: 'var(--r-pill)',
      background: v.bg, border: `1px solid ${v.ln}`, color: v.ink,
      fontSize: sm ? 11 : 12, fontWeight: 600, fontFamily: 'var(--font-mono)',
      letterSpacing: '.01em', whiteSpace: 'nowrap',
    }}>
      <Icon name={v.icon} size={sm ? 11 : 13} color={v.c} stroke={2.4} />
      {v.label}
    </span>
  );
}

/* PASS / FAIL verdict pill (judge decision & intent) */
function Decision({ kind, label }) {
  // kind: 'pass' | 'fail'
  const pass = kind === 'pass';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '3px 10px', borderRadius: 'var(--r-pill)', fontFamily: 'var(--font-mono)',
      fontSize: 11.5, fontWeight: 700, letterSpacing: '.04em',
      background: pass ? 'var(--pass-soft)' : 'var(--fail-soft)',
      border: `1px solid ${pass ? 'var(--pass-line)' : 'var(--fail-line)'}`,
      color: pass ? 'var(--pass-ink)' : 'var(--fail-ink)',
    }}>
      {label || (pass ? 'PASS' : 'FAIL')}
    </span>
  );
}

/* ---------- Score ring (faithfulness) ---------- */
function ScoreRing({ score, size = 88, threshold = 0.85, animate = true }) {
  const [v, setV] = useState(animate ? 0 : score);
  useEffect(() => {
    if (!animate) { setV(score); return; }
    let raf, start;
    const dur = 720;
    const tick = (t) => {
      if (start == null) start = t;
      const p = Math.min(1, (t - start) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      setV(score * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [score, animate]);
  const r = (size - 12) / 2;
  const circ = 2 * Math.PI * r;
  const pass = score >= threshold;
  const col = score === null ? 'var(--ink-4)' : pass ? 'var(--pass)' : score >= 0.5 ? 'var(--partial)' : 'var(--fail)';
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="var(--surface-3)" strokeWidth="8" />
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={col} strokeWidth="8"
          strokeLinecap="round" strokeDasharray={circ}
          strokeDashoffset={circ * (1 - v)} style={{ transition: 'stroke .3s' }} />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center' }}>
        <span className="mono" style={{ fontSize: size * 0.26, fontWeight: 600, color: 'var(--ink)', lineHeight: 1 }}>
          {Math.round(v * 100)}<span style={{ fontSize: size * 0.13, color: 'var(--ink-3)' }}>%</span>
        </span>
      </div>
    </div>
  );
}

/* ---------- Retrieved chunk card ---------- */
function ChunkCard({ chunk, dim }) {
  return (
    <div style={{
      border: '1px solid var(--line)', borderRadius: 'var(--r-sm)', padding: '9px 11px',
      background: dim ? 'var(--surface-2)' : 'var(--surface)', opacity: dim ? 0.7 : 1,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5, gap: 8 }}>
        <span className="mono" style={{ fontSize: 10.5, letterSpacing: '.08em', textTransform: 'uppercase',
          color: 'var(--accent)', fontWeight: 600 }}>{chunk.section}</span>
        <span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>sim {chunk.sim.toFixed(2)}</span>
      </div>
      <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--ink-2)' }}>{chunk.text}</div>
    </div>
  );
}

/* ---------- Stage rail (the six-stage eval loop) ---------- */
const STAGES = [
  { key: 'data', label: 'Data', icon: 'layers' },
  { key: 'prompt', label: 'Prompt', icon: 'doc' },
  { key: 'output', label: 'Output', icon: 'spark' },
  { key: 'label', label: 'Label', icon: 'target' },
  { key: 'judge', label: 'Judge', icon: 'flask' },
  { key: 'agreement', label: 'Agreement', icon: 'scale' },
];
function StageRail({ current, reached = [], onJump, compact }) {
  const curIdx = STAGES.findIndex((s) => s.key === current);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: compact ? 1 : 3 }}>
      {STAGES.map((s, i) => {
        const isCur = s.key === current;
        const isPast = reached.includes(s.key) && i < curIdx;
        const isReached = reached.includes(s.key);
        const clickable = isReached && onJump;
        return (
          <React.Fragment key={s.key}>
            <button
              onClick={clickable ? () => onJump(s.key) : undefined}
              aria-current={isCur ? 'step' : undefined}
              title={s.label}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: compact ? '5px 9px' : '6px 12px', borderRadius: 'var(--r-pill)',
                border: `1px solid ${isCur ? 'var(--accent)' : isPast ? 'var(--accent-line)' : 'var(--line)'}`,
                background: isCur ? 'var(--accent)' : isPast ? 'var(--accent-soft)' : 'var(--surface)',
                color: isCur ? '#fff' : isReached ? 'var(--accent-ink)' : 'var(--ink-4)',
                cursor: clickable ? 'pointer' : 'default',
                fontSize: 12.5, fontWeight: 600, fontFamily: 'var(--font-ui)',
                transition: 'all .15s', whiteSpace: 'nowrap',
              }}
            >
              {isPast
                ? <Icon name="check" size={13} stroke={2.6} />
                : <Icon name={s.icon} size={13} color={isCur ? '#fff' : isReached ? 'var(--accent)' : 'var(--ink-4)'} />}
              {!compact && s.label}
            </button>
            {i < STAGES.length - 1 && (
              <span style={{ width: compact ? 8 : 14, height: 1.5, borderRadius: 2,
                background: i < curIdx ? 'var(--accent-line)' : 'var(--line-2)', flexShrink: 0 }} />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

/* ---------- Card shell ---------- */
function Card({ children, style, pad = 20, ...rest }) {
  return (
    <div {...rest} style={{ background: 'var(--surface)', border: '1px solid var(--line)',
      borderRadius: 'var(--r-lg)', boxShadow: 'var(--sh-sm)', padding: pad, ...style }}>
      {children}
    </div>
  );
}

/* ---------- Section eyebrow w/ optional step number ---------- */
function Eyebrow({ n, children, color = 'var(--ink-3)' }) {
  return (
    <div className="eyebrow" style={{ display: 'flex', alignItems: 'center', gap: 8, color }}>
      {n != null && (
        <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 17, height: 17, borderRadius: 5, background: 'var(--accent-soft)',
          color: 'var(--accent-ink)', fontSize: 10, fontWeight: 700 }}>{n}</span>
      )}
      {children}
    </div>
  );
}

Object.assign(window, {
  Icon, Gloss, Btn, VerdictChip, Decision, ScoreRing, ChunkCard,
  StageRail, STAGES, Card, Eyebrow, VERDICT,
});
