/* MRES root app — header, data strip, notebook shell, runs×evals model, drawer. */
(function () {
  const R = React;
  const h = R.createElement;
  const D = window.MRES_DATA;
  const I = window.MRES_ICON;
  const FREE = window.MRES_MODEL_FREE, PAID = window.MRES_MODEL_PAID;
  const BUDGET = 14; // free-tier patient-calls per session before the spend cap

  function truthGolden(p) {
    const t = window.MRES_genOutput(p).truth;
    return JSON.stringify({
      a1c_current: t.a1c_current,
      a1c_trend: t.a1c_trend,
      diabetes_meds: t.diabetes_meds.map((m) => m.split(" ")[0]),
    }, null, 2);
  }

  function exampleSet() {
    const dia = D.patients.filter((p) => p.conds.includes("diabetes"));
    const flawed = dia.filter((p) => window.MRES_genOutput(p).flaw);
    const cleanP = dia.filter((p) => !window.MRES_genOutput(p).flaw);
    const out = cleanP.slice(0, 3).map((p) => p.i);
    if (flawed[0]) out.push(flawed[0].i);
    else out.push((cleanP[3] || dia[3] || dia[0]).i);
    return out.slice(0, 4);
  }

  function ApiKey({ keyVal, setKeyVal, open, setOpen }) {
    const free = !keyVal.trim();
    return h("div", { className: "apikey" },
      h("button", { className: "apikey-btn", onClick: () => setOpen(!open) },
        h("span", { className: "kdot" + (free ? "" : " on") }),
        free ? "Free tier" : "Your key",
        h(I.chevD, { width: 12, height: 12 })),
      open && h("div", { className: "apikey-pop" },
        h("div", { className: "akp-title" }, "API key"),
        h("div", { className: "akp-sub" }, "Free tier runs " + FREE + " on a shared limit, up to 5 patients. Your own key switches to " + PAID + " and removes both caps."),
        h("input", { className: "akp-in", placeholder: "sk-ant-… (optional)", value: keyVal,
          spellCheck: false, onChange: (e) => setKeyVal(e.target.value) }),
        h("div", { className: "akp-foot" }, free ? "Using free tier · " + FREE : "Key stored in this session only · " + PAID)));
  }

  function App() {
    const params = new URLSearchParams(location.search);
    const isExample = params.get("example") === "1";
    const locked = D.featured[0];

    const [prompt, setPrompt] = R.useState(isExample ? window.MRES_WORKED_PROMPT : "");
    const [selected, setSelected] = R.useState(isExample ? exampleSet() : [locked]);
    const [runs, setRuns] = R.useState([]);
    const [curRunId, setCurRunId] = R.useState(null);
    const [nextRunId, setNextRunId] = R.useState(1);
    const [runId, setRunId] = R.useState(0); // streaming key
    const [running, setRunning] = R.useState(false);

    const [mode, setMode] = R.useState(null);
    const [golden, setGolden] = R.useState({});
    const [judges, setJudges] = R.useState([{ id: "j1", criteria: "", label: "judge" }]);
    const [scores, setScores] = R.useState({});
    const [versions, setVersions] = R.useState({});
    const [expandRuns, setExpandRuns] = R.useState(false);

    const [keyVal, setKeyVal] = R.useState("");
    const [keyOpen, setKeyOpen] = R.useState(false);
    const [sessionCalls, setSessionCalls] = R.useState(0);
    const [spendCap, setSpendCap] = R.useState(false);

    const [drawerOpen, setDrawerOpen] = R.useState(false);
    const [drawerPatient, setDrawerPatient] = R.useState(null);
    const [drawerRaw, setDrawerRaw] = R.useState(false);

    const hasKey = !!keyVal.trim();
    const model = hasKey ? PAID : FREE;
    window.MRES_ACTIVE_MODEL = model;
    const lockedIdx = selected.includes(locked) ? locked : null;
    const curRun = runs.find((r) => r.id === curRunId);
    const curResults = curRun ? curRun.results : [];
    const stale = !!curRun && prompt.trim() !== curRun.prompt.trim();

    R.useEffect(() => { if (hasKey && spendCap) setSpendCap(false); }, [hasKey]);

    function doRun() {
      if (!hasKey && sessionCalls + selected.length > BUDGET) { setSpendCap(true); return; }
      setSpendCap(false);
      const ptrim = prompt.trim();
      const existing = runs.find((r) => r.prompt.trim() === ptrim);
      const version = existing ? existing.version : runs.length + 1;
      const rid = existing ? existing.id : nextRunId;
      const rs = selected.map((i, idx) => {
        const p = D.patients[i];
        const o = window.MRES_genOutput(p, version);
        return { p, json: o.json, truth: o.truth, flaw: o.flaw, chart: o.chart, prompt, delay: 250 + idx * 420 };
      });
      if (!hasKey && selected.length >= 5) rs[rs.length - 1].status = "rate-limited";
      const runObj = { id: rid, version, prompt, selected: selected.slice(), results: rs };
      setRuns((prev) => existing ? prev.map((r) => (r.id === rid ? runObj : r)) : [...prev, runObj]);
      if (!existing) setNextRunId((n) => n + 1);
      setCurRunId(rid);
      setRunId((n) => n + 1);
      setRunning(true);
      setSessionCalls((c) => c + selected.length);
      const maxDelay = 250 + (rs.length - 1) * 420;
      setTimeout(() => setRunning(false), maxDelay + 1700);
    }

    function bumpVersion(key, snap) {
      const cur = versions[key];
      const v = !cur ? 1 : (cur.snap !== snap ? cur.v + 1 : cur.v);
      setVersions((vs) => Object.assign({}, vs, { [key]: { v, snap } }));
      return v;
    }

    function scoreGolden() {
      const run = runs.find((r) => r.id === curRunId);
      if (!run) return;
      const per = run.results.map((r) => {
        const g = window.MRES_gradeGolden(r.json, golden[r.p.i] || "");
        return { i: r.p.i, name: r.p.name, pass: g.state === "pass", state: g.state, fails: g.fails };
      });
      const frac = per.filter((x) => x.state === "pass").length + "/" + run.results.length;
      const v = bumpVersion("golden", JSON.stringify(golden));
      setScores((s) => Object.assign({}, s, { golden: Object.assign({}, s.golden, { [run.id]: { frac, per, version: v } }) }));
    }

    function scoreJudge(jid) {
      const run = runs.find((r) => r.id === curRunId);
      if (!run) return;
      const judge = judges.find((j) => j.id === jid);
      const per = run.results.map((r) => window.MRES_judgeErr(r.p)
        ? { i: r.p.i, name: r.p.name, errored: true }
        : Object.assign({ i: r.p.i, name: r.p.name, agree: null }, window.MRES_judgeVerdict(r)));
      const scored = per.filter((x) => !x.errored);
      const frac = scored.filter((x) => x.pass).length + "/" + scored.length;
      const key = "judge:" + jid;
      const v = bumpVersion(key, judge ? judge.criteria : "");
      setScores((s) => Object.assign({}, s, { [key]: Object.assign({}, s[key], { [run.id]: { frac, per, version: v } }) }));
    }

    const scoreGoldenRef = R.useRef(); scoreGoldenRef.current = scoreGolden;

    function updateJudge(id, criteria) { setJudges((js) => js.map((j) => (j.id === id ? Object.assign({}, j, { criteria }) : j))); }
    function addJudge() {
      setJudges((js) => [...js, { id: "j" + Date.now(), criteria: "", label: "judge " + (js.length + 1) }]);
    }
    function removeJudge(id) {
      setJudges((js) => js.filter((j) => j.id !== id));
      setScores((s) => { const n = Object.assign({}, s); delete n["judge:" + id]; return n; });
      setVersions((vs) => { const n = Object.assign({}, vs); delete n["judge:" + id]; return n; });
    }
    function onAgree(jkey, rid, i, val) {
      setScores((s) => {
        const ev = s[jkey]; if (!ev || !ev[rid]) return s;
        const cell = ev[rid];
        const per = cell.per.map((x) => (x.i === i ? Object.assign({}, x, { agree: x.agree === val ? null : val }) : x));
        return Object.assign({}, s, { [jkey]: Object.assign({}, ev, { [rid]: Object.assign({}, cell, { per }) }) });
      });
    }

    function resume(i) {
      setRuns((prev) => prev.map((r) => r.id === curRunId
        ? Object.assign({}, r, { results: r.results.map((x) => (x.p.i === i ? Object.assign({}, x, { status: undefined }) : x)) })
        : r));
    }

    function viewChart(i) { setDrawerPatient(i); setDrawerRaw(false); setDrawerOpen(true); }
    function openCorpus() { setDrawerPatient(null); setDrawerOpen(true); }
    function loadExample() { location.search = "?example=1"; }

    function exportRun() {
      const labelFor = (k) => k === "golden" ? "golden" : (judges.find((j) => "judge:" + j.id === k) || {}).label || "judge";
      const evalKeys = [];
      if (scores.golden && Object.keys(scores.golden).length) evalKeys.push("golden");
      judges.forEach((j) => { const k = "judge:" + j.id; if (scores[k] && Object.keys(scores[k]).length) evalKeys.push(k); });
      const payload = {
        model, exported: new Date().toISOString(),
        runs: runs.map((r) => ({ run: r.version, prompt: r.prompt,
          patients: r.results.map((x) => ({ mrn: x.p.mrn, name: x.p.name, output: x.json, status: x.status || "ok" })) })),
        grid: evalKeys.map((k) => ({ eval: labelFor(k), version: versions[k] ? versions[k].v : 1,
          scores: runs.map((r) => ({ run: r.version, score: scores[k] && scores[k][r.id] ? scores[k][r.id].frac : null })) })),
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "mres-run.json";
      a.click();
    }

    // worked example: auto-run, prefill + auto-score golden once
    R.useEffect(() => {
      if (!isExample) return;
      const g = {};
      exampleSet().forEach((i) => { g[i] = truthGolden(D.patients[i]); });
      setGolden(g);
      const t = setTimeout(() => {
        doRun();
        setTimeout(() => { setMode("golden"); setTimeout(() => scoreGoldenRef.current(), 320); }, 2500);
      }, 350);
      return () => clearTimeout(t);
    }, []);

    const ctx = {
      results: curResults, mode, setMode, golden, setGolden, judges, updateJudge, addJudge, removeJudge,
      scores, versions, onScoreGolden: scoreGolden, onScoreJudge: scoreJudge, onOpenChart: viewChart,
      model, stale, curRunId, onAgree, runs, expandRuns, setExpandRuns, onExport: exportRun,
    };
    const addedJudges = judges.slice(1);

    return h("div", { className: "app" },
      h("header", { className: "appbar" },
        h("div", { className: "brand" },
          h("span", { className: "mark" }, "M", h("span", { className: "dot" }), "RES"),
          h("span", { className: "brand-sub" }, "Medical-Record Eval Sandbox")),
        h("div", { className: "appbar-right" },
          h("div", { className: "modelbadge" }, h("span", { className: "led" }), model),
          h(ApiKey, { keyVal, setKeyVal, open: keyOpen, setOpen: setKeyOpen }))),

      h("div", { className: "shell" + (drawerOpen ? " drawer-open" : "") },
        h("main", { className: "notebook" },
          h("div", { className: "nb-inner" },
            h("div", { className: "datastrip" },
              h("div", { className: "ds-line" },
                h("span", { className: "ds-n" }, D.count), " synthetic patients · Synthea C-CDA · full charts: ",
                h("span", { className: "ds-em" }, "medications, problems, labs, encounters"),
                h("span", { className: "ds-phi" }, "fully synthetic · no PHI")),
              h("div", { className: "ds-row2" },
                h("span", { className: "ds-note" }, "Synthetic charts are cleaner than real ones — a prompt that passes here still meets messier records in production."),
                h("button", { className: "explore-btn" + (drawerOpen && drawerPatient == null ? " on" : ""), onClick: openCorpus },
                  h(I.table, null), "Explore the data"))),

            h(window.MRES_PromptCell, { prompt, setPrompt, selected, setSelected, lockedIndex: lockedIdx, running, onRun: doRun,
              hasKey, showLoadExample: curResults.length === 0 && !isExample && !spendCap, onLoadExample: loadExample }),
            h(window.MRES_OutputCell, { results: curResults, runId, onViewChart: viewChart, model, stale, onResume: resume,
              spendCap, onAddKey: () => setKeyOpen(true) }),
            !spendCap && h(window.MRES_EvalCell, { ctx }),
            !spendCap && addedJudges.map((j) => h(window.MRES_JudgeCell, { key: j.id, ctx, judge: j })),
            !spendCap && h(window.MRES_AddEval, { ctx }),
            h(window.MRES_ScoreArea, { ctx }),
            isExample && h(window.MRES_WorkedJudgeLeg, { patients: exampleSet(), model, onOpenChart: viewChart }),
            h("div", { className: "nb-end" }))),

        h(window.MRES_Drawer, {
          open: drawerOpen, patientIndex: drawerPatient, raw: drawerRaw, setRaw: setDrawerRaw,
          onClose: () => setDrawerOpen(false), onPick: (i) => setDrawerPatient(i),
        })));
  }

  ReactDOM.createRoot(document.getElementById("root")).render(h(App));
})();
