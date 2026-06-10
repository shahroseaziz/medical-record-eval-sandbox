/* ============================================================
   Open Workbench — pipeline landing + orchestrator.
   Lands on the pipeline (Concept B), expands into the three-panel
   bench (Concept A). Pre-loaded from the lesson's last state.
   ============================================================ */
(function () {
const B = window.BENCH;
const Tag = window.BenchTag;

/* ---- compute correctness results from state ---- */
function computeResults(st) {
  const out = {};
  st.caseIds.forEach((pid) => {
    const p = B.cohort.find((x) => x.id === pid);
    const judgeFields = st.schema.filter((f) => st.fieldEval[f] === 'judge');
    out[pid] = B.diff(st.expected[pid], p.truth, st.schema, judgeFields);
  });
  return out;
}
function summarize(st, results) {
  let cells = 0, bad = 0;
  st.caseIds.forEach((pid) => {
    const r = results[pid]; if (!r) return;
    r.rows.forEach((row) => st.schema.forEach((f) => { const c = row.fields[f]; if (c) { cells++; if (c.match === false) bad++; } }));
  });
  return { cells, bad, ok: cells - bad };
}

/* ---- red-cell explainer (the reproducible reference-was-wrong / diff-too-strict moment) ---- */
function CellModal({ cell, st, onClose, onMakeJudge, onRecord }) {
  if (!cell) return null;
  const p = B.cohort.find((x) => x.id === cell.pid);
  const judgeFields = st.schema.filter((f) => st.fieldEval[f] === 'judge');
  const r = B.diff(st.expected[cell.pid], p.truth, st.schema, judgeFields);
  const bad = r.rows.map((row) => ({ name: row.name, c: row.fields[cell.field] })).filter((x) => x.c && x.c.match === false);
  // is this a semantic-equivalence case (freq) or a genuine value error (dose)?
  const semantic = cell.field === 'freq';
  return ReactDOM.createPortal(
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 320, background: 'rgba(29,26,43,.42)', backdropFilter: 'blur(3px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 22, animation: 'fadeIn .2s both' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 'min(560px,96vw)', background: 'var(--surface)', borderRadius: 'var(--r-xl)',
        boxShadow: 'var(--sh-lg)', overflow: 'hidden', animation: 'fadeUp .25s both' }}>
        <div style={{ padding: '8px 18px', background: 'var(--spot)', color: '#fff', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon name="info" size={15} color="#fff" />
          <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', letterSpacing: '.06em', textTransform: 'uppercase', fontWeight: 600 }}>
            {p.name} · {cell.field} flagged</span>
          <button onClick={onClose} style={{ marginLeft: 'auto', cursor: 'pointer', background: 'transparent', border: 'none', color: '#fff' }}><Icon name="x" size={16} /></button>
        </div>
        <div style={{ padding: '20px 22px' }}>
          <h3 style={{ fontSize: 18 }}>The diff says these don't match. Do they actually disagree?</h3>
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {bad.map((x, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <div style={{ border: '1px solid var(--accent-line)', borderRadius: 'var(--r-sm)', padding: '9px 11px', background: 'var(--accent-soft)' }}>
                  <Tag accent>your key · {x.name}</Tag>
                  <div className="mono" style={{ fontSize: 13, color: 'var(--ink)', marginTop: 4 }}>{x.c.e}</div>
                </div>
                <div style={{ border: '1px solid var(--line)', borderRadius: 'var(--r-sm)', padding: '9px 11px', background: 'var(--surface-2)' }}>
                  <Tag>model returned</Tag>
                  <div className="mono" style={{ fontSize: 13, color: 'var(--ink)', marginTop: 4 }}>{x.c.a}</div>
                </div>
              </div>
            ))}
          </div>
          <p style={{ fontSize: 13.5, color: 'var(--ink-2)', marginTop: 16, lineHeight: 1.55 }}>
            {semantic
              ? <>These mean the <strong>same thing</strong> — “twice daily” and “BID” are identical clinically. The model isn't wrong and neither
                is your key; the <strong>diff is too literal</strong> for this field. This is exactly when you reach for a judge that reads meaning.</>
              : <>Check the record to settle it: if the model matches the source, <strong>your reference was wrong</strong> and a diff would have failed a
                correct answer. The evaluator is only as good as the key behind it.</>}
          </p>
          <div style={{ display: 'flex', gap: 10, marginTop: 18, flexWrap: 'wrap' }}>
            {semantic
              ? <Btn size="md" icon="flask" onClick={() => { onMakeJudge(cell.field); onClose(); }}>Make “{cell.field}” a judge → re-grade</Btn>
              : <Btn size="md" icon="layers" onClick={() => { onRecord(p); onClose(); }}>Open the record</Btn>}
            <Btn variant="ghost" size="md" onClick={() => { onRecord(p); onClose(); }}>Inspect the source</Btn>
          </div>
        </div>
      </div>
    </div>, document.body);
}

/* ---------------- PIPELINE landing (Concept B) ---------------- */
function Pipeline({ st, results, onExpand, onRecord }) {
  const sum = summarize(st, results);
  const nodes = [
    { n: 1, t: 'Prompt', icon: 'doc', d: 'Meds → JSON {name, dose, freq}', tag: 'from your lesson' },
    { n: 2, t: 'Cases', icon: 'target', d: `${st.caseIds.length} patients · A1c > 8`, tag: 'golden set' },
    { n: 3, t: 'Evaluator', icon: 'flask', d: st.mode === 'faithfulness' ? 'faithfulness judge' : 'per-field: diff · diff · diff', tag: 'your scorer', accent: true },
  ];
  return (
    <div style={{ maxWidth: 1000, margin: '0 auto', padding: '40px 24px 60px', animation: 'fadeUp .35s both' }}>
      <div style={{ textAlign: 'center', maxWidth: 620, margin: '0 auto' }}>
        <Tag accent>the open workbench</Tag>
        <h1 style={{ fontSize: 'clamp(26px,3.6vw,38px)', marginTop: 10, lineHeight: 1.08 }}>Your eval, as three knobs you control.</h1>
        <p style={{ fontSize: 15, color: 'var(--ink-2)', marginTop: 12 }}>
          Everything you just built in the lesson is loaded and already running. Nothing's blank — change any atom and re-grade.
          This is the whole machine, open.
        </p>
      </div>

      <div style={{ display: 'flex', alignItems: 'stretch', gap: 0, marginTop: 30, flexWrap: 'wrap', justifyContent: 'center' }}>
        {nodes.map((nd, i) => (
          <React.Fragment key={nd.n}>
            <button onClick={onExpand} style={{ cursor: 'pointer', flex: '1 1 200px', minWidth: 180, textAlign: 'left',
              border: `1.5px solid ${nd.accent ? 'var(--accent)' : 'var(--line-2)'}`, borderRadius: 'var(--r-lg)',
              background: nd.accent ? 'var(--accent-soft)' : 'var(--surface)', padding: '15px 16px', boxShadow: 'var(--sh-sm)', fontFamily: 'var(--font-ui)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 9 }}>
                <span style={{ width: 26, height: 26, borderRadius: 7, background: nd.accent ? 'var(--accent)' : 'var(--surface-3)',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><Icon name={nd.icon} size={13} color={nd.accent ? '#fff' : 'var(--ink-3)'} /></span>
                <Tag>atom {nd.n}</Tag>
              </div>
              <div style={{ fontSize: 15, fontWeight: 700, color: nd.accent ? 'var(--accent-ink)' : 'var(--ink)' }}>{nd.t}</div>
              <div style={{ fontSize: 11.5, color: 'var(--ink-3)', marginTop: 3, lineHeight: 1.4 }}>{nd.d}</div>
              <span style={{ display: 'inline-block', marginTop: 10, fontSize: 9.5, fontFamily: 'var(--font-mono)',
                color: nd.accent ? 'var(--accent-ink)' : 'var(--ink-3)', background: nd.accent ? 'var(--surface)' : 'var(--surface-2)',
                border: `1px solid ${nd.accent ? 'var(--accent-line)' : 'var(--line)'}`, borderRadius: 'var(--r-pill)', padding: '2px 9px' }}>{nd.tag}</span>
            </button>
            <div style={{ display: 'flex', alignItems: 'center', padding: '0 6px' }}><Icon name="arrow" size={18} color="var(--ink-4)" /></div>
          </React.Fragment>
        ))}
        <div style={{ flexBasis: 116, border: '1.5px solid var(--pass-line)', borderRadius: 'var(--r-lg)', background: 'var(--pass-soft)',
          padding: '15px 14px', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}>
          <span className="mono" style={{ fontSize: 24, fontWeight: 600, color: 'var(--pass-ink)' }}>{sum.ok}/{sum.cells}</span>
          <span style={{ fontSize: 10, color: 'var(--ink-3)', textAlign: 'center' }}>cells match</span>
        </div>
      </div>

      <div style={{ textAlign: 'center', marginTop: 30 }}>
        <Btn size="lg" iconR="arrow" onClick={onExpand}>Open the bench</Btn>
        <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 10 }}>or click any atom above to jump straight to it</div>
      </div>
    </div>
  );
}

/* ---------------- PANELS bench (Concept A) ---------------- */
function Panels({ st, set, results, onCollapse, onRecord, onCell }) {
  const sum = summarize(st, results);
  return (
    <div style={{ maxWidth: 1160, margin: '0 auto', padding: '20px 24px 70px', animation: 'fadeUp .3s both' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <button onClick={onCollapse} style={{ cursor: 'pointer', fontSize: 12, fontWeight: 600, color: 'var(--ink-2)', background: 'var(--surface)',
          border: '1px solid var(--line-2)', borderRadius: 'var(--r-pill)', padding: '6px 12px', fontFamily: 'var(--font-ui)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Icon name="layers" size={13} /> Pipeline view</button>
        <h2 style={{ fontSize: 18 }}>The bench</h2>
        <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>change a knob → re-grade. no rails.</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 14, alignItems: 'start' }}>
        {/* atom 1 — prompt */}
        <Card pad={0} style={{ overflow: 'hidden' }}>
          <div style={{ padding: '11px 14px', background: 'var(--surface-2)', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 22, height: 22, borderRadius: 6, background: 'var(--accent-soft)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="doc" size={12} color="var(--accent)" /></span>
            <Tag accent>atom 1 · prompt</Tag>
          </div>
          <div style={{ padding: 13 }}>
            <textarea value={st.prompt} onChange={(e) => set((s) => ({ ...s, prompt: e.target.value, ran: false }))} rows={5} spellCheck={false}
              style={{ width: '100%', resize: 'vertical', fontFamily: 'var(--font-mono)', fontSize: 11.5, lineHeight: 1.55, color: 'var(--ink)',
                padding: '10px 12px', borderRadius: 'var(--r-sm)', border: '1.5px solid var(--line-2)', background: 'var(--surface-2)', outline: 'none' }} />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 9 }}>
              {B.promptPresets.filter((pr) => pr.forMode === st.mode).map((pr) => (
                <button key={pr.id} onClick={() => set((s) => ({ ...s, prompt: pr.text, promptId: pr.id, ran: false }))}
                  style={{ cursor: 'pointer', fontSize: 10.5, fontFamily: 'var(--font-ui)', fontWeight: 600, padding: '4px 9px', borderRadius: 'var(--r-pill)',
                    border: `1px solid ${st.promptId === pr.id ? 'var(--accent)' : 'var(--line-2)'}`, background: st.promptId === pr.id ? 'var(--accent-soft)' : 'var(--surface)',
                    color: st.promptId === pr.id ? 'var(--accent-ink)' : 'var(--ink-2)' }}>{pr.label}</button>
              ))}
            </div>
          </div>
        </Card>

        {/* atom 2 — cases */}
        <Card pad={0} style={{ overflow: 'hidden' }}>
          <div style={{ padding: '11px 14px', background: 'var(--surface-2)', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 22, height: 22, borderRadius: 6, background: 'var(--accent-soft)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="target" size={12} color="var(--accent)" /></span>
            <Tag accent>atom 2 · cases</Tag>
            <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--ink-4)' }}>{st.caseIds.length} selected</span>
          </div>
          <div style={{ padding: 11, display: 'flex', flexDirection: 'column', gap: 7 }}>
            {B.A2.patients.map((p) => {
              const on = st.caseIds.includes(p.id);
              const dq = !p.qualifies;
              return (
                <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 9px', borderRadius: 'var(--r-sm)',
                  background: on ? 'var(--surface)' : 'var(--surface-2)', border: `1px solid ${on ? 'var(--accent-line)' : 'var(--line)'}`, opacity: dq ? 0.5 : 1 }}>
                  <button onClick={() => !dq && set((s) => ({ ...s, caseIds: on ? s.caseIds.filter((x) => x !== p.id) : [...s.caseIds, p.id], ran: false }))}
                    disabled={dq} style={{ cursor: dq ? 'not-allowed' : 'pointer', width: 17, height: 17, borderRadius: 5, flexShrink: 0,
                      border: `1.5px solid ${on ? 'var(--accent)' : 'var(--line-2)'}`, background: on ? 'var(--accent)' : 'transparent',
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{on && <Icon name="check" size={11} color="#fff" stroke={3} />}</button>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)' }}>{p.name}</span>
                    <span className="mono" style={{ fontSize: 10.5, color: dq ? 'var(--ink-4)' : 'var(--fail-ink)', marginLeft: 6 }}>A1c {p.a1c}{dq ? ' · excluded' : ''}</span>
                  </span>
                  <button onClick={() => onRecord(p)} title="record" style={{ cursor: 'pointer', width: 22, height: 22, borderRadius: 5, border: '1px solid var(--line-2)',
                    background: 'var(--surface)', color: 'var(--ink-3)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="layers" size={11} /></button>
                </div>
              );
            })}
          </div>
        </Card>

        {/* atom 3 — evaluator */}
        <Card pad={0} style={{ overflow: 'hidden' }}>
          <div style={{ padding: '11px 14px', background: st.mode === 'faithfulness' ? 'var(--spot-soft)' : 'var(--accent-soft)', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 22, height: 22, borderRadius: 6, background: st.mode === 'faithfulness' ? 'var(--spot)' : 'var(--accent)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="flask" size={12} color="#fff" /></span>
            <Tag accent>atom 3 · evaluator</Tag>
          </div>
          <div style={{ padding: 13 }}>
            <EvaluatorPanel st={st} set={set} onModeChange={(m) => set((s) => ({ ...s,
              mode: m,
              promptId: m === 'faithfulness' ? 'allergies' : 'meds-json',
              prompt: m === 'faithfulness' ? B.promptPresets.find((x) => x.id === 'allergies').text : B.A2.DEFAULT_GEN_PROMPT,
              ran: false }))} />
          </div>
        </Card>
      </div>

      {/* results — Concept C inner view, reshapes with mode */}
      <div style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
          <Tag accent>results</Tag>
          {st.mode === 'correctness'
            ? <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>
                <strong style={{ color: sum.bad ? 'var(--fail-ink)' : 'var(--pass-ink)' }}>{sum.ok}/{sum.cells}</strong> cells match ·
                <span style={{ color: 'var(--pass-ink)', marginLeft: 5 }}>{Object.values(st.fieldEval).filter((x) => x === 'diff').length} diff fields free</span>
                {Object.values(st.fieldEval).includes('judge') && <span style={{ color: 'var(--accent-ink)', marginLeft: 5 }}>· {Object.values(st.fieldEval).filter((x) => x === 'judge').length} judged · ~tokens</span>}
              </span>
            : <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>faithfulness · grounding + agreement</span>}
          <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--ink-4)' }}>{st.mode === 'correctness' ? 'red cell = the diff flagged a difference — click it' : 'flagged = a claim the record doesn\'t support'}</span>
        </div>
        {st.mode === 'correctness'
          ? <CorrectnessGrid st={st} results={results} onCell={onCell} onRecord={onRecord} />
          : <FaithfulnessView st={st} onRecord={onRecord} />}
      </div>
    </div>
  );
}

/* ---------------- Orchestrator ---------------- */
function Bench() {
  const [st, setSt] = useState(() => B.initialState());
  const [view, setView] = useState('pipeline');
  const [recordP, setRecordP] = useState(null);
  const [cell, setCell] = useState(null);
  const results = computeResults(st);

  return (
    <div style={{ minHeight: '100vh' }}>
      {/* top bar */}
      <header style={{ position: 'sticky', top: 0, zIndex: 50, background: 'rgba(247,246,250,.85)', backdropFilter: 'saturate(180%) blur(12px)', borderBottom: '1px solid var(--line)' }}>
        <div style={{ maxWidth: 1160, margin: '0 auto', padding: '11px 24px', display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ width: 27, height: 27, borderRadius: 8, background: 'var(--accent)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', boxShadow: 'var(--sh-accent)' }}><Icon name="layers" size={15} color="#fff" /></span>
          <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15, letterSpacing: '-.02em' }}>MRES · Workbench</span>
          <span style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>synthetic · no sign-up · client-side</span>
          <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--ink-3)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--pass)' }} /> pre-loaded from your lesson</span>
        </div>
      </header>

      {view === 'pipeline'
        ? <Pipeline st={st} results={results} onExpand={() => setView('panels')} onRecord={setRecordP} />
        : <Panels st={st} set={setSt} results={results} onCollapse={() => setView('pipeline')} onRecord={setRecordP} onCell={setCell} />}

      <RecordDrawer patient={recordP} onClose={() => setRecordP(null)} />
      <CellModal cell={cell} st={st} onClose={() => setCell(null)}
        onMakeJudge={(f) => setSt((s) => ({ ...s, fieldEval: { ...s.fieldEval, [f]: 'judge' } }))}
        onRecord={setRecordP} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<Bench />);
})();
