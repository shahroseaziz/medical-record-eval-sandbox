/* ============================================================
   Correctness-first — Beat 2 + Beat 3 + orchestrator.
   ============================================================ */
(function () {
const { PROSE_QUERY, PROSE_EXPECTED, PROSE_ROWS } = window.CF_PROSE;
const AtomTag = window.AtomTag;

/* =================== BEAT 2 — diff can't grade prose → judge =================== */
function Beat2({ onDone }) {
  const [expected, setExpected] = useState(PROSE_EXPECTED);
  const [evaluator, setEvaluator] = useState(null); // null | 'diff' | 'judge'
  const [ran, setRan] = useState(false);

  function runDiff() { setEvaluator('diff'); setRan(true); }
  function runJudge() { setEvaluator('judge'); setRan(true); }

  const diffMatches = 0; // exact string match never matches prose
  const judgeMatches = PROSE_ROWS.filter((r) => r.judge === 'match').length;

  return (
    <div style={{ animation: 'fadeUp .3s both' }}>
      <Eyebrow color="var(--accent)">Beat 2 · the same eval, a different answer shape</Eyebrow>
      <h1 style={{ fontSize: 'clamp(23px,3vw,32px)', marginTop: 10, maxWidth: 660 }}>
        Now the right answer is a sentence — and a diff falls apart.
      </h1>
      <p style={{ fontSize: 15, color: 'var(--ink-2)', marginTop: 12, maxWidth: 660 }}>
        Same cohort, new task: <strong>“{PROSE_QUERY}”</strong> You can still write the answer you expect — but it's prose,
        and no two correct sentences are the same string. Try to grade it with a diff first.
      </p>

      <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11.5, color: 'var(--ink-3)', display: 'inline-flex', alignItems: 'center', gap: 6 }}><AtomTag>prompt</AtomTag> diabetes-control summary</span>
        <span style={{ color: 'var(--line-2)' }}>·</span>
        <span style={{ fontSize: 11.5, color: 'var(--ink-3)', display: 'inline-flex', alignItems: 'center', gap: 6 }}><AtomTag>cases</AtomTag> 3 patients</span>
        <span style={{ color: 'var(--line-2)' }}>·</span>
        <span style={{ fontSize: 11.5, color: 'var(--accent-ink)', display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600 }}><AtomTag>evaluator</AtomTag> {evaluator === 'judge' ? 'reference judge' : evaluator === 'diff' ? 'deterministic diff' : 'pick one ↓'}</span>
      </div>

      {/* expected */}
      <Card style={{ marginTop: 16 }}>
        <div className="eyebrow" style={{ color: 'var(--accent)', marginBottom: 8 }}>your expected answer (one reference, applies to all)</div>
        <textarea value={expected} onChange={(e) => setExpected(e.target.value)} rows={2} spellCheck={false}
          style={{ width: '100%', resize: 'vertical', fontFamily: 'var(--font-ui)', fontSize: 14, lineHeight: 1.5, color: 'var(--ink)',
            padding: '11px 13px', borderRadius: 'var(--r-md)', border: '1.5px solid var(--line-2)', background: 'var(--surface-2)', outline: 'none' }} />
      </Card>

      {/* evaluator picker */}
      <div style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
        <button onClick={runDiff} style={{ cursor: 'pointer', flex: '1 1 240px', textAlign: 'left', padding: '13px 15px', borderRadius: 'var(--r-md)',
          background: evaluator === 'diff' ? 'var(--surface)' : 'var(--surface-2)', border: `1.5px solid ${evaluator === 'diff' ? 'var(--accent)' : 'var(--line-2)'}`, fontFamily: 'var(--font-ui)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}><Icon name="scale" size={15} color="var(--ink-3)" /><strong style={{ fontSize: 13.5 }}>Deterministic diff</strong></div>
          <div style={{ fontSize: 11.5, color: 'var(--ink-3)', marginTop: 4 }}>exact string match · free</div>
        </button>
        <button onClick={runJudge} style={{ cursor: 'pointer', flex: '1 1 240px', textAlign: 'left', padding: '13px 15px', borderRadius: 'var(--r-md)',
          background: evaluator === 'judge' ? 'var(--accent-soft)' : 'var(--surface-2)', border: `1.5px solid ${evaluator === 'judge' ? 'var(--accent)' : 'var(--line-2)'}`, fontFamily: 'var(--font-ui)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}><Icon name="flask" size={15} color="var(--accent)" /><strong style={{ fontSize: 13.5 }}>Reference judge</strong></div>
          <div style={{ fontSize: 11.5, color: 'var(--ink-3)', marginTop: 4 }}>LLM compares meaning vs your expected · costs tokens</div>
        </button>
      </div>

      {/* results */}
      {ran && (
        <Card pad={0} style={{ marginTop: 14, overflow: 'hidden', animation: 'fadeUp .25s both' }}>
          {PROSE_ROWS.map((r, i) => {
            const verdict = evaluator === 'diff' ? 'mismatch' : r.judge;
            const v = verdict === 'match' ? { c: 'var(--pass)', ink: 'var(--pass-ink)', bg: 'var(--pass-soft)', ln: 'var(--pass-line)', icon: 'check', label: 'match' }
              : { c: 'var(--fail)', ink: 'var(--fail-ink)', bg: 'var(--fail-soft)', ln: 'var(--fail-line)', icon: 'x', label: 'no match' };
            return (
              <div key={r.id} style={{ padding: '12px 15px', borderBottom: i < PROSE_ROWS.length - 1 ? '1px solid var(--line)' : 'none' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ink)', minWidth: 130 }}>{r.name}</span>
                  <span style={{ flex: 1, fontSize: 12.5, color: 'var(--ink-2)', fontStyle: 'italic', lineHeight: 1.45 }}>“{r.actual}”</span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 600,
                    background: v.bg, border: `1px solid ${v.ln}`, color: v.ink, borderRadius: 'var(--r-pill)', padding: '3px 9px', flexShrink: 0 }}>
                    <Icon name={v.icon} size={11} color={v.c} stroke={2.6} /> {v.label}</span>
                </div>
                {evaluator === 'judge' && (
                  <div style={{ fontSize: 11.5, color: r.judge === 'mismatch' ? 'var(--fail-ink)' : 'var(--ink-3)', marginTop: 6, paddingLeft: 140, lineHeight: 1.45 }}>{r.why}</div>
                )}
              </div>
            );
          })}
        </Card>
      )}

      {/* the lesson */}
      {evaluator === 'diff' && (
        <div style={{ marginTop: 14, padding: '14px 16px', borderRadius: 'var(--r-md)', background: 'var(--fail-soft)', border: '1px solid var(--fail-line)', animation: 'fadeUp .25s both' }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--fail-ink)' }}>0 of 3 — the diff failed every one.</div>
          <p style={{ fontSize: 12.5, color: 'var(--ink-2)', marginTop: 5, lineHeight: 1.55, maxWidth: 660 }}>
            Even Benally's answer, which means <em>exactly</em> what you wrote, scores “no match” — because the words differ.
            A string comparison can't tell <strong>same meaning</strong> from <strong>same characters</strong>. This is the
            moment you reach for a judge — not because judges are fancy, but because <strong>comparison stopped being mechanical.</strong>
          </p>
          <div style={{ marginTop: 11 }}><Btn size="sm" icon="flask" onClick={runJudge}>Grade it with a reference judge instead</Btn></div>
        </div>
      )}
      {evaluator === 'judge' && (
        <div style={{ marginTop: 14, padding: '14px 16px', borderRadius: 'var(--r-md)', background: 'var(--accent-soft)', border: '1px solid var(--accent-line)', animation: 'fadeUp .25s both' }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--accent-ink)' }}>{judgeMatches} of 3 — and it caught the one that's subtly wrong.</div>
          <p style={{ fontSize: 12.5, color: 'var(--ink-2)', marginTop: 5, lineHeight: 1.55, maxWidth: 680 }}>
            The judge read <em>meaning</em>: two phrasings that match your reference pass, and Okafor's “nearly at goal” —
            which contradicts an above-target A1c — fails. That's the rule of thumb: <strong>deterministic when you can,
            a judge when meaning matters.</strong> You just felt why.
          </p>
          <div style={{ marginTop: 12 }}><Btn size="md" iconR="arrow" onClick={onDone}>But what if there's no answer to write down at all?</Btn></div>
        </div>
      )}
    </div>
  );
}

/* =================== BEAT 3 — faithfulness capstone =================== */
const J_LENIENT = 'Grade each claim in the answer. Label it supported or unsupported. Use your medical knowledge to judge whether each claim is reasonable for a patient like this.';
const J_STRICT = 'Grade each claim in the answer. Label it supported or unsupported. A claim is supported ONLY if it is explicitly stated in the record. Do not infer from medical plausibility.';
const isStrict = (t) => /explicit|only if|stated in the record|do not infer|don'?t infer|not.*plausib/i.test(t || '');
const CAP_ANSWER = 'The patient is allergic to penicillin (hives) and sulfa drugs (rash), and also has an aspirin sensitivity.';
const CAP_CLAIMS = [
  { t: 'Allergic to penicillin (hives)', always: 'supported', why: 'Stated in the record.' },
  { t: 'Allergic to sulfa drugs (rash)', always: 'supported', why: 'Stated in the record.' },
  { t: 'Has an aspirin sensitivity', flips: true, lenient: 'Plausible — aspirin allergy is common.', strict: 'Not in the record. Nothing about aspirin appears in the source.' },
];

function Beat3({ onRestart }) {
  const [jp, setJp] = useState(J_LENIENT);
  const strict = isStrict(jp);
  const verdicts = CAP_CLAIMS.map((c) => ({ ...c, verdict: c.flips ? (strict ? 'unsupported' : 'supported') : c.always }));
  const supported = verdicts.filter((v) => v.verdict === 'supported').length;
  const score = supported / verdicts.length;

  return (
    <div style={{ animation: 'fadeUp .3s both' }}>
      <Eyebrow color="var(--accent)">Beat 3 · the capstone — faithfulness</Eyebrow>
      <h1 style={{ fontSize: 'clamp(23px,3vw,32px)', marginTop: 10, maxWidth: 660 }}>
        Sometimes there's no right answer to write down — only a source not to betray.
      </h1>
      <p style={{ fontSize: 15, color: 'var(--ink-2)', marginTop: 12, maxWidth: 680 }}>
        “List this patient's allergies.” You <em>can't</em> pre-author every allergy for every patient — but you can demand the
        answer stay true to the record. That's <Gloss term="faithfulness" plain="Is every claim grounded in the source? No expected answer — the judge checks the output against the record itself."
        real="The hardest eval: there's no reference to match, so a fallible judge is the only thing between you and a hallucination.">faithfulness</Gloss>,
        and here the judge is <strong>the only thing between you and a hallucination</strong> — so it had better be right.
      </p>

      <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11.5, color: 'var(--ink-3)', display: 'inline-flex', alignItems: 'center', gap: 6 }}><AtomTag>prompt</AtomTag> list allergies</span>
        <span style={{ color: 'var(--line-2)' }}>·</span>
        <span style={{ fontSize: 11.5, color: 'var(--ink-3)', display: 'inline-flex', alignItems: 'center', gap: 6 }}><AtomTag>cases</AtomTag> this patient</span>
        <span style={{ color: 'var(--line-2)' }}>·</span>
        <span style={{ fontSize: 11.5, color: 'var(--accent-ink)', display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600 }}><AtomTag>evaluator</AtomTag> faithfulness judge · <strong>no expected answer</strong></span>
      </div>

      <Card style={{ marginTop: 16 }}>
        <span className="eyebrow">the answer to grade</span>
        <p style={{ marginTop: 8, fontSize: 14.5, lineHeight: 1.6, color: 'var(--ink)' }}>{CAP_ANSWER}</p>
      </Card>

      <Card style={{ marginTop: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <span className="eyebrow" style={{ color: 'var(--accent)' }}>the judge's instruction · yours to edit</span>
          <div style={{ display: 'flex', gap: 7 }}>
            {[['Lenient', J_LENIENT], ['Strict', J_STRICT]].map(([l, t]) => (
              <button key={l} onClick={() => setJp(t)} style={{ cursor: 'pointer', padding: '5px 11px', borderRadius: 'var(--r-pill)', fontFamily: 'var(--font-ui)',
                fontSize: 12, fontWeight: 600, border: `1.5px solid ${jp === t ? 'var(--accent)' : 'var(--line-2)'}`, background: jp === t ? 'var(--accent-soft)' : 'var(--surface)', color: jp === t ? 'var(--accent-ink)' : 'var(--ink-2)' }}>{l}</button>
            ))}
          </div>
        </div>
        <textarea value={jp} onChange={(e) => setJp(e.target.value)} rows={3} spellCheck={false}
          style={{ width: '100%', marginTop: 10, resize: 'vertical', fontFamily: 'var(--font-mono)', fontSize: 12.5, lineHeight: 1.6, color: 'var(--ink)',
            padding: '11px 13px', borderRadius: 'var(--r-md)', border: '1.5px solid var(--line-2)', background: 'var(--surface-2)', outline: 'none' }} />

        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 14, flexWrap: 'wrap' }}>
          <ScoreRing score={score} size={76} threshold={0.85} animate={false} />
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>{supported} of 3 supported · {Math.round(score * 100)}%</div>
            <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 3, lineHeight: 1.45 }}>
              {strict ? 'Strict: the judge demands the record actually say it — so it catches the invented aspirin claim.'
                : 'Lenient: the judge reasons from plausibility — so it waves the invented aspirin claim through.'}
            </div>
          </div>
        </div>
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 7 }}>
          {verdicts.map((v, i) => {
            const vd = VERDICT[v.verdict];
            return (
              <div key={i} style={{ border: `1px solid ${vd.ln}`, background: vd.bg, borderRadius: 'var(--r-sm)', padding: '9px 12px',
                display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
                <span style={{ flex: 1, fontSize: 12.5, color: 'var(--ink)', fontWeight: 500 }}>“{v.t}”</span>
                {v.flips && <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--spot)', fontWeight: 700 }}>moves with your wording ↻</span>}
                <VerdictChip verdict={v.verdict} size="sm" />
              </div>
            );
          })}
        </div>
      </Card>

      <div style={{ marginTop: 16, padding: '16px 18px', borderRadius: 'var(--r-lg)', background: 'var(--ink)', color: '#fff' }}>
        <div className="eyebrow" style={{ color: 'var(--accent-line)' }}>why this is the hardest one</div>
        <p style={{ fontSize: 15, lineHeight: 1.5, marginTop: 9, maxWidth: 720, color: '#fff', fontWeight: 500 }}>
          With a diff, a wrong reference fails a right answer — annoying, but visible. With faithfulness there's <em>no</em>
          reference: the judge is the last line of defense, and you just watched it pass a hallucination because of one word
          in its instructions. <strong>That's the soul of evals — the evaluator is itself fallible, and the stakes are highest exactly where you can least check it.</strong>
        </p>
        <div style={{ display: 'flex', gap: 11, marginTop: 16, flexWrap: 'wrap' }}>
          <Btn size="md" icon="layers" onClick={onRestart} style={{ background: 'var(--accent)', color: '#fff', border: '1px solid transparent', boxShadow: 'var(--sh-accent)' }}>Take all three to the open workbench</Btn>
          <button onClick={onRestart} style={{ cursor: 'pointer', background: 'transparent', border: 'none', color: 'var(--accent-line)', fontSize: 13, fontFamily: 'var(--font-ui)' }}>or replay the lesson</button>
        </div>
      </div>
    </div>
  );
}

function CorrectnessFirstApp() {
  const [beat, setBeat] = useState(1);
  const go = (b) => { setBeat(b); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  return (
    <div style={{ minHeight: '100vh' }}>
      <CF_Stepper beat={beat} />
      <div style={{ maxWidth: 920, margin: '0 auto', padding: '30px 24px 90px' }}>
        {beat === 1 && <CF_Beat1 onDone={() => go(2)} />}
        {beat === 2 && <Beat2 onDone={() => go(3)} />}
        {beat === 3 && <Beat3 onRestart={() => go(1)} />}
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<CorrectnessFirstApp />);
})();
