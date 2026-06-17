/* Notebook cells: Prompt, Output, Eval (golden + judge), Score line. */
(function () {
  const R = React;
  const h = R.createElement;
  const D = window.MRES_DATA;
  const I = window.MRES_ICON;

  // alias/casing/whitespace/order-forgiving set comparison (by drug name)
  const setEq = (a, b) => {
    const norm = (arr) => new Set((arr || []).map((x) => window.MRES_norm(String(x).split(" ")[0])));
    const A = norm(a), B = norm(b);
    if (A.size !== B.size) return false;
    for (const x of A) if (!B.has(x)) return false;
    return true;
  };

  // ===================== PROMPT CELL =====================================
  function Chip({ p, onRemove, locked }) {
    return h("span", { className: "chip" + (locked ? " chip-locked" : "") },
      h("span", { className: "chip-name" }, p.name.replace(/\d+/g, "")),
      h("span", { className: "chip-id" }, p.mrn),
      locked
        ? h("span", { className: "chip-lock" }, "pre-selected")
        : h("button", { className: "chip-x", onClick: onRemove, title: "Remove" }, h(I.x, null)));
  }

  function AddPatient({ selected, onAdd, full, capped }) {
    const [open, setOpen] = R.useState(false);
    const avail = D.patients.filter((p) => !selected.includes(p.i));
    return h("span", { className: "addwrap" },
      h("button", {
        className: "add-btn", disabled: full, onClick: () => setOpen((o) => !o),
        title: capped ? "Free tier runs up to 5 patients; your key removes the cap." : "",
      }, full ? "5 max · free tier" : "+ patient"),
      open && !full && h("div", { className: "add-pop" },
        avail.slice(0, 40).map((p) =>
          h("button", { className: "add-row", key: p.i, onClick: () => { onAdd(p.i); setOpen(false); } },
            h("span", { className: "ar-name" }, p.name.replace(/\d+/g, "")),
            h("span", { className: "ar-meta" }, p.age + (p.sex) + " · " + p.conds.length + " cond"),
            h("span", { className: "ar-id" }, p.mrn)))));
  }

  function PromptCell({ prompt, setPrompt, selected, setSelected, lockedIndex, running, onRun, hasKey, showLoadExample, onLoadExample }) {
    const cap = hasKey ? Infinity : 5;
    const full = selected.length >= cap;
    return h("div", { className: "cell" },
      h("div", { className: "cell-gutter" }, h("span", { className: "cell-tag" }, "prompt")),
      h("div", { className: "cell-main" },
        showLoadExample && h("div", { className: "load-example" },
          h("span", { className: "le-text" }, "New here? "),
          h("button", { className: "le-link", onClick: onLoadExample }, "Load the worked example", h(I.chevR, { width: 12, height: 12 }))),
        h("textarea", {
          className: "prompt-in",
          value: prompt,
          spellCheck: false,
          placeholder: window.MRES_WORKED_PROMPT,
          onChange: (e) => setPrompt(e.target.value),
        }),
        h("div", { className: "run-against" },
          h("div", { className: "ra-left" },
            h("span", { className: "ra-label" }, "Run against"),
            h("div", { className: "chips" },
              selected.map((i) =>
                h(Chip, { key: i, p: D.patients[i], locked: i === lockedIndex,
                  onRemove: () => setSelected(selected.filter((x) => x !== i)) })),
              h(AddPatient, { selected, full, capped: full && !hasKey, onAdd: (i) => setSelected([...selected, i]) }))),
          h("button", { className: "run-btn", disabled: running || selected.length === 0, onClick: onRun },
            h(I.run, null), running ? "Running…" : "Run")),
        h("div", { className: "run-note" }, "The prompt runs once per selected patient · " + selected.length + " " + (selected.length === 1 ? "call" : "calls"))));
  }

  // ===================== OUTPUT CARD (streaming) =========================
  function OutputCard({ result, runId, onViewChart, model, stale, onResume }) {
    const full = JSON.stringify(result.json, null, 2);
    const limited = result.status === "rate-limited";
    const [shown, setShown] = R.useState(limited ? 0 : full.length);
    const [saw, setSaw] = R.useState(false);

    R.useEffect(() => {
      if (limited) { setShown(0); return; }
      setShown(0);
      let n = 0;
      const start = setTimeout(function tick() {
        const step = 6 + Math.floor(Math.random() * 8);
        n = Math.min(full.length, n + step);
        setShown(n);
        if (n < full.length) setTimeout(tick, 18);
      }, result.delay);
      return () => clearTimeout(start);
    }, [runId, result.status]);

    // ---- rate-limited state (6a) ----
    if (limited) {
      return h("div", { className: "ocard ocard-fail" },
        h("div", { className: "ocard-head" },
          h("div", { className: "oc-left" },
            h("span", { className: "oc-name" }, result.p.name.replace(/\d+/g, "")),
            h("span", { className: "oc-mrn" }, result.p.mrn)),
          h("div", { className: "oc-right" }, h("span", { className: "oc-flag warn" }, h(I.bolt, null), "rate-limited"))),
        h("div", { className: "card-state" },
          h("div", { className: "cs-text" }, "The free tier's shared limit was hit before this patient ran. Nothing was charged."),
          h("button", { className: "cs-btn", onClick: () => onResume(result.p.i) }, h(I.refresh, null), "Resume this patient")));
    }

    const done = shown >= full.length;
    const partial = full.slice(0, shown);
    const html = done ? window.MRES_hl(result.json) : partial.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const ser = window.MRES_serializeChart(result.p, result.prompt);

    return h("div", { className: "ocard" + (done ? "" : " streaming") + (stale ? " stale" : "") },
      h("div", { className: "ocard-head" },
        h("div", { className: "oc-left" },
          h("span", { className: "oc-name" }, result.p.name.replace(/\d+/g, "")),
          h("span", { className: "oc-mrn" }, result.p.mrn)),
        h("div", { className: "oc-right" },
          stale
            ? h("span", { className: "oc-flag stale-flag" }, h(I.refresh, null), "stale — re-run")
            : done
              ? h("span", { className: "oc-stamp" }, model)
              : h("span", { className: "oc-streaming" }, h("span", { className: "blink" }), "streaming"))),
      h("pre", { className: "oc-json" },
        done
          ? h("code", { dangerouslySetInnerHTML: { __html: html } })
          : h("code", null, partial, h("span", { className: "caret" }))),
      done && h("div", { className: "oc-foot" },
        h("button", { className: "linkbtn", onClick: () => onViewChart(result.p.i) }, h(I.doc, null), "view chart"),
        h("button", { className: "linkbtn quiet", onClick: () => setSaw((s) => !s) },
          h(I.eye, null), "what the model saw"),
        h("span", { className: "oc-modeltag" }, model)),
      saw && done && h("div", { className: "saw" },
        h("div", { className: "saw-head" },
          h("span", null, "Exact input sent to " + model + " · read-only"),
          h("span", { className: "saw-ctx " + (ser.retrieved ? "ctx-warn" : "ctx-ok") },
            ser.retrieved ? "retrieved sections · chart too large" : "full chart · fit in context")),
        h("pre", { className: "saw-body" },
          h("span", { className: "saw-section" }, "PROMPT\n"), ser.prompt + "\n\n",
          h("span", { className: "saw-section" }, "CONTEXT\n"), ser.chartText)));
  }

  function OutputCell({ results, runId, onViewChart, model, stale, onResume, spendCap, onAddKey }) {
    // ---- spend-cap state (6b) ----
    if (spendCap) {
      return h("div", { className: "cell" },
        h("div", { className: "cell-gutter" }, h("span", { className: "cell-tag" }, "output")),
        h("div", { className: "cell-main" },
          h("div", { className: "cap-state" },
            h("div", { className: "cap-icon" }, h(I.lock, null)),
            h("div", { className: "cap-body" },
              h("div", { className: "cap-title" }, "Free-tier spend cap reached"),
              h("div", { className: "cap-sub" }, "This session has used up the free tier. Your prompt and patients are kept — add your own key to keep running."),
              h("button", { className: "btn-primary sm", onClick: onAddKey }, "Add your key")))));
    }
    if (!results.length) return null;
    return h("div", { className: "cell" },
      h("div", { className: "cell-gutter" }, h("span", { className: "cell-tag" }, "output")),
      h("div", { className: "cell-main" },
        h("div", { className: "out-head" },
          h("span", null, "Output"),
          h("span", { className: "out-sub" }, results.length + " " + (results.length === 1 ? "patient" : "patients") + " · JSON"),
          stale && h("span", { className: "out-stale" }, "edited since this run")),
        h("div", { className: "ocards" },
          results.map((r) => h(OutputCard, { key: r.p.i, result: r, runId, onViewChart, model, stale, onResume })))));
  }

  window.MRES_PromptCell = PromptCell;
  window.MRES_OutputCell = OutputCell;
  window.MRES_setEq = setEq;
})();
