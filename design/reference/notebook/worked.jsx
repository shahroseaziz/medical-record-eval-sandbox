/* Worked-example judge leg (#1): a second query whose output is prose,
   graded by an LLM judge — shown finished, below the golden 3/4 result.
   Rendered only on ?example=1. Manages its own reveal timers. */
(function () {
  const R = React;
  const h = R.createElement;
  const D = window.MRES_DATA;
  const I = window.MRES_ICON;

  function ProseCard({ p, text, delay, model, onOpenChart }) {
    const [shown, setShown] = R.useState(0);
    R.useEffect(() => {
      let n = 0;
      const start = setTimeout(function tick() {
        n = Math.min(text.length, n + 3 + Math.floor(Math.random() * 4));
        setShown(n);
        if (n < text.length) setTimeout(tick, 16);
      }, delay);
      return () => clearTimeout(start);
    }, []);
    const done = shown >= text.length;
    return h("div", { className: "ocard" + (done ? "" : " streaming") },
      h("div", { className: "ocard-head" },
        h("div", { className: "oc-left" },
          h("span", { className: "oc-name" }, p.name.replace(/\d+/g, "")),
          h("span", { className: "oc-mrn" }, p.mrn)),
        h("div", { className: "oc-right" },
          done ? h("span", { className: "oc-stamp" }, model)
            : h("span", { className: "oc-streaming" }, h("span", { className: "blink" }), "streaming"))),
      h("div", { className: "oc-prose" }, text.slice(0, shown), !done && h("span", { className: "caret" })),
      done && h("div", { className: "oc-foot" },
        h("button", { className: "linkbtn", onClick: () => onOpenChart(p.i) }, h(I.doc, null), "view chart"),
        h("span", { className: "oc-modeltag" }, model)));
  }

  function WorkedJudgeLeg({ patients, model, onOpenChart }) {
    const [judged, setJudged] = R.useState(false);
    const items = patients.map((i, idx) => {
      const p = D.patients[i];
      const miscall = idx === 1;            // one summary draws the wrong conclusion
      const errored = idx === patients.length - 1; // last: judge transport error
      return { p, idx, miscall, errored, prose: window.MRES_genProse(p, miscall) };
    });
    R.useEffect(() => {
      const t = setTimeout(() => setJudged(true), 400 + patients.length * 470 + 1300);
      return () => clearTimeout(t);
    }, []);

    const verdicts = items.map((it) => it.errored ? { errored: true } : window.MRES_judgeProse(it.p, it.prose.claim));
    const scored = verdicts.filter((v) => !v.errored);
    const passN = scored.filter((v) => v.pass).length;
    const erroredN = verdicts.length - scored.length;
    const [agrees, setAgrees] = R.useState({});
    const setAgree = (i, val) => setAgrees((a) => Object.assign({}, a, { [i]: a[i] === val ? null : val }));
    const markedN = items.filter((it) => !it.errored && agrees[it.p.i]).length;
    const disagreeN = items.filter((it) => !it.errored && agrees[it.p.i] === "disagree").length;

    return h("div", { className: "judge-leg" },
      h("div", { className: "leg-divider" },
        h("span", null, "and the same charts, judged on a written summary")),

      // prose prompt
      h("div", { className: "cell" },
        h("div", { className: "cell-gutter" }, h("span", { className: "cell-tag" }, "prompt")),
        h("div", { className: "cell-main" },
          h("div", { className: "static-prompt" }, window.MRES_PROSE_PROMPT),
          h("div", { className: "run-note" }, "Free-text answers can't be matched to a golden — this is the judge's job · " + patients.length + " calls"))),

      // prose output
      h("div", { className: "cell" },
        h("div", { className: "cell-gutter" }, h("span", { className: "cell-tag" }, "output")),
        h("div", { className: "cell-main" },
          h("div", { className: "out-head" },
            h("span", null, "Output"),
            h("span", { className: "out-sub" }, patients.length + " patients · prose")),
          h("div", { className: "ocards" },
            items.map((it, idx) => h(ProseCard, { key: it.p.i, p: it.p, text: it.prose.text, delay: 300 + idx * 470, model, onOpenChart }))))),

      // judge eval
      h("div", { className: "cell" },
        h("div", { className: "cell-gutter" }, h("span", { className: "cell-tag" }, "eval")),
        h("div", { className: "cell-main" },
          h("div", { className: "eval-head" },
            h("div", { className: "seg" },
              h("span", { className: "seg-btn" }, "Golden answers"),
              h("span", { className: "seg-btn on" }, "LLM judge")),
            judged ? h("span", { className: "leg-done" }, "judged") : h("span", { className: "leg-judging" }, h("span", { className: "blink" }), "judging…")),
          h("div", { className: "eval-copy" }, "Describe what a correct answer must contain. The judge reads each chart and rules per patient."),
          h("textarea", { className: "criteria-in", value: window.MRES_PROSE_CRITERIA, spellCheck: false, readOnly: true }),
          judged && h("div", { className: "judge-rows" },
            items.map((it) => {
              const v = it.errored ? { errored: true } : window.MRES_judgeProse(it.p, it.prose.claim);
              return v.errored
                ? h("div", { className: "judge-row errored", key: it.p.i },
                    h("div", { className: "jr-head" },
                      h("span", { className: "jr-name" }, it.p.name.replace(/\d+/g, "")),
                      h("span", { className: "verdict v-err" }, h(I.bolt, null), "judge errored — not scored")),
                    h("div", { className: "jr-reason dim" }, "The judge call failed for this patient. It is left out of the number below — re-run the judge to score it."))
                : h("div", { className: "judge-row", key: it.p.i },
                    h("div", { className: "jr-head" },
                      h("span", { className: "jr-name" }, it.p.name.replace(/\d+/g, "")),
                      h("span", { className: "verdict " + (v.pass ? "v-pass" : "v-fail") }, h(v.pass ? I.check : I.dash, null), v.pass ? "pass" : "fail"),
                      h("span", { className: "agree-wrap" },
                        h("span", { className: "agree-label" }, "do you agree?"),
                        h("button", { className: "agree-btn" + (agrees[it.p.i] === "agree" ? " on yes" : ""), onClick: () => setAgree(it.p.i, "agree") }, "agree"),
                        h("button", { className: "agree-btn" + (agrees[it.p.i] === "disagree" ? " on no" : ""), onClick: () => setAgree(it.p.i, "disagree") }, "disagree"))),
                    h("div", { className: "jr-reason" }, v.reason));
            })),
          judged && h("div", { className: "overall" },
            h("span", { className: "ov-num" }, passN + "/" + scored.length), " pass",
            h("span", { className: "ov-note" }, " · judged by " + model + (erroredN ? " · " + erroredN + " not scored" : ""))),
          judged && markedN > 0 && h("div", { className: "yvj-line" },
            "You disagreed with the judge on " + disagreeN + " of " + scored.length + "."))));
  }

  window.MRES_WorkedJudgeLeg = WorkedJudgeLeg;
})();
