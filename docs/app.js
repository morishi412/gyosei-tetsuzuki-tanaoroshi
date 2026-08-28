/* =========================================================
   行政手続等の棚卸調査ダッシュボード  app.js
   - sql.js (SQLite/WASM) に gzip 圧縮した DB を読み込み
   - 概要タブ：集計グラフ / 検索タブ：全文的な絞り込み
   ========================================================= */
"use strict";

const DB_URL = "procedures.db.gz";
let db = null;

/* ---- 詳細ドロワーの表示グループ定義 ---- */
const GROUPS = [
  ["基本情報", ["q0", "q1", "q2", "q3_1", "q3_2", "q3_3", "q3_4"]],
  ["手続の性質", ["q4", "q5", "q6", "q7", "q8", "q9", "q10", "q11", "q12", "q13"]],
  ["オンライン化", ["q14_1", "q14_2", "q14_3", "q14_4", "q15"]],
  ["手数料等", ["q16_1", "q16_2", "q16_3", "q16_4"]],
  ["処理期間", ["q17_1", "q17_2"]],
  ["情報システム", ["q18_1", "q18_2", "q18_3"]],
  ["年間手続件数", ["q19_1", "q19_2", "q19_3"]],
  ["申請内容・添付書類", ["q20", "q21_1", "q21_2", "q21_3", "q21_4", "q21_5", "q21_6"]],
  ["ライフイベント・士業", ["q22_1", "q22_2", "q23", "q24", "q25"]],
];

const EVENTS_PERSON = ["妊娠", "出生・こども", "引越し", "就職・転職", "結婚・離婚",
  "自動車の購入・保有", "住宅の購入・保有", "介護", "医療・健康", "税金",
  "年金の受給", "死亡・相続", "その他イベント(個人)", "その他(個人も法人にもあてはまらない)"];
const EVENTS_CORP = ["法人の設立", "法人の情報変更・役員変更", "職員の採用・退職", "入札・契約",
  "事務所の新設・移転", "新しい事業の開始", "法人の合併・分割", "法人の承継・廃業",
  "定期的な報告等", "作業ごとの報告等", "その他イベント(法人)"];
const SHIGYO = ["弁護士", "司法書士", "行政書士", "税理士", "社会保険労務士", "公認会計士",
  "弁理士", "土地家屋調査士", "海事代理士", "中小企業診断士", "医療系職種", "その他", "士業が介在しない"];

/* 年間手続件数の区分（drill-down 用に固定SQLで保持） */
const VOLUME_BANDS = [
  ["100万回以上", "total_count >= 1000000"],
  ["10万〜100万回", "total_count >= 100000 AND total_count < 1000000"],
  ["1万〜10万回", "total_count >= 10000 AND total_count < 100000"],
  ["1,000〜1万回", "total_count >= 1000 AND total_count < 10000"],
  ["100〜1,000回", "total_count >= 100 AND total_count < 1000"],
  ["10〜100回", "total_count >= 10 AND total_count < 100"],
  ["1〜10回", "total_count >= 1 AND total_count < 10"],
  ["0回", "total_count = 0"],
  ["不明・未回答", "total_count IS NULL"],
];

/* 手続主体(q5)・受け手(q6) の選択肢は複合(OR)値を含むため、
   「その立場を含むすべての回答値」をまとめて検索できるようにする。
   キー = 立場、値 = 該当する回答コード（値は "コード ラベル" 形式で格納されている） */
const ROLE_ELEMENTS = [
  ["国", ["1", "4-1", "4-3", "4-4"]],
  ["独立行政法人等", ["2", "4-1", "4-2", "4-4"]],
  ["地方等", ["3", "4-2", "4-3", "4-4"]],
  ["国民等", ["5", "7"]],
  ["民間事業者等", ["6", "7"]],
];

let COLS = {}; // key -> label

/* ---------- ユーティリティ ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nf = (n) => (n == null ? "—" : Number(n).toLocaleString("ja-JP"));

function all(sql, params) {
  const st = db.prepare(sql);
  if (params) st.bind(params);
  const rows = [];
  while (st.step()) rows.push(st.getAsObject());
  st.free();
  return rows;
}
function one(sql, params) {
  const r = all(sql, params);
  return r[0] || {};
}

/* ---------- 起動 ---------- */
async function boot() {
  const msg = $("#loaderMsg");
  try {
    msg.textContent = "ライブラリを初期化しています…";
    const SQL = await initSqlJs({ locateFile: (f) => "vendor/" + f });

    msg.textContent = "データベース（約8MB）をダウンロードしています…";
    const resp = await fetch(DB_URL);
    if (!resp.ok) throw new Error("DB取得に失敗しました (" + resp.status + ")");

    const raw = new Uint8Array(await resp.arrayBuffer());
    const isGzip = raw[0] === 0x1f && raw[1] === 0x8b;
    let bytes;
    if (!isGzip) {
      // ホスト側(GitHub Pages 等)が転送時に自動解凍し、生の SQLite が届いたケース
      bytes = raw;
    } else if (typeof DecompressionStream === "function") {
      const stream = new Response(raw).body.pipeThrough(new DecompressionStream("gzip"));
      bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    } else if (window.pako) {
      bytes = window.pako.ungzip(raw);
    } else {
      throw new Error("この環境では gzip を解凍できません（DecompressionStream 非対応）");
    }

    msg.textContent = "データベースを構築しています…";
    db = new SQL.Database(bytes);

    COLS = {};
    (await fetch("columns.json").then((r) => r.json())).forEach((c) => (COLS[c.key] = c.label));

    initTabs();
    buildOverview();
    buildSearchUI();

    $("#loader").classList.add("is-hidden");
  } catch (e) {
    console.error(e);
    $("#loader").innerHTML =
      '<p style="max-width:520px">読み込みに失敗しました。<br><br>' +
      "このページは <code>file://</code> では動作しません。付属の <code>start-server.bat</code> を実行し、" +
      "表示された <code>http://localhost:8000/</code> を開いてください。<br><br>" +
      "<small>" + esc(e.message) + "</small></p>";
  }
}

/* ---------- タブ ---------- */
function selectTab(tabId) {
  $$(".tab").forEach((x) => x.setAttribute("aria-selected", x.id === tabId));
  const target = $("#" + tabId).getAttribute("aria-controls");
  $$(".panel").forEach((p) => p.classList.toggle("is-active", p.id === target));
}
function initTabs() {
  $$(".tab").forEach((t) => t.addEventListener("click", () => selectTab(t.id)));
}

/* ========================================================
   概要タブ
   ======================================================== */
function statusClass(code) {
  if (!code) return "other";
  if (code.startsWith("1")) return "on";
  if (code.startsWith("2")) return "off";
  if (code.startsWith("3")) return "exempt";
  return "other";
}
function shortStatus(code) {
  if (!code) return "未回答";
  return code.replace(/^\d+\s*/, "");
}

function buildOverview() {
  const total = one("SELECT COUNT(*) n FROM procedures").n;
  const byStatus = all(
    "SELECT q14_1 k, COUNT(*) n FROM procedures GROUP BY q14_1 ORDER BY n DESC");
  const impl = byStatus.filter((r) => (r.k || "").startsWith("1")).reduce((a, b) => a + b.n, 0);
  const notImpl = byStatus.filter((r) => (r.k || "").startsWith("2")).reduce((a, b) => a + b.n, 0);
  const exempt = byStatus.filter((r) => (r.k || "").startsWith("3")).reduce((a, b) => a + b.n, 0);
  const other = total - impl - notImpl - exempt;
  const pc = (n) => ((n / total) * 100).toFixed(1);

  const sumTotal = one("SELECT SUM(total_count) s FROM procedures WHERE total_count IS NOT NULL").s || 0;

  const kpis = [
    { l: "手続の種類数", v: nf(total), s: "調査対象の全手続", drill: {} },
    { l: "オンライン化 実施済", v: nf(impl) + "<span> 種類</span>", s: pc(impl) + "％", accent: true,
      drill: { form: { "#f-online": "1 実施済" } } },
    { l: "オンライン化 未実施", v: nf(notImpl) + "<span> 種類</span>", s: pc(notImpl) + "％",
      drill: { form: { "#f-online": "2 未実施" } } },
    { l: "適用除外・その他", v: nf(exempt + other) + "<span> 種類</span>", s: pc(exempt + other) + "％",
      drill: { extra: mkExtra("q14_1 LIKE '3%' OR q14_1 LIKE '4%' OR q14_1 IS NULL OR q14_1=''",
        "オンライン化状況：適用除外・その他・未回答") } },
    { l: "年間手続件数（回答合計）", v: nf(sumTotal), s: "「19-1 総手続件数」の合計" },
  ];
  $("#kpiGrid").innerHTML = kpis.map((k, i) =>
    `<div class="kpi${k.accent ? " kpi--accent" : ""}${k.drill ? " is-clickable" : ""}"
       ${k.drill ? `data-drill="${i}" tabindex="0" role="button"` : ""}>
       <p class="kpi__label">${k.l}</p>
       <p class="kpi__value">${k.v}</p>
       <p class="kpi__sub">${k.s}</p>
     </div>`).join("");
  wireDrill("#kpiGrid [data-drill]", (el) => kpis[+el.dataset.drill].drill);

  $("#kpiNote").textContent =
    "各カードやグラフの項目をクリックすると、その条件で「手続を検索」タブに絞り込んで表示します。" +
    "集計値は読み込んだデータからの再集計のため、端数処理等により公表値（PDF）と完全には一致しない場合があります。";

  /* ドーナツ：オンライン化状況 */
  const donutData = [
    ["実施済", impl, "#0017c1", { form: { "#f-online": "1 実施済" } }],
    ["未実施", notImpl, "#e0603a", { form: { "#f-online": "2 未実施" } }],
    ["適用除外", exempt, "#b7791f", { form: { "#f-online": "3 適用除外" } }],
    ["その他・未回答", other, "#9aa0a6",
      { extra: mkExtra("q14_1 LIKE '4%' OR q14_1 IS NULL OR q14_1=''", "オンライン化状況：その他・未回答") }],
  ];
  drawDonut($("#donutOnline"), donutData.map((d) => d[1]), donutData.map((d) => d[2]));
  $("#donutOnlineLegend").innerHTML = donutData.map(([l, n, c], i) =>
    `<li class="is-clickable" data-drill="${i}" tabindex="0" role="button"><i style="background:${c}"></i>${l} <b>${nf(n)}</b>（${pc(n)}％）</li>`).join("");
  wireDrill("#donutOnlineLegend [data-drill]", (el) => donutData[+el.dataset.drill][3]);

  /* 要因 */
  const reason = all(
    `SELECT q14_2 k, COUNT(*) n FROM procedures
     WHERE q14_1 NOT LIKE '1%' AND q14_2 IS NOT NULL AND q14_2<>''
     GROUP BY q14_2 ORDER BY n DESC`);
  const rMax = Math.max(...reason.map((r) => r.n));
  $("#barsReason").innerHTML = reason.map((r, i) =>
    barRow(shortStatus(r.k).replace(/（.*?）/g, ""), r.n / rMax, nf(r.n), false, i)).join("");
  wireDrill("#barsReason [data-drill]", (el) => {
    const r = reason[+el.dataset.drill];
    return { extra: mkExtra("q14_1 NOT LIKE '1%' AND q14_2 = $dv",
      "未オンライン化の要因：" + shortStatus(r.k), { $dv: r.k }) };
  });

  /* 府省庁別 */
  const minRows = all(
    `SELECT q1 k, COUNT(*) n, SUM(CASE WHEN q14_1 LIKE '1%' THEN 1 ELSE 0 END) impl
     FROM procedures WHERE q1 IS NOT NULL AND q1<>''
     GROUP BY q1 ORDER BY n DESC`);
  $("#barsMinistry").innerHTML = minRows.map((r, i) => {
    const rate = r.impl / r.n;
    return `<li class="is-clickable" data-drill="${i}" tabindex="0" role="button">
      <span class="bars__name" title="${esc(r.k)}">${esc(r.k)}</span>
      <span class="bars__track"><span class="bars__fill" style="width:${(rate * 100).toFixed(1)}%"></span></span>
      <span class="bars__val">${(rate * 100).toFixed(0)}%<br><small style="font-weight:400;color:var(--ink-sub)">${nf(r.n)}</small></span>
    </li>`;
  }).join("");
  wireDrill("#barsMinistry [data-drill]", (el) =>
    ({ form: { "#f-ministry": minRows[+el.dataset.drill].k } }));

  /* 類型別 */
  const typeRows = all(
    `SELECT q4 k, COUNT(*) n, SUM(CASE WHEN q14_1 LIKE '1%' THEN 1 ELSE 0 END) impl
     FROM procedures WHERE q4 IS NOT NULL AND q4<>'' GROUP BY q4 ORDER BY n DESC`);
  $("#barsType").innerHTML = typeRows.map((r, i) =>
    barRow(r.k, r.impl / r.n, `${((r.impl / r.n) * 100).toFixed(0)}% / ${nf(r.n)}`, false, i)).join("");
  wireDrill("#barsType [data-drill]", (el) =>
    ({ form: { "#f-type": typeRows[+el.dataset.drill].k } }));

  /* 件数規模別 */
  $("#barsVolume").innerHTML = VOLUME_BANDS.map(([label, cond], i) => {
    const r = one(
      `SELECT COUNT(*) n, SUM(CASE WHEN q14_1 LIKE '1%' THEN 1 ELSE 0 END) impl
       FROM procedures WHERE ${cond}`);
    const rate = r.n ? r.impl / r.n : 0;
    return `<li class="is-clickable" data-drill="${i}" tabindex="0" role="button">
      <span class="bars__name">${label}</span>
      <span class="bars__track"><span class="bars__fill" style="width:${(rate * 100).toFixed(1)}%"></span></span>
      <span class="bars__val">${(rate * 100).toFixed(0)}%<br><small style="font-weight:400;color:var(--ink-sub)">${nf(r.n)}</small></span>
    </li>`;
  }).join("");
  wireDrill("#barsVolume [data-drill]", (el) => {
    const [label, cond] = VOLUME_BANDS[+el.dataset.drill];
    return { extra: mkExtra(cond, "年間手続件数：" + label) };
  });

  /* 推移（出典 p.15 の公表値。令和6年度は概要 p.3 の記載から算出） */
  const r6rate = ((impl - 2195) / 75071) * 100;
  const trend = [
    ["令和元年度調査", 12.0, "約12.0％"],
    ["令和6年度調査", r6rate, r6rate.toFixed(1) + "％（概算）"],
    ["令和7年度調査", 53.7, "53.7％"],
  ];
  $("#barsTrend").innerHTML = trend.map(([y, v, lbl]) =>
    barRow(y, v / 100, lbl)).join("");
}

function barRow(name, ratio, val, sub, drillIdx) {
  const w = Math.max(0, Math.min(1, ratio)) * 100;
  const d = drillIdx != null
    ? ` class="is-clickable" data-drill="${drillIdx}" tabindex="0" role="button"` : "";
  return `<li${d}>
    <span class="bars__name" title="${esc(name)}">${esc(name)}</span>
    <span class="bars__track"><span class="bars__fill${sub ? " bars__fill--sub" : ""}" style="width:${w.toFixed(1)}%"></span></span>
    <span class="bars__val">${esc(val)}</span>
  </li>`;
}

/* ---------- ドリルダウン ---------- */
function mkExtra(sql, label, params) {
  return { sql, label, params: params || {} };
}
function wireDrill(sel, getSpec) {
  $$(sel).forEach((el) => {
    const go = () => { const s = getSpec(el); if (s) applyDrill(s); };
    el.addEventListener("click", go);
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); }
    });
  });
}
function applyDrill(spec) {
  $("#searchForm").reset();
  state.extra = [];
  if (spec && spec.form) {
    for (const [id, val] of Object.entries(spec.form)) {
      const el = $(id);
      if (el) el.value = val;
    }
  }
  if (spec && spec.extra) state.extra = [spec.extra];
  state.page = 0;
  state.sort = "total_count";
  state.dir = "DESC";
  if ($("#f-sort")) $("#f-sort").value = "total_count|DESC";
  selectTab("tab-search");
  runSearch();
  requestAnimationFrame(() =>
    $("#panel-search").scrollIntoView({ behavior: "smooth", block: "start" }));
}

function drawDonut(svg, values, colors) {
  const totalV = values.reduce((a, b) => a + b, 0) || 1;
  const R = 15.915, C = 2 * Math.PI * R;
  let offset = 25; // 12時方向から開始
  svg.innerHTML =
    `<circle cx="21" cy="21" r="${R}" fill="none" stroke="#eee" stroke-width="6"></circle>` +
    values.map((v, i) => {
      const len = (v / totalV) * 100;
      const dash = `${(len / 100) * C} ${C}`;
      const dashoffset = (offset / 100) * C;
      offset += len;
      return `<circle cx="21" cy="21" r="${R}" fill="none" stroke="${colors[i]}"
        stroke-width="6" stroke-dasharray="${dash}" stroke-dashoffset="${-dashoffset}"
        transform="rotate(-90 21 21)"></circle>`;
    }).join("");
}

/* ========================================================
   検索タブ
   ======================================================== */
const state = {
  page: 0, perPage: 1000, sort: "total_count", dir: "DESC",
  rows: null, count: 0, extra: [],
  selCols: ["q4", "q14_1", "q19_1"], colStart: 0,
  cellPct: true, freq: {}, _clause: "", _params: {},
};

function fillSelect(sel, items, allLabel) {
  sel.innerHTML =
    `<option value="">${allLabel || "すべて"}</option>` +
    items.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join("");
}

/* 手続主体・受け手用：「立場を含む」グループ + 回答値そのままグループ */
function fillRoleSelect(sel, rawValues) {
  const elem = ROLE_ELEMENTS.map(([k]) =>
    `<option value="elem|${esc(k)}">${esc(k)} を含む</option>`).join("");
  const raw = rawValues.map((v) =>
    `<option value="raw|${esc(v)}">${esc(v)}</option>`).join("");
  sel.innerHTML =
    `<option value="">すべて</option>` +
    `<optgroup label="この立場を含む（複合選択肢もまとめて）">${elem}</optgroup>` +
    `<optgroup label="回答値そのまま">${raw}</optgroup>`;
}

/* 立場ラベルの短縮（"1 国" → "国"） */
const shortRole = (s) => String(s || "").replace(/^[\d-]+\s*/, "");

function buildSearchUI() {
  const distinct = (k) =>
    all(`SELECT DISTINCT "${k}" v FROM procedures WHERE "${k}" IS NOT NULL AND "${k}"<>'' ORDER BY v`)
      .map((r) => r.v);

  fillSelect($("#f-ministry"), distinct("q1"));
  fillSelect($("#f-type"), distinct("q4"));
  fillSelect($("#f-online"), distinct("q14_1"));
  fillRoleSelect($("#f-subject"), distinct("q5"));
  fillRoleSelect($("#f-receiver"), distinct("q6"));
  fillSelect($("#f-fee"), distinct("q16_1"));
  fillSelect($("#f-common"), distinct("q11"));
  fillSelect($("#f-event-p"), EVENTS_PERSON);
  fillSelect($("#f-event-c"), EVENTS_CORP);
  fillSelect($("#f-shigyo"), SHIGYO);
  $("#f-sort").innerHTML = `
    <option value="total_count|DESC">総手続件数（多い順）</option>
    <option value="total_count|ASC">総手続件数（少ない順）</option>
    <option value="online_count|DESC">オンライン手続件数（多い順）</option>
    <option value="q0|ASC">手続ID（昇順）</option>
    <option value="q1|ASC">所管府省庁</option>`;

  $("#searchForm").addEventListener("submit", (e) => {
    e.preventDefault();
    state.page = 0;
    runSearch();
  });
  $("#resetBtn").addEventListener("click", () => {
    $("#searchForm").reset();
    state.extra = [];
    state.page = 0;
    runSearch();
  });
  $("#csvBtn").addEventListener("click", exportCsv);

  $("#f-sort").addEventListener("change", () => {
    const [c, d] = $("#f-sort").value.split("|");
    state.sort = c;
    state.dir = d;
    state.page = 0;
    runSearch();
  });

  // 表示列の設定を復元
  try {
    const saved = JSON.parse(localStorage.getItem("selCols") || "null");
    if (Array.isArray(saved)) {
      const ok = saved.filter((k) => COLS[k] && !FIXED_COLS.includes(k));
      if (ok.length) state.selCols = ok;
      else if (saved.length === 0) state.selCols = [];
    }
  } catch (e) {}

  $("#colCfgClose").addEventListener("click", closeColConfig);
  $("#colCfgBackdrop").addEventListener("click", closeColConfig);
  $("#colCfgApply").addEventListener("click", applyColConfig);
  $("#colCfgReset").addEventListener("click", () => { cfgSel = [...DEFAULT_SEL]; renderCfgBody(); });

  try { state.cellPct = localStorage.getItem("cellPct") !== "0"; } catch (e) {}
  $("#cellPctToggle").checked = state.cellPct;
  $("#cellPctToggle").addEventListener("change", (e) => {
    state.cellPct = e.target.checked;
    try { localStorage.setItem("cellPct", state.cellPct ? "1" : "0"); } catch (err) {}
    $$("#resultBody td[data-pct]").forEach((td) => {
      td.removeAttribute("data-pct");
      td.title = td.dataset.full || "";
    });
  });

  $("#drawerClose").addEventListener("click", closeDrawer);
  $("#drawerBackdrop").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    closeDrawer();
    closeColConfig();
  });

  let rzTimer;
  window.addEventListener("resize", () => {
    clearTimeout(rzTimer);
    rzTimer = setTimeout(() => {
      if ($("#panel-search").classList.contains("is-active")) renderTable();
    }, 200);
  });

  runSearch();
}

function buildWhere() {
  const w = [], p = {};
  const add = (id, col) => {
    const v = $(id).value;
    if (v) { w.push(`"${col}" = $${col}`); p["$" + col] = v; }
  };
  add("#f-ministry", "q1");
  add("#f-type", "q4");
  add("#f-online", "q14_1");
  add("#f-fee", "q16_1");
  add("#f-common", "q11");

  // 手続主体 / 受け手：raw|完全一致 または elem|立場を含む(OR)
  const addRole = (id, col) => {
    const v = $(id).value;
    if (!v) return;
    const bar = v.indexOf("|");
    const mode = v.slice(0, bar), arg = v.slice(bar + 1);
    if (mode === "raw") {
      w.push(`"${col}" = $${col}`);
      p["$" + col] = arg;
    } else if (mode === "elem") {
      const found = ROLE_ELEMENTS.find((e) => e[0] === arg);
      if (found) {
        const ors = found[1].map((code, i) => {
          p[`$${col}_r${i}`] = code + " %";
          return `"${col}" LIKE $${col}_r${i}`;
        });
        w.push("(" + ors.join(" OR ") + ")");
      }
    }
  };
  addRole("#f-subject", "q5");
  addRole("#f-receiver", "q6");

  const like = (id, col) => {
    const v = $(id).value;
    if (v) { w.push(`"${col}" LIKE $lk_${col}`); p["$lk_" + col] = "%" + v + "%"; }
  };
  like("#f-event-p", "q22_1");
  like("#f-event-c", "q22_2");
  like("#f-shigyo", "q23");

  const kw = $("#q").value.trim();
  if (kw) {
    kw.split(/\s+/).forEach((term, i) => {
      w.push(`search_text LIKE $kw${i}`);
      p["$kw" + i] = "%" + term + "%";
    });
  }

  (state.extra || []).forEach((ex) => {
    w.push("(" + ex.sql + ")");
    Object.assign(p, ex.params);
  });

  return { clause: w.length ? "WHERE " + w.join(" AND ") : "", params: p };
}

/* ---------- 一覧の表示列 ----------
   FIXED_COLS … 常に左端に固定表示（所管府省庁まで）
   state.selCols … その右側に表示する列（設定画面で選択、canonical順で保持）
   state.colStart … 追加列の表示ウィンドウの開始位置。◀▶で移動 */
const FIXED_COLS = ["q0", "q2", "q1"];
const DEFAULT_SEL = ["q4", "q14_1", "q19_1"];
const NUM_COLS = ["q0", "q19_1", "q19_2", "q19_3"];

/* 手続名セルの3行目に表示する「主体 → 受け手」 */
function flowLine(row) {
  const s = shortRole(row.q5), r = shortRole(row.q6);
  if (!s && !r) return "";
  return `${s || "―"} → ${r || "―"}`;
}

/* 表示列 → 並び替えに使う実カラム（件数系は数値化済みカラムで並べる） */
function sortKeyOf(k) {
  return { q19_1: "total_count", q19_2: "online_count", q19_3: "offline_count" }[k] || k;
}
function colWindow() {
  return window.matchMedia("(max-width: 700px)").matches ? 2 : 3;
}
function visibleCols() {
  const win = colWindow();
  const extra = state.selCols;
  const maxStart = Math.max(0, extra.length - win);
  state.colStart = Math.max(0, Math.min(state.colStart, maxStart));
  return {
    keys: [...FIXED_COLS, ...extra.slice(state.colStart, state.colStart + win)],
    start: state.colStart, win, total: extra.length,
  };
}

function runSearch() {
  const { clause, params } = buildWhere();
  state._clause = clause;
  state._params = params;
  state.freq = {};                 // セル割合ツールチップ用キャッシュを破棄
  state.count = one(`SELECT COUNT(*) n FROM procedures ${clause}`, params).n;

  const sortCol = /^[a-z0-9_]+$/.test(state.sort) ? state.sort : "total_count";
  const nullsLast = ["total_count", "online_count", "offline_count"].includes(sortCol)
    ? `"${sortCol}" IS NULL, ` : "";

  const need = new Set(["rowid", "q0", "q1", "q2", "q3_1", "q5", "q6",
    "total_count", "online_count", "offline_count", ...FIXED_COLS, ...state.selCols]);
  const selectList = [...need].map((k) => (k === "rowid" ? "rowid" : `"${k}"`)).join(",");

  state.rows = all(
    `SELECT ${selectList}
     FROM procedures ${clause}
     ORDER BY ${nullsLast}"${sortCol}" ${state.dir}, q0+0
     LIMIT ${state.perPage} OFFSET ${state.page * state.perPage}`,
    params);

  renderResults();
}

const CHIP_FIELDS = [
  ["#f-ministry", "所管府省庁"], ["#f-type", "手続類型"], ["#f-online", "オンライン化"],
  ["#f-subject", "手続主体"], ["#f-receiver", "受け手"], ["#f-fee", "手数料"],
  ["#f-common", "府省共通"], ["#f-event-p", "イベント(個人)"], ["#f-event-c", "イベント(法人)"],
  ["#f-shigyo", "士業"],
];
function renderChips() {
  const chips = [];
  CHIP_FIELDS.forEach(([id, label]) => {
    const v = $(id).value;
    if (!v) return;
    let disp = v;
    if (id === "#f-subject" || id === "#f-receiver") {
      const bar = v.indexOf("|");
      disp = v.slice(0, bar) === "elem"
        ? v.slice(bar + 1) + " を含む"
        : shortRole(v.slice(bar + 1));
    }
    chips.push({ t: `${label}：${disp}`, clear: () => { $(id).value = ""; } });
  });
  const kw = $("#q").value.trim();
  if (kw) chips.push({ t: `キーワード：${kw}`, clear: () => { $("#q").value = ""; } });
  (state.extra || []).forEach((ex) =>
    chips.push({ t: ex.label, clear: () => { state.extra = []; } }));

  const box = $("#activeFilters");
  if (!chips.length) { box.innerHTML = ""; return; }
  box.innerHTML =
    `<span class="chips__label">絞り込み中：</span>` +
    chips.map((c, i) =>
      `<span class="chip">${esc(c.t)}<button data-i="${i}" aria-label="この条件を解除">×</button></span>`).join("") +
    `<button class="chip-clear" id="clearAllChips">すべて解除</button>`;
  $$("#activeFilters .chip button").forEach((b) =>
    b.addEventListener("click", () => {
      chips[+b.dataset.i].clear();
      state.page = 0;
      runSearch();
    }));
  $("#clearAllChips").addEventListener("click", () => {
    $("#searchForm").reset();
    state.extra = [];
    state.page = 0;
    runSearch();
  });
}

function renderResults() {
  renderChips();
  $("#resultCount").textContent = nf(state.count);
  const from = state.count ? state.page * state.perPage + 1 : 0;
  const to = Math.min(state.count, (state.page + 1) * state.perPage);
  $("#resultRange").textContent = state.count
    ? (state.count > state.perPage
        ? `${nf(from)}–${nf(to)} 件目を表示（1画面 最大 ${nf(state.perPage)} 件・ページ送りで続きを表示）`
        : `${nf(from)}–${nf(to)} 件目を表示`)
    : "";

  renderTable();

  if (!renderResults._bound) {
    $("#resultBody").addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-id]");
      if (tr) openDrawer(+tr.dataset.id);
    });
    $("#resultBody").addEventListener("mouseover", cellPctTooltip);
    renderResults._bound = true;
  }

  renderPager();
}

/* 実験：セルにカーソルを合わせると、その値が検索結果全体の何％かをツールチップ表示 */
function columnFreq(key) {
  if (state.freq[key]) return state.freq[key];
  const m = new Map();
  all(`SELECT "${key}" v, COUNT(*) c FROM procedures ${state._clause} GROUP BY "${key}"`, state._params)
    .forEach((r) => m.set(r.v == null ? "" : String(r.v), r.c));
  state.freq[key] = m;
  return m;
}
function cellPctTooltip(e) {
  if (!state.cellPct) return;
  const td = e.target.closest("td");
  const tr = e.target.closest("tr[data-id]");
  if (!td || !tr || td.dataset.pct) return;
  const idx = [...tr.children].indexOf(td);
  const key = visibleCols().keys[idx];
  if (!key || key === "q0" || key === "q2") return;         // ID・手続名は割合の意味が薄い
  const row = state.rows.find((r) => r.rowid === +tr.dataset.id);
  if (!row) return;
  const val = row[key] == null ? "" : String(row[key]);
  const cnt = columnFreq(key).get(val) || 0;
  const pct = state.count ? (cnt / state.count) * 100 : 0;
  let shown = val === "" ? "（未回答）" : val;
  if (/^(q19_1|q19_2|q19_3)$/.test(key) && /^\d+$/.test(val.replace(/,/g, "")))
    shown = nf(+val.replace(/,/g, "")) + " 回";
  const stat = `${COLS[key] || key}「${shown}」\n検索結果 ${nf(state.count)} 件中 ${nf(cnt)} 件（${pct.toFixed(1)}%）`;
  td.title = td.dataset.full ? stat + "\n― " + td.dataset.full : stat;
  td.dataset.pct = "1";
}

/* ヘッダー・本体・列ナビをまとめて再描画（再クエリなし） */
function renderTable() {
  if (!state.rows) return;
  const { keys, start, win, total } = visibleCols();
  renderColNav(start, win, total);

  $("#resultHead").innerHTML = "<tr>" + keys.map((k) => {
    const sk = sortKeyOf(k);
    const arrow = state.sort === sk ? (state.dir === "DESC" ? " ▼" : " ▲") : "";
    const cls = [FIXED_COLS.includes(k) ? "col-fixed" : "", NUM_COLS.includes(k) ? "num" : ""]
      .filter(Boolean).join(" ");
    const caption = k === "q2"
      ? `<small class="th-cap">法令名／手続主体 → 受け手</small>` : "";
    return `<th data-sort="${sk}"${cls ? ` class="${cls}"` : ""}>${esc(COLS[k])}${arrow}${caption}</th>`;
  }).join("") + "</tr>";

  $$("#resultHead th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const col = th.dataset.sort;
      if (state.sort === col) state.dir = state.dir === "DESC" ? "ASC" : "DESC";
      else { state.sort = col; state.dir = (col === "q0" || col === "q1") ? "ASC" : "DESC"; }
      state.page = 0;
      runSearch();
    });
  });

  $("#resultBody").innerHTML = state.rows.map((r) =>
    `<tr data-id="${r.rowid}">${keys.map((k) => cellHtml(k, r)).join("")}</tr>`
  ).join("") ||
    `<tr><td colspan="${keys.length}" style="padding:32px;text-align:center;color:var(--ink-sub)">該当する手続はありません</td></tr>`;
}

function cellHtml(k, r) {
  const fx = FIXED_COLS.includes(k) ? " col-fixed" : "";
  if (k === "q2") {
    const flow = flowLine(r);
    return `<td class="col-name${fx}"><span class="name-cell">${esc(r.q2)}` +
      `<br><small style="color:var(--ink-sub)">${esc(r.q3_1 || "")}</small>` +
      (flow ? `<br><small style="color:var(--ink-sub)">${esc(flow)}</small>` : "") +
      `</span></td>`;
  }
  let v = r[k];
  if (k === "q0") return `<td class="num${fx}">${esc(v)}</td>`;
  if (k === "q14_1")
    return `<td class="${fx}"><span class="pill pill--${statusClass(v)}">${esc(shortStatus(v))}</span></td>`;
  if (k === "q19_1" || k === "q19_2" || k === "q19_3") {
    const s = v == null ? "" : String(v).trim();
    const digits = s.replace(/,/g, "");
    return `<td class="num${fx}">${s === "" ? "—" : (/^\d+$/.test(digits) ? nf(+digits) : esc(s))}</td>`;
  }
  if (k === "q4") v = String(v || "").replace(/^\d[\d-]*\s*/, "");
  v = v == null ? "" : String(v);
  const long = !fx && v.length > 16;
  const attrs = long ? ` title="${esc(v)}" data-full="${esc(v)}"` : "";
  return `<td class="${fx ? "col-fixed" : "col-extra"}"${attrs}>${esc(v)}</td>`;
}

/* 追加列のウィンドウ移動ナビ + 「表示列を設定」ボタン */
function renderColNav(start, win, total) {
  const el = $("#colNav");
  const names = (a, b) => state.selCols.slice(a, b).map((k) => esc(COLS[k])).join(" ・ ") || "（追加列なし）";
  const cfgBtn = `<button type="button" class="btn btn--ghost colnav__cfg" id="colCfgBtn">表示列を設定</button>`;

  if (total <= win) {
    el.innerHTML = `<span class="colnav__now">表示列：${names(0, total)}</span>${cfgBtn}`;
  } else {
    const end = Math.min(total, start + win);
    el.innerHTML =
      `<button type="button" class="colnav__arrow" id="colPrev" ${start === 0 ? "disabled" : ""} aria-label="左の列を表示">◀</button>` +
      `<span class="colnav__now"><b>追加列 ${start + 1}–${end}</b> / ${total}<br>${names(start, end)}</span>` +
      `<button type="button" class="colnav__arrow" id="colNext" ${end >= total ? "disabled" : ""} aria-label="右の列を表示">▶</button>` +
      cfgBtn;
  }
  const prev = $("#colPrev"), next = $("#colNext");
  if (prev) prev.onclick = () => { state.colStart--; renderTable(); };
  if (next) next.onclick = () => { state.colStart++; renderTable(); };
  $("#colCfgBtn").onclick = openColConfig;
}

/* ---------- 表示列の設定画面 ---------- */
let cfgSel = [];
function renderCfgBody() {
  $("#colCfgBody").innerHTML =
    `<p class="modal__note">固定表示（常に左端）：手続ID ・ 手続名（法令名・手続主体→受け手を併記） ・ 所管府省庁</p>` +
    GROUPS.map(([title, keys]) => {
      const items = keys.filter((k) => !FIXED_COLS.includes(k));
      if (!items.length) return "";
      return `<fieldset class="cfg-group"><legend>${esc(title)}</legend>` +
        items.map((k) =>
          `<label class="cfg-item"><input type="checkbox" value="${k}"${cfgSel.includes(k) ? " checked" : ""}>` +
          `<span>${esc(COLS[k])}</span></label>`).join("") +
        `</fieldset>`;
    }).join("");
  $$("#colCfgBody input[type=checkbox]").forEach((cb) =>
    cb.addEventListener("change", () => {
      if (cb.checked) { if (!cfgSel.includes(cb.value)) cfgSel.push(cb.value); }
      else cfgSel = cfgSel.filter((x) => x !== cb.value);
    }));
}
function openColConfig() {
  cfgSel = [...state.selCols];
  renderCfgBody();
  $("#colCfg").classList.add("is-open");
  $("#colCfg").setAttribute("aria-hidden", "false");
  $("#colCfgBackdrop").classList.add("is-open");
  $("#colCfgBody").scrollTop = 0;
}
function closeColConfig() {
  $("#colCfg").classList.remove("is-open");
  $("#colCfg").setAttribute("aria-hidden", "true");
  $("#colCfgBackdrop").classList.remove("is-open");
}
function applyColConfig() {
  state.selCols = Object.keys(COLS).filter((k) => cfgSel.includes(k) && !FIXED_COLS.includes(k));
  state.colStart = 0;
  try { localStorage.setItem("selCols", JSON.stringify(state.selCols)); } catch (e) {}
  closeColConfig();
  runSearch();
}

function renderPager() {
  const pages = Math.ceil(state.count / state.perPage) || 1;
  const html = state.count > state.perPage
    ? `<button class="pager-prev" ${state.page === 0 ? "disabled" : ""}>← 前へ</button>
       <span>${nf(state.page + 1)} / ${nf(pages)} ページ</span>
       <button class="pager-next" ${state.page >= pages - 1 ? "disabled" : ""}>次へ →</button>`
    : "";
  $("#pagerTop").innerHTML = html;
  $("#pager").innerHTML = html;
  $$(".pager-prev").forEach((b) => (b.onclick = () => { state.page--; runSearch(); scrollTop(); }));
  $$(".pager-next").forEach((b) => (b.onclick = () => { state.page++; runSearch(); scrollTop(); }));
}
function scrollTop() { $("#panel-search").scrollIntoView({ behavior: "smooth", block: "start" }); }

/* ---------- 詳細ドロワー ---------- */
function openDrawer(rowid) {
  const rec = one("SELECT * FROM procedures WHERE rowid = $id", { $id: rowid });
  $("#drawerTitle").textContent = rec.q2 || "(手続名なし)";
  $("#drawerSub").textContent =
    `手続ID ${rec.q0}　/　${rec.q1 || ""}　/　${rec.q3_1 || ""} ${rec.q3_2 || ""}`;

  $("#drawerBody").innerHTML = GROUPS.map(([title, keys]) => `
    <div class="detail-group">
      <h4>${title}</h4>
      ${keys.map((k) => {
        const v = rec[k];
        const empty = v == null || v === "";
        return `<dl class="detail-row">
          <dt>${esc(COLS[k] || k)}</dt>
          <dd class="${empty ? "empty" : ""}">${empty ? "—" : esc(v).replace(/;\s*/g, "<br>")}</dd>
        </dl>`;
      }).join("")}
    </div>`).join("");

  /* 関連手続へのドリルダウン */
  const shortT = (rec.q4 || "").replace(/^[\d-]+\s*/, "");
  const links = [];
  if (rec.q3_1)
    links.push([`この法令の手続（${rec.q3_1}）`,
      { extra: mkExtra("q3_1 = $law", "法令：" + rec.q3_1, { $law: rec.q3_1 }) }]);
  if (rec.q1 && rec.q4)
    links.push([`${rec.q1} × ${shortT}`, { form: { "#f-ministry": rec.q1, "#f-type": rec.q4 } }]);
  if (rec.q5 && rec.q6)
    links.push([`主体「${shortRole(rec.q5)}」→ 受け手「${shortRole(rec.q6)}」`,
      { form: { "#f-subject": "raw|" + rec.q5, "#f-receiver": "raw|" + rec.q6 } }]);
  const evp = (rec.q22_1 || "").split(/;\s*/).find((x) => EVENTS_PERSON.includes(x) && !x.startsWith("その他"));
  if (evp) links.push([`ライフイベント「${evp}」`, { form: { "#f-event-p": evp } }]);
  const evc = (rec.q22_2 || "").split(/;\s*/).find((x) => EVENTS_CORP.includes(x) && !x.startsWith("その他"));
  if (evc) links.push([`法人イベント「${evc}」`, { form: { "#f-event-c": evc } }]);
  if (rec.q18_1)
    links.push([`情報システム「${rec.q18_1}」`,
      { extra: mkExtra("q18_1 = $sys OR q18_2 LIKE $sysl", "情報システム：" + rec.q18_1,
        { $sys: rec.q18_1, $sysl: "%" + rec.q18_1 + "%" }) }]);

  if (links.length) {
    const div = document.createElement("div");
    div.className = "detail-group";
    div.innerHTML = `<h4>関連する手続へドリルダウン</h4><div class="drill-links">` +
      links.map((l, i) => `<button type="button" class="btn btn--ghost" data-rel="${i}">${esc(l[0])}</button>`).join("") +
      `</div>`;
    $("#drawerBody").appendChild(div);
    $$("#drawerBody [data-rel]").forEach((b) =>
      b.addEventListener("click", () => { closeDrawer(); applyDrill(links[+b.dataset.rel][1]); }));
  }

  $("#drawer").classList.add("is-open");
  $("#drawer").setAttribute("aria-hidden", "false");
  $("#drawerBackdrop").classList.add("is-open");
  $("#drawerBody").scrollTop = 0;
}
function closeDrawer() {
  $("#drawer").classList.remove("is-open");
  $("#drawer").setAttribute("aria-hidden", "true");
  $("#drawerBackdrop").classList.remove("is-open");
}

/* ---------- CSV 出力（現在の検索条件の全件） ---------- */
function exportCsv() {
  const { clause, params } = buildWhere();
  if (state.count > 20000 &&
      !confirm(`${nf(state.count)} 件を書き出します。時間がかかる場合があります。続けますか？`)) return;
  const keys = Object.keys(COLS);
  const rows = all(
    `SELECT ${keys.map((k) => `"${k}"`).join(",")} FROM procedures ${clause} ORDER BY q0+0`,
    params);
  const head = keys.map((k) => COLS[k]);
  const csv = [head, ...rows.map((r) => keys.map((k) => r[k]))]
    .map((line) => line.map((c) => {
      const s = c == null ? "" : String(c);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(",")).join("\r\n");

  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `procedures_search_${rows.length}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

boot();
