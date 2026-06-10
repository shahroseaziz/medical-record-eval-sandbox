/* ============================================================
   Open Workbench — panels, evaluator palette, results grid,
   record inspector. The three-panel "daily driver" + Concept-C
   grid as its inner results view.
   ============================================================ */
(function () {
const B = window.BENCH;

/* small atom-label */
function Tag({ children, accent }) {
  return <span style={{ fontSize: 9.5, fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '.06em',
    color: accent ? 'var(--accent)' : 'var(--ink-4)' }}>{children}</span>;
}

/* ---------------- Record inspector (carries Beat 1's source affordance) ---------------- */
function RecordDrawer({ patient, onClose }) {
  if (!patient) return null;
  const rec = patient.record;
  const al = B.allergy[patient.id];
  return ReactDOM.createPortal(
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(29,26,43,.42)',
      backdropFilter: 'blur(3px)', display: 'flex', justifyContent: 'flex-end', animation: 'fadeIn .2s both' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 'min(440px,95vw)', height: '100%', overflow: 'auto',
        background: 'var(--canvas)', boxShadow: 'var(--sh-lg)', animation: 'slideIn .28s cubic-bezier(.2,.8,.2,1) both' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--line)', position: 'sticky', top: 0, background: 'var(--canvas)',
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
          <div>
            <Tag accent>the source · full record</Tag>
            <h2 style={{ fontSize: 18, marginTop: 5 }}>{patient.name}</h2>
            <div className="mono" style={{ fontSize: 11.5, color: 'var(--fail-ink)', marginTop: 2 }}>A1c {patient.a1c} · {patient.sex} · {patient.age}</div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ cursor: 'pointer', width: 30, height: 30, borderRadius: '50%',
            border: '1px solid var(--line-2)', background: 'var(--surface)', color: 'var(--ink-3)', flexShrink: 0 }}><Icon name="x" size={15} /></button>
        </div>
        <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {Object.entries(rec).map(([sec, lines]) => (
            <div key={sec}>
              <Tag>{sec}</Tag>
              <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {lines.map((l, i) => (
                  <div key={i} style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--ink-2)', lineHeight: 1.5,
                    display: 'flex', gap: 7, background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 6, padding: '7px 10px' }}>
                    <span style={{ width: 4, height: 4, borderRadius: '50%', background: 'var(--accent)', marginTop: 6, flexShrink: 0 }} />{l}</div>
                ))}
              </div>
            </div>
          ))}
          {al && (
            <div>
              <Tag>allergies</Tag>
              <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {al.record.map((l, i) => (
                  <div key={i} style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--ink-2)', lineHeight: 1.5,
                    display: 'flex', gap: 7, background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 6, padding: '7px 10px' }}>
                    <span style={{ width: 4, height: 4, borderRadius: '50%', background: 'var(--accent)', marginTop: 6, flexShrink: 0 }} />{l}</div>
                ))}
              </div>
            </div>
          )}
          <p style={{ fontSize: 11.5, color: 'var(--ink-3)', lineHeight: 1.5, marginTop: 2 }}>
            This is the ground truth every evaluator checks against. When a cell looks wrong, come here — the source settles whether
            the model or your reference is off.
          </p>
        </div>
      </div>
    </div>, document.body);
}

/* ---------------- Evaluator palette (atom 3) ---------------- */
function EvaluatorPanel({ st, set, onModeChange }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
      {B.evalTypes.map((e) => {
        const isCorr = e.id !== 'faith';
        const active = e.id === 'faith' ? st.mode === 'faithfulness'
          : st.mode === 'correctness' && Object.values(st.fieldEval).includes(e.id);
        const selectedMode = e.id === 'faith';
        return (
          <button key={e.id}
            onClick={() => { if (e.id === 'faith') onModeChange('faithfulness'); else onModeChange('correctness'); }}
            style={{ textAlign: 'left', cursor: 'pointer', padding: '11px 13px', borderRadius: 'var(--r-md)',
              background: active ? (e.id === 'faith' ? 'var(--spot-soft)' : 'var(--accent-soft)') : 'var(--surface)',
              border: `1.5px solid ${active ? (e.id === 'faith' ? 'var(--spot-line)' : 'var(--accent)') : 'var(--line)'}`, fontFamily: 'var(--font-ui)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 22, height: 22, borderRadius: 6, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                background: active ? (e.id === 'faith' ? 'var(--spot)' : 'var(--accent)') : 'var(--surface-3)' }}>
                <Icon name={e.icon} size={12} color={active ? '#fff' : 'var(--ink-3)'} /></span>
              <strong style={{ fontSize: 12.5, color: active ? (e.id === 'faith' ? 'var(--partial-ink)' : 'var(--accent-ink)') : 'var(--ink)' }}>{e.name}</strong>
              {active && <Icon name="check" size={13} color={e.id === 'faith' ? 'var(--spot)' : 'var(--accent)'} stroke={2.6} style={{ marginLeft: 'auto' }} />}
            </div>
            <div style={{ fontSize: 10.5, color: 'var(--ink-3)', marginTop: 5, lineHeight: 1.4 }}>{e.when}</div>
            <div style={{ fontSize: 9.5, fontFamily: 'var(--font-mono)', color: 'var(--ink-4)', marginTop: 3 }}>{e.cost}</div>
          </button>
        );
      })}

      {/* per-field assignment (correctness only) */}
      {st.mode === 'correctness' && (
        <div style={{ borderTop: '1px dashed var(--line-2)', paddingTop: 11, marginTop: 2 }}>
          <Tag accent>per field</Tag>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
            {st.schema.map((f) => (
              <div key={f} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="mono" style={{ fontSize: 12, color: 'var(--ink)', fontWeight: 600, minWidth: 44 }}>{f}</span>
                <div style={{ display: 'inline-flex', background: 'var(--surface-3)', borderRadius: 'var(--r-pill)', padding: 2 }}>
                  {['diff', 'judge'].map((opt) => {
                    const on = st.fieldEval[f] === opt;
                    return (
                      <button key={opt} onClick={() => set((s) => ({ ...s, fieldEval: { ...s.fieldEval, [f]: opt }, ran: false }))}
                        style={{ cursor: 'pointer', border: 'none', borderRadius: 'var(--r-pill)', padding: '4px 11px', fontSize: 11, fontWeight: 600,
                          fontFamily: 'var(--font-ui)', background: on ? 'var(--surface)' : 'transparent',
                          color: on ? (opt === 'judge' ? 'var(--accent-ink)' : 'var(--pass-ink)') : 'var(--ink-4)', boxShadow: on ? 'var(--sh-sm)' : 'none' }}>
                        {opt}
                      </button>
                    );
                  })}
                </div>
                {st.fieldEval[f] === 'judge' && <span style={{ fontSize: 9.5, fontFamily: 'var(--font-mono)', color: 'var(--accent)' }}>~tokens</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- Correctness results grid (Concept C) ---------------- */
function CorrectnessGrid({ st, results, onCell, onRecord }) {
  const fields = st.schema;
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 'var(--r-md)', overflow: 'hidden', background: 'var(--surface)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: `1.3fr ${fields.map(() => '78px').join(' ')} 38px`, gap: 0,
        padding: '9px 14px', borderBottom: '1px solid var(--line)', background: 'var(--surface-2)' }}>
        <Tag>patient</Tag>
        {fields.map((f) => <span key={f} style={{ textAlign: 'center' }}><Tag>{f}</Tag></span>)}
        <span></span>
      </div>
      {st.caseIds.map((pid) => {
        const p = B.cohort.find((x) => x.id === pid);
        const r = results?.[pid];
        return (
          <div key={pid} style={{ display: 'grid', gridTemplateColumns: `1.3fr ${fields.map(() => '78px').join(' ')} 38px`, gap: 0,
            alignItems: 'center', padding: '11px 14px', borderBottom: '1px solid var(--line)' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <span style={{ width: 26, height: 26, borderRadius: 7, background: 'var(--accent-soft)', color: 'var(--accent-ink)', flexShrink: 0,
                fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{p.initials}</span>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</span>
            </span>
            {fields.map((f) => {
              if (!r) return <span key={f} style={{ textAlign: 'center' }}><span className="mono" style={{ fontSize: 11, color: 'var(--ink-4)' }}>·</span></span>;
              return <CellView key={f} pid={pid} field={f} result={r} onCell={onCell} />;
            })}
            <button onClick={() => onRecord(p)} title="View record" style={{ cursor: 'pointer', justifySelf: 'center', width: 26, height: 26, borderRadius: 6,
              border: '1px solid var(--line-2)', background: 'var(--surface)', color: 'var(--ink-3)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="layers" size={13} /></button>
          </div>
        );
      })}
    </div>
  );
}

/* single field cell across all meds for a patient: green if all match, red if any mismatch */
function CellView({ pid, field, result, onCell }) {
  const cells = result.rows.map((row) => row.fields[field]).filter(Boolean);
  const anyBad = cells.some((c) => c.match === false);
  const judged = cells.some((c) => c.judged);
  return (
    <span style={{ textAlign: 'center' }}>
      <button onClick={() => anyBad && onCell({ pid, field })}
        style={{ cursor: anyBad ? 'pointer' : 'default', border: 'none', background: 'transparent', padding: 0,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 3 }}>
        {anyBad
          ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10.5, fontFamily: 'var(--font-mono)', fontWeight: 600,
              color: 'var(--fail-ink)', background: 'var(--fail-soft)', border: '1px solid var(--fail-line)', borderRadius: 'var(--r-pill)', padding: '3px 8px' }}>
              <Icon name="x" size={10} color="var(--fail)" stroke={2.6} /> diff</span>
          : <Icon name={judged ? 'flask' : 'check'} size={14} color={judged ? 'var(--accent)' : 'var(--pass)'} stroke={2.4} />}
      </button>
    </span>
  );
}

/* ---------------- Faithfulness results (reshaped surface) ---------------- */
function FaithfulnessView({ st, onRecord }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '10px 13px', borderRadius: 'var(--r-md)',
        background: 'var(--spot-soft)', border: '1px solid var(--spot-line)' }}>
        <Icon name="info" size={15} color="var(--spot)" />
        <span style={{ fontSize: 12, color: 'var(--ink-2)', lineHeight: 1.45 }}>
          Surface changed: <strong>no expected-answer column</strong> — there's nothing to write down. The judge checks each claim
          against the record (grounding), and you read <strong>agreement</strong>.
        </span>
      </div>
      {st.caseIds.map((pid) => {
        const a = B.allergy[pid];
        const score = B.faithScore(pid);
        const grounded = score === 1;
        return (
          <div key={pid} style={{ border: `1px solid ${grounded ? 'var(--line)' : 'var(--spot-line)'}`, borderRadius: 'var(--r-md)',
            overflow: 'hidden', background: grounded ? 'var(--surface)' : 'var(--spot-soft)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 13px', borderBottom: '1px solid var(--line)' }}>
              <span style={{ width: 26, height: 26, borderRadius: 7, background: 'var(--accent-soft)', color: 'var(--accent-ink)', flexShrink: 0,
                fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                {B.cohort.find((x) => x.id === pid).initials}</span>
              <span style={{ flex: 1, fontSize: 12.5, fontWeight: 600, color: 'var(--ink)' }}>{B.cohort.find((x) => x.id === pid).name}</span>
              <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: grounded ? 'var(--pass-ink)' : 'var(--fail-ink)' }}>{Math.round(score * 100)}%</span>
              {grounded ? <Decision kind="pass" label="grounded" />
                : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 600,
                    color: 'var(--fail-ink)', background: 'var(--fail-soft)', border: '1px solid var(--fail-line)', borderRadius: 'var(--r-pill)', padding: '3px 9px' }}>
                    <Icon name="x" size={10} color="var(--fail)" stroke={2.6} /> hallucination</span>}
              <button onClick={() => onRecord(B.cohort.find((x) => x.id === pid))} title="View record"
                style={{ cursor: 'pointer', width: 24, height: 24, borderRadius: 6, border: '1px solid var(--line-2)', background: 'var(--surface)',
                  color: 'var(--ink-3)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="layers" size={12} /></button>
            </div>
            <div style={{ padding: '10px 13px' }}>
              <div style={{ fontSize: 12, color: 'var(--ink-2)', fontStyle: 'italic', marginBottom: 8 }}>“{a.answer}”</div>
              {a.claims.map((c, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 5 }}>
                  <VerdictChip verdict={c.grounded ? 'supported' : 'unsupported'} size="sm" />
                  <span style={{ fontSize: 11.5, color: 'var(--ink-2)', lineHeight: 1.4 }}><strong>{c.t}</strong> — {c.why}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

Object.assign(window, { BenchTag: Tag, RecordDrawer, EvaluatorPanel, CorrectnessGrid, CellView, FaithfulnessView });
})();
