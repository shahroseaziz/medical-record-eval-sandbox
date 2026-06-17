/* Explore-the-data drawer: patient table -> parsed chart -> raw XML toggle. */
(function () {
  const R = React;
  const h = R.createElement;
  const D = window.MRES_DATA;
  const I = window.MRES_ICON;

  function TrendTag({ trend }) {
    const sym = trend === "improving" ? "↓" : trend === "worsening" ? "↑" : "→";
    return h("span", { className: "trend trend-" + trend }, sym + " " + trend);
  }

  function Spark({ series }) {
    const vals = series.map((s) => s.value);
    const min = Math.min(...vals), max = Math.max(...vals);
    const span = max - min || 1;
    return h("span", { className: "spark" },
      series.map((s, i) =>
        h("span", { key: i, className: "spark-bar", title: s.value + " · " + s.date,
          style: { height: (4 + ((s.value - min) / span) * 11) + "px" } })
      )
    );
  }

  function ChartView({ p }) {
    const chart = D.chart(p);
    return h("div", { className: "chart-body" },
      h("section", { className: "chart-sec" },
        h("div", { className: "sec-head" }, h("span", { className: "sec-title" }, "Problems"),
          h("span", { className: "sec-count" }, chart.problems.length)),
        h("div", { className: "rows" },
          chart.problems.map((pr, i) =>
            h("div", { className: "prob-row", key: i },
              h("span", { className: "code" }, pr.code),
              h("span", { className: "prob-label" }, pr.label),
              h("span", { className: "prob-meta" }, "onset " + pr.onset),
              h("span", { className: "pill pill-active" }, pr.status))))),

      h("section", { className: "chart-sec" },
        h("div", { className: "sec-head" }, h("span", { className: "sec-title" }, "Medications"),
          h("span", { className: "sec-count" }, chart.medications.length)),
        h("div", { className: "rows" },
          chart.medications.map((m, i) =>
            h("div", { className: "med-row", key: i },
              h("span", { className: "med-name" }, m.name),
              h("span", { className: "med-sig" }, m.sig),
              h("span", { className: "med-meta" }, "since " + m.start))))),

      h("section", { className: "chart-sec" },
        h("div", { className: "sec-head" }, h("span", { className: "sec-title" }, "Labs"),
          h("span", { className: "sec-count" }, chart.labs.length)),
        h("div", { className: "lab-table" },
          chart.labs.map((l, i) =>
            h("div", { className: "lab-row", key: i },
              h("div", { className: "lab-main" },
                h("span", { className: "lab-name" }, l.name),
                h("span", { className: "lab-ref" }, "ref " + l.ref + " " + l.unit)),
              h("div", { className: "lab-val" },
                h("span", { className: "lab-num" }, l.value + " "),
                h("span", { className: "lab-unit" }, l.unit)),
              h(Spark, { series: l.series }),
              h(TrendTag, { trend: l.trend }),
              h("span", { className: "lab-date" }, l.date))))),

      h("section", { className: "chart-sec" },
        h("div", { className: "sec-head" }, h("span", { className: "sec-title" }, "Encounters"),
          h("span", { className: "sec-count" }, chart.encounters.length)),
        h("div", { className: "rows" },
          chart.encounters.map((e, i) =>
            h("div", { className: "enc-row", key: i },
              h("span", { className: "enc-date" }, e.date),
              h("span", { className: "enc-type" }, e.type),
              h("span", { className: "enc-prov" }, e.provider)))))
    );
  }

  function RawView({ p }) {
    const chart = D.chart(p);
    const xml = D.xml(p, chart);
    return h("pre", { className: "raw-xml" }, xml);
  }

  function Drawer({ open, patientIndex, onClose, onPick, raw, setRaw }) {
    const p = patientIndex != null ? D.patients[patientIndex] : null;
    const [q, setQ] = React.useState("");
    const list = React.useMemo(() => {
      const s = q.trim().toLowerCase();
      return D.patients.filter((x) => !s || x.name.toLowerCase().includes(s) || x.mrn.toLowerCase().includes(s));
    }, [q]);

    return h("aside", { className: "drawer" + (open ? " open" : ""), "aria-hidden": !open },
      h("div", { className: "drawer-top" },
        p
          ? h("button", { className: "back-btn", onClick: () => onPick(null) }, h(I.chevL, null), "All patients")
          : h("div", { className: "drawer-title" }, h(I.table, null), "Corpus"),
        h("button", { className: "icon-btn", onClick: onClose, title: "Close" }, h(I.x, null))
      ),

      p
        ? h("div", { className: "drawer-scroll" },
            h("div", { className: "chart-head" },
              h("div", null,
                h("div", { className: "ch-name" }, p.name),
                h("div", { className: "ch-meta" }, p.mrn + " · " + p.age + " " + (p.sex === "M" ? "M" : "F") + " · " + p.chartKB + " KB")),
              h("div", { className: "seg" },
                h("button", { className: "seg-btn" + (!raw ? " on" : ""), onClick: () => setRaw(false) }, "Parsed"),
                h("button", { className: "seg-btn" + (raw ? " on" : ""), onClick: () => setRaw(true) }, "Raw XML"))),
            raw ? h(RawView, { p }) : h(ChartView, { p }))
        : h("div", { className: "drawer-scroll" },
            h("div", { className: "corpus-note" },
              D.count + " synthetic patients · Synthea C-CDA · ",
              h("span", { className: "no-phi" }, "no PHI")),
            h("div", { className: "search" },
              h("input", { className: "search-in", placeholder: "Filter by name or MRN…", value: q, onChange: (e) => setQ(e.target.value) })),
            h("div", { className: "ptable" },
              h("div", { className: "pt-head" },
                h("span", null, "Patient"),
                h("span", { className: "num" }, "Age"),
                h("span", { className: "num" }, "Sex"),
                h("span", { className: "num" }, "Cond"),
                h("span", { className: "num" }, "Meds"),
                h("span", { className: "num" }, "Chart")),
              list.map((x) => {
                const chart = D.chart(x);
                return h("button", { className: "pt-row", key: x.i, onClick: () => onPick(x.i) },
                  h("span", { className: "pt-name" },
                    h("span", { className: "pt-nm" }, x.name),
                    h("span", { className: "pt-mrn" }, x.mrn)),
                  h("span", { className: "num" }, x.age),
                  h("span", { className: "num" }, x.sex),
                  h("span", { className: "num" }, x.conds.length),
                  h("span", { className: "num" }, chart.medications.length),
                  h("span", { className: "num pt-kb" }, x.chartKB + "K"));
              })))
    );
  }

  window.MRES_Drawer = Drawer;
})();
