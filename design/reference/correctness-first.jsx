/* ============================================================
   Correctness-first guided lesson.
   Beat 1 — Correctness with a diff (structured; reference-was-wrong)
   Beat 2 — Two contrasting queries: diff can't grade prose → judge
   Beat 3 — Faithfulness capstone: no expected answer; judge checks
            grounding, and the judge itself can be wrong.
   Atoms always read: prompt → cases → evaluator.
   ============================================================ */
const A2 = window.ACT2;

/* ---------- prose-task data (Beat 2) ---------- */
const PROSE_QUERY = 'Write a one-sentence summary of whether each patient\'s diabetes is controlled.';
const PROSE_EXPECTED = 'Their diabetes is not well controlled — the latest A1c is above target.';
const PROSE_ROWS = [
  { id: 'p-benally', name: 'Marcus Benally', a1c: 8.4,
    actual: 'Diabetes remains uncontrolled; the most recent A1c of 8.4% sits above goal.',
    judge: 'match', why: 'Same meaning as your reference — “uncontrolled, above goal” = “not controlled, above target.”' },
  { id: 'p-crisostomo', name: 'Yolanda Crisostomo', a1c: 9.1,
    actual: 'Poorly controlled diabetes, with an A1c of 9.1% well above target.',
    judge: 'match', why: 'Same meaning — different words, identical clinical claim.' },
  { id: 'p-okafor', name: 'Dwight Okafor', a1c: 8.2,
    actual: 'Diabetes is improving and nearly at goal, with an A1c of 8.2%.',
    judge: 'mismatch', why: '“Nearly at goal” contradicts your reference — 8.2% is still above target. The prose editorializes. A judge catches this; a string match never could.' },
];

function Stepper({ beat }) {
  const stops = [['1', 'Match', 'diff'], ['2', 'Meaning', 'judge'], ['3', 'Grounding', 'faithfulness']];
  return (
    <header style={{ position: 'sticky', top: 0, zIndex: 45, background: 'rgba(247,246,250,.85)',
      backdropFilter: 'saturate(180%) blur(12px)', borderBottom: '1px solid var(--line)' }}>
      <div style={{ maxWidth: 920, margin: '0 auto', padding: '11px 24px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexShrink: 0 }}>
          <span style={{ width: 26, height: 26, borderRadius: 8, background: 'var(--accent)', display: 'inline-flex',
            alignItems: 'center', justifyContent: 'center', boxShadow: 'var(--sh-accent)' }}><Icon name="scale" size={14} color="#fff" /></span>
          <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 14.5, letterSpacing: '-.02em' }}>MRES · learn evals</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 3, marginLeft: 4 }}>
          {stops.map(([n, t, sub], i) => {
            const cur = i + 1 === beat, past = i + 1 < beat;
            return (
              <React.Fragment key={n}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '5px 11px', borderRadius: 'var(--r-pill)',
                  background: cur ? 'var(--accent-soft)' : 'transparent', border: `1px solid ${cur ? 'var(--accent-line)' : 'transparent'}` }}>
                  <span style={{ width: 17, height: 17, borderRadius: '50%', flexShrink: 0, fontSize: 9.5, fontWeight: 700, fontFamily: 'var(--font-mono)',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    background: cur ? 'var(--accent)' : past ? 'var(--pass-soft)' : 'var(--surface-3)',
                    border: past ? '1px solid var(--pass-line)' : 'none', color: cur ? '#fff' : past ? 'var(--pass)' : 'var(--ink-4)' }}>
                    {past ? <Icon name="check" size={10} color="var(--pass)" stroke={2.8} /> : n}
                  </span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: cur ? 'var(--accent-ink)' : past ? 'var(--ink-2)' : 'var(--ink-4)' }}>{t}</span>
                </span>
                {i < stops.length - 1 && <Icon name="arrow" size={12} color="var(--line-2)" />}
              </React.Fragment>
            );
          })}
        </div>
      </div>
    </header>
  );
}

function AtomTag({ children }) {
  return <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--ink-4)', textTransform: 'uppercase', letterSpacing: '.06em' }}>{children}</span>;
}

/* ---------- Beat-1 authoring scaffolding ---------- */
const GEN_PROMPT =
  'You are a clinical data extractor. For each patient, read their record and return\n' +
  'their ACTIVE medications as JSON: [{ "name": string, "dose": string }].\n' +
  'Use ONLY the record. Omit any discontinued medication.';

// Short clinical summaries the user authors FROM (not the full record).
// Benally's summary deliberately omits the metformin dose — so assuming the
// common 500 mg starting dose is a natural, user-owned mistake.
const SUMMARIES = {
  'p-benally': '58 M · Type 2 diabetes + hypertension. On metformin, empagliflozin (10 mg daily, since 2024), and lisinopril (10 mg daily). Latest A1c 8.4% — above target.',
  'p-crisostomo': '64 F · uncontrolled T2D. On insulin glargine (22 units nightly) and metformin 1000 mg twice daily. A1c 9.1%.',
  'p-okafor': '51 M · T2D + high cholesterol. On metformin 500 mg twice daily, sitagliptin (100 mg daily), and atorvastatin (40 mg nightly). A1c 8.2%.',
};
// which expected dose fields are an assumption the summary didn't state
const ASSUMED = { 'p-benally': { Metformin: true } };

function PromptAtom() {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 16, border: '1px solid var(--line)', borderRadius: 'var(--r-md)', overflow: 'hidden', background: 'var(--surface)' }}>
      <button onClick={() => setOpen((o) => !o)} style={{ width: '100%', cursor: 'pointer', background: 'var(--surface-2)', border: 'none',
        display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', fontFamily: 'var(--font-ui)', textAlign: 'left' }}>
        <span style={{ width: 22, height: 22, borderRadius: 6, background: 'var(--accent-soft)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <Icon name="doc" size={12} color="var(--accent)" /></span>
        <AtomTag>atom 1 · prompt</AtomTag>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>The generation prompt we're running against the records</span>
        <Icon name="chevron" size={15} color="var(--ink-4)" style={{ marginLeft: 'auto', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }} />
      </button>
      {open && (
        <div style={{ padding: '12px 14px', animation: 'fadeUp .2s both' }}>
          <pre style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.6, color: 'var(--ink-2)', whiteSpace: 'pre-wrap',
            background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 'var(--r-sm)', padding: '11px 13px' }}>{GEN_PROMPT}</pre>
          <p style={{ fontSize: 11.5, color: 'var(--ink-3)', marginTop: 8, lineHeight: 1.5 }}>
            This is the literal instruction sent to the model for every patient. It's an atom you can read and change — the eval
            measures <em>this prompt</em>, so making it visible is the whole point.
          </p>
        </div>
      )}
    </div>
  );
}

/* =================== BEAT 1 — correctness with a diff =================== */
function Beat1({ onDone }) {
  const cohort = A2.patients.filter((p) => p.qualifies);
  const fields = ['name', 'dose'];
  // phase: 'author' (commit your key) → 'run' (diff + reveal)
  const [phase, setPhase] = useState('author');
  const [expected, setExpected] = useState(() => Object.fromEntries(cohort.map((p) => [p.id, p.seedExpected.map((m) => ({ name: m.name, dose: m.dose }))])));
  const [results, setResults] = useState({});
  const [ran, setRan] = useState(false);
  const [openP, setOpenP] = useState(null);
  const [showRec, setShowRec] = useState(false);
  const [fixed, setFixed] = useState(false);
  const [lookedAt, setLookedAt] = useState({}); // patient ids whose record the user opened while authoring
  const [openRec, setOpenRec] = useState({});   // which authoring cards have the record expanded

  function commit() {
    setPhase('run');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function run() {
    const out = {}; cohort.forEach((p) => { out[p.id] = A2.diff(expected[p.id], p.truth, fields, []); });
    setResults(out); setRan(true);
    const bad = cohort.find((p) => !out[p.id].perfect); if (bad) setOpenP(bad.id);
  }
  function fixRef() {
    const p = cohort.find((x) => x.id === 'p-benally');
    const ne = { ...expected, [p.id]: p.truth.map((m) => ({ name: m.name, dose: m.dose })) };
    setExpected(ne); setFixed(true);
    const out = {}; cohort.forEach((q) => { out[q.id] = A2.diff(ne[q.id], q.truth, fields, []); }); setResults(out);
  }
  const perfect = ran && cohort.every((p) => results[p.id]?.perfect);

  /* ---------- AUTHORING PHASE ---------- */
  if (phase === 'author') {
    return (
      <div style={{ animation: 'fadeUp .3s both' }}>
        <Eyebrow color="var(--accent)">Beat 1 · correctness — write the answer key first</Eyebrow>
        <h1 style={{ fontSize: 'clamp(23px,3vw,32px)', marginTop: 10, maxWidth: 660 }}>
          Before you can grade an answer, you have to decide what the right one is.
        </h1>
        <p style={{ fontSize: 15, color: 'var(--ink-2)', marginTop: 12, maxWidth: 660 }}>
          Task: <strong>return each A1c-over-8 patient's active meds as JSON</strong> <span className="mono" style={{ fontSize: 12.5 }}>{'{ name, dose }'}</span>.
          An eval needs <em>your</em> expected answer to compare against — so author it now. Each patient shows a quick{' '}
          <strong>summary</strong>; the full record from the database is one click away if you want to check it. We've drafted a
          key from the summaries — review it, verify against the source where you like, and commit it as your{' '}
          <Gloss term="answer key" plain="Your hand-authored expected outputs — the reference the eval compares the model against."
          real="The golden set for a correctness eval. It's only as trustworthy as the person who wrote it.">answer key</Gloss>.
        </p>

        <PromptAtom />

        <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 11.5, color: 'var(--ink-3)', display: 'inline-flex', alignItems: 'center', gap: 6 }}><AtomTag>cases</AtomTag> {cohort.length} patients · A1c &gt; 8</span>
          <span style={{ color: 'var(--line-2)' }}>·</span>
          <span style={{ fontSize: 11.5, color: 'var(--accent-ink)', display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600 }}><AtomTag>atom 2 · cases</AtomTag> author expected outputs ↓</span>
        </div>

        <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {cohort.map((p) => (
            <Card key={p.id} pad={0} style={{ overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 11, padding: '13px 15px', background: 'var(--surface-2)', borderBottom: '1px solid var(--line)' }}>
                <span style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--accent-soft)', color: 'var(--accent-ink)', flexShrink: 0,
                  fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{p.initials}</span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>{p.name} <span className="mono" style={{ fontSize: 11.5, color: 'var(--fail-ink)', fontWeight: 400 }}>· A1c {p.a1c}</span></div>
                  <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 3, lineHeight: 1.5 }}>
                    <span className="eyebrow" style={{ fontSize: 9, color: 'var(--ink-4)' }}>summary</span>&nbsp; {SUMMARIES[p.id]}
                  </div>
                </div>
              </div>
              <div style={{ padding: '11px 15px' }}>
                <div className="eyebrow" style={{ fontSize: 9, color: 'var(--accent)', marginBottom: 9 }}>your expected meds (edit before committing)</div>
                {expected[p.id].map((m, mi) => {
                  const assumed = ASSUMED[p.id]?.[m.name];
                  return (
                    <div key={mi} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7, flexWrap: 'wrap' }}>
                      <span className="mono" style={{ fontSize: 12, color: 'var(--ink)', fontWeight: 600, minWidth: 120 }}>{m.name}</span>
                      <input value={m.dose} onChange={(e) => setExpected((c) => ({ ...c, [p.id]: c[p.id].map((x, j) => j === mi ? { ...x, dose: e.target.value } : x) }))}
                        style={{ width: 104, fontFamily: 'var(--font-mono)', fontSize: 11.5, padding: '5px 9px', borderRadius: 6,
                          border: `1.5px solid ${assumed ? 'var(--spot-line)' : 'var(--line-2)'}`, background: assumed ? 'var(--spot-soft)' : 'var(--surface-2)', color: 'var(--ink)', outline: 'none' }} />
                      {assumed && (
                        <span style={{ fontSize: 10.5, fontFamily: 'var(--font-mono)', color: 'var(--partial-ink)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                          <Icon name="info" size={12} color="var(--spot)" /> assumed — the summary didn't state this dose
                        </span>
                      )}
                    </div>
                  );
                })}

                {/* full record — the source of truth, one click away */}
                <div style={{ marginTop: 4, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
                  <button onClick={() => { setOpenRec((o) => ({ ...o, [p.id]: !o[p.id] })); setLookedAt((l) => ({ ...l, [p.id]: true })); }}
                    style={{ cursor: 'pointer', background: 'transparent', border: 'none', padding: 0, fontFamily: 'var(--font-ui)',
                      fontSize: 11.5, fontWeight: 600, color: 'var(--accent-ink)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <Icon name="layers" size={13} color="var(--accent)" />
                    {openRec[p.id] ? 'Hide the full record' : 'View the full record (the source)'}
                    {lookedAt[p.id] && !openRec[p.id] && <span style={{ fontSize: 10, color: 'var(--pass-ink)', fontWeight: 600 }}>· checked ✓</span>}
                    <Icon name="chevron" size={13} color="var(--ink-4)" style={{ transform: openRec[p.id] ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }} />
                  </button>
                  {openRec[p.id] && (
                    <div style={{ marginTop: 9, animation: 'fadeUp .2s both', display: 'flex', flexDirection: 'column', gap: 9 }}>
                      {Object.entries(p.record).map(([sec, lines]) => (
                        <div key={sec}>
                          <div className="eyebrow" style={{ fontSize: 8.5, color: 'var(--ink-4)', marginBottom: 4 }}>{sec}</div>
                          {lines.map((line, li) => {
                            const hot = /metformin/i.test(line) && ASSUMED[p.id]?.Metformin;
                            return (
                              <div key={li} style={{ fontSize: 11.5, fontFamily: 'var(--font-mono)', lineHeight: 1.5, display: 'flex', gap: 7,
                                color: hot ? 'var(--ink)' : 'var(--ink-3)', fontWeight: hot ? 600 : 400,
                                background: hot ? 'var(--pass-soft)' : 'transparent', borderRadius: 4, padding: hot ? '2px 6px' : '2px 0' }}>
                                <span style={{ width: 4, height: 4, borderRadius: '50%', background: hot ? 'var(--pass)' : 'var(--ink-4)', marginTop: 6, flexShrink: 0 }} />{line}
                              </div>
                            );
                          })}
                        </div>
                      ))}
                      {ASSUMED[p.id]?.Metformin && (
                        <div style={{ fontSize: 11, color: 'var(--accent-ink)', background: 'var(--accent-soft)', border: '1px solid var(--accent-line)',
                          borderRadius: 'var(--r-sm)', padding: '7px 10px', lineHeight: 1.45 }}>
                          The record states the Metformin dose the summary left out. Update your key to match what you find here — that's pressure-testing the reference against the source.
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 18, flexWrap: 'wrap' }}>
          <Btn size="md" icon="check" onClick={commit}>Commit this as my answer key</Btn>
          <span style={{ fontSize: 12, color: 'var(--ink-3)', maxWidth: 380, lineHeight: 1.45 }}>
            Once you commit, the model runs and a diff compares its output to <em>your</em> key.
          </span>
        </div>
      </div>
    );
  }

  /* ---------- RUN / REVEAL PHASE ---------- */
  return (
    <div style={{ animation: 'fadeUp .3s both' }}>
      <Eyebrow color="var(--accent)">Beat 1 · correctness — does it match the answer key you committed?</Eyebrow>
      <h1 style={{ fontSize: 'clamp(23px,3vw,32px)', marginTop: 10, maxWidth: 640 }}>
        Now grade the model against the key you wrote.
      </h1>
      <p style={{ fontSize: 15, color: 'var(--ink-2)', marginTop: 12, maxWidth: 640 }}>
        The eval compares the model's output to your committed answer key, field-by-field. No AI needed to grade it — just a{' '}
        <Gloss term="diff" plain="A deterministic comparison: does each field exactly match your expected value? Free, instant, identical every time."
        real="The simplest evaluator. Perfect when the right answer is structured and known.">diff</Gloss>.
      </p>

      <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <button onClick={() => setPhase('author')} style={{ cursor: 'pointer', fontSize: 11.5, color: 'var(--ink-3)', background: 'transparent',
          border: '1px solid var(--line-2)', borderRadius: 'var(--r-pill)', padding: '4px 11px', fontFamily: 'var(--font-ui)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Icon name="arrowL" size={12} /> edit answer key</button>
        <span style={{ fontSize: 11.5, color: 'var(--ink-3)', display: 'inline-flex', alignItems: 'center', gap: 6 }}><AtomTag>cases</AtomTag> {cohort.length} patients</span>
        <span style={{ color: 'var(--line-2)' }}>·</span>
        <span style={{ fontSize: 11.5, color: 'var(--accent-ink)', display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600 }}><AtomTag>evaluator</AtomTag> deterministic diff</span>
      </div>

      <Card pad={0} style={{ marginTop: 16, overflow: 'hidden' }}>
        {cohort.map((p, i) => {
          const r = results[p.id];
          const status = !ran ? 'pre' : r.perfect ? 'match' : 'mismatch';
          const mm = r && !r.perfect ? r.rows.find((x) => x.status === 'mismatch') : null;
          const badField = mm ? Object.keys(mm.fields).find((k) => mm.fields[k].match === false) : null;
          return (
            <div key={p.id} style={{ borderBottom: i < cohort.length - 1 ? '1px solid var(--line)' : 'none',
              background: status === 'mismatch' ? 'var(--spot-soft)' : 'var(--surface)' }}>
              <button onClick={() => setOpenP(openP === p.id ? null : p.id)} style={{ width: '100%', cursor: 'pointer',
                background: 'transparent', border: 'none', display: 'grid', gridTemplateColumns: '34px 1fr 64px 120px 22px', gap: 12,
                alignItems: 'center', padding: '12px 15px', fontFamily: 'var(--font-ui)', textAlign: 'left' }}>
                <span style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--accent-soft)', color: 'var(--accent-ink)',
                  fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{p.initials}</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>{p.name}</span>
                <span className="mono" style={{ fontSize: 12.5, color: 'var(--fail-ink)' }}>A1c {p.a1c}</span>
                <span style={{ justifySelf: 'end' }}>
                  {status === 'pre' ? <span className="mono" style={{ fontSize: 11.5, color: 'var(--ink-4)' }}>not run</span>
                    : status === 'match' ? <Decision kind="pass" label="exact match" />
                    : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 600,
                        color: 'var(--fail-ink)', background: 'var(--fail-soft)', border: '1px solid var(--fail-line)', borderRadius: 'var(--r-pill)', padding: '3px 9px' }}>
                        <Icon name="x" size={11} color="var(--fail)" stroke={2.6} /> {badField} differs</span>}
                </span>
                <Icon name="chevron" size={15} color="var(--ink-4)" style={{ transform: openP === p.id ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }} />
              </button>
              {openP === p.id && (
                <div style={{ padding: '2px 15px 16px', animation: 'fadeUp .2s both' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: ran ? '1fr 1fr' : '1fr', gap: 10 }}>
                    <div style={{ border: '1px solid var(--accent-line)', borderRadius: 'var(--r-sm)', overflow: 'hidden' }}>
                      <div style={{ padding: '7px 11px', background: 'var(--accent-soft)' }}><span className="eyebrow" style={{ color: 'var(--accent)', fontSize: 9 }}>your expected (reference)</span></div>
                      <div style={{ padding: 11 }}>
                        {expected[p.id].map((m, mi) => {
                          const fd = r && r.rows.find((x) => A2.norm(x.name) === A2.norm(m.name))?.fields.dose;
                          const bad = fd && fd.match === false;
                          return (
                            <div key={mi} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                              <span className="mono" style={{ fontSize: 12, color: 'var(--ink)', fontWeight: 600, minWidth: 108 }}>{m.name}</span>
                              <input value={m.dose} onChange={(e) => { setExpected((c) => ({ ...c, [p.id]: c[p.id].map((x, j) => j === mi ? { ...x, dose: e.target.value } : x) })); setResults({}); setRan(false); }}
                                style={{ width: 96, fontFamily: 'var(--font-mono)', fontSize: 11.5, padding: '4px 8px', borderRadius: 6,
                                  border: `1.5px solid ${bad ? 'var(--fail)' : 'var(--line-2)'}`, background: bad ? 'var(--fail-soft)' : 'var(--surface-2)',
                                  color: bad ? 'var(--fail-ink)' : 'var(--ink)', outline: 'none' }} />
                            </div>
                          );
                        })}
                      </div>
                    </div>
                    {ran && (
                      <div style={{ border: '1px solid var(--line)', borderRadius: 'var(--r-sm)', overflow: 'hidden' }}>
                        <div style={{ padding: '7px 11px', background: 'var(--surface-2)' }}><span className="eyebrow" style={{ fontSize: 9 }}>model returned</span></div>
                        <div style={{ padding: 11 }}>
                          {p.truth.map((m, mi) => {
                            const fd = r.rows.find((x) => A2.norm(x.name) === A2.norm(m.name))?.fields.dose;
                            const bad = fd && fd.match === false;
                            return (
                              <div key={mi} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                                <span className="mono" style={{ fontSize: 12, color: 'var(--ink)', fontWeight: 600, minWidth: 108 }}>{m.name}</span>
                                <span className="mono" style={{ fontSize: 11.5, padding: '4px 8px', borderRadius: 6,
                                  background: bad ? 'var(--pass-soft)' : 'var(--surface-2)', color: bad ? 'var(--pass-ink)' : 'var(--ink-2)', fontWeight: bad ? 600 : 400 }}>{m.dose}</span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                  {/* reference-was-wrong aha */}
                  {status === 'mismatch' && (
                    <div style={{ marginTop: 12, border: '1px solid var(--spot-line)', borderRadius: 'var(--r-md)', overflow: 'hidden' }}>
                      <div style={{ padding: '9px 13px', background: 'var(--spot-soft)', display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Icon name="info" size={15} color="var(--spot)" />
                        <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ink)' }}>Your key says {mm.fields.dose.e}; the model returned {mm.fields.dose.a}. Who's right?</span>
                        <button onClick={() => setShowRec((s) => !s)} style={{ marginLeft: 'auto', cursor: 'pointer', fontFamily: 'var(--font-ui)',
                          fontSize: 11.5, fontWeight: 600, color: 'var(--accent-ink)', background: 'var(--surface)', border: '1px solid var(--accent-line)',
                          borderRadius: 'var(--r-pill)', padding: '5px 11px' }}>{showRec ? 'Hide record' : 'Check the record'}</button>
                      </div>
                      {showRec && (
                        <div style={{ padding: 13 }}>
                          {p.record.Medications.map((line, li) => {
                            const hot = /metformin/i.test(line);
                            return <div key={li} style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: hot ? 'var(--ink)' : 'var(--ink-3)', lineHeight: 1.5,
                              fontWeight: hot ? 600 : 400, background: hot ? 'var(--pass-soft)' : 'transparent', borderRadius: 4, padding: hot ? '2px 5px' : '2px 0', display: 'flex', gap: 7 }}>
                              <span style={{ width: 5, height: 5, borderRadius: '50%', background: hot ? 'var(--pass)' : 'var(--accent)', marginTop: 6, flexShrink: 0 }} />{line}</div>;
                          })}
                          <div style={{ marginTop: 11, padding: '12px 14px', background: 'var(--ink)', borderRadius: 'var(--r-md)' }}>
                            <div style={{ fontSize: 13.5, fontWeight: 700, color: '#fff' }}>The model was right. Your answer key was wrong.</div>
                            <p style={{ fontSize: 12.5, color: 'var(--accent-line)', marginTop: 5, lineHeight: 1.5, maxWidth: 540 }}>
                              The summary never gave Metformin's dose, so you committed the common 500 mg — but the record says 1000 mg.
                              Your key would have <strong style={{ color: '#fff' }}>failed a correct answer.</strong> The lesson isn't "check your memory" —
                              it's that <strong style={{ color: '#fff' }}>you trusted an answer key you hadn't pressure-tested against the source.</strong> Calibration cuts both ways: the reference can be wrong too.
                            </p>
                            <div style={{ marginTop: 11 }}><Btn size="sm" variant="soft" icon="check" onClick={fixRef}
                              style={{ background: 'rgba(255,255,255,.14)', color: '#fff', border: '1px solid rgba(255,255,255,.25)' }}>Fix my key against the record → 1000 mg</Btn></div>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </Card>

      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 16, flexWrap: 'wrap' }}>
        {!ran ? <Btn size="md" icon="play" onClick={run}>Run the diff</Btn>
          : <>
              <span className="mono" style={{ fontSize: 20, fontWeight: 600, color: perfect ? 'var(--pass-ink)' : 'var(--ink)' }}>
                {cohort.filter((p) => results[p.id]?.perfect).length}/{cohort.length}
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: 'var(--pass-ink)',
                background: 'var(--pass-soft)', border: '1px solid var(--pass-line)', borderRadius: 'var(--r-pill)', padding: '4px 11px' }}>
                <Icon name="scale" size={12} color="var(--pass)" /> $0.00 · 0 tokens · instant</span>
            </>}
        {perfect && <Btn size="md" iconR="arrow" onClick={onDone} style={{ marginLeft: 'auto' }}>But what about answers you can't string-match?</Btn>}
      </div>

      {/* reward the disciplined path: clean 3/3 with no fix needed = they checked the source */}
      {perfect && !fixed && (
        <div style={{ marginTop: 14, padding: '13px 15px', background: 'var(--pass-soft)', border: '1px solid var(--pass-line)', borderRadius: 'var(--r-md)', animation: 'fadeUp .3s both' }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--pass-ink)' }}>3/3 — and you earned it by checking the source.</div>
          <p style={{ fontSize: 12.5, color: 'var(--ink-2)', marginTop: 5, lineHeight: 1.5, maxWidth: 600 }}>
            The summary didn't give every dose, but you opened the record and pressure-tested your key against it before committing.
            That's exactly the discipline: <strong>a correctness eval is only as trustworthy as the answer key behind it</strong> — and you
            verified yours instead of trusting an assumption.
          </p>
        </div>
      )}
    </div>
  );
}

window.CF_Beat1 = Beat1;
window.CF_Stepper = Stepper;
window.AtomTag = AtomTag;
window.CF_PROSE = { PROSE_QUERY, PROSE_EXPECTED, PROSE_ROWS };
