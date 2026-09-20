(() => {
  "use strict";

  const STALE_MINUTES = 90;
  const REFRESH_MS = 2 * 60 * 1000;
  const STORE_KEY = "cryptoDash.portfolio.v1";
  const ENCRYPTED_STORE_KEY = "cryptoDash.portfolio.enc.v2";
  let encryptionPassword = null;
  const TAB_KEY = "cryptoDash.tab";
  const BASELINE = "0000-00-00"; // 처음 저장한 수량: 모든 과거 날짜에 적용

  const ASSETS = ["BTC", "USDT", "XRP", "ETH"];
  const LOCATIONS = [["upbit", "업비트"], ["binance", "바이낸스"], ["wallet", "개인지갑"]];

  const state = {
    latest: null, history: [], sig: "",
    tab: "pf",
    label: null, days: 90,            // 시세 화면
    pfDays: 90, quote: "KRW",         // 내 자산 화면
    entries: [], storageOk: true,
    charts: {},
  };

  const $ = (id) => document.getElementById(id);

  // 외부에서 받은 값은 HTML로 해석하지 않도록 이스케이프합니다.
  // (가격 데이터/라벨이 변조되더라도 DOM XSS로 이어지는 것을 방지)
  const esc = (value) => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  /* ---------- 표시 형식 ---------- */
  const fmt = (v) => {
    if (typeof v !== "number" || Number.isNaN(v)) return "–";
    const a = Math.abs(v);
    const digits = a >= 1e6 ? 0 : a >= 1000 ? 2 : a >= 1 ? 4 : 6;
    return v.toLocaleString("ko-KR", { maximumFractionDigits: digits });
  };
  const fmtKrw = (v) => (typeof v !== "number" || Number.isNaN(v) ? "–" : Math.round(v).toLocaleString("ko-KR"));
  const fmtUsdt = (v) => (typeof v !== "number" || Number.isNaN(v) ? "–" : v.toLocaleString("ko-KR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const fmtQty = (v) => v.toLocaleString("ko-KR", { maximumFractionDigits: 8 });
  const compact = (v) => v.toLocaleString("ko-KR", { notation: "compact", maximumFractionDigits: 1 });
  const signed = (v) => (v > 0 ? "+" : "") + fmt(v);
  const pct = (r) => (r == null ? "–" : (r > 0 ? "+" : "") + (r * 100).toFixed(2) + "%");
  const tone = (r) => (r == null || r === 0 ? "flat" : r > 0 ? "up" : "down");

  /* ---------- 날짜 (09:00 KST = 00:00 UTC 이므로 UTC 날짜가 곧 기록 날짜) ---------- */
  const dayLabel = (d = new Date()) => d.toISOString().slice(0, 10);
  const nextDay = (label) => new Date(Date.parse(label) + 86400000).toISOString().slice(0, 10);
  const savedDay = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? null : dayLabel(d); };

  /* ---------- 보유 수량 저장소 (이 브라우저의 localStorage) ---------- */
  const num = (x) => { const n = Number(x); return Number.isFinite(n) && n >= 0 ? n : 0; };
  function cleanHoldings(h) {
    const out = {};
    for (const a of ASSETS) { out[a] = {}; for (const [k] of LOCATIONS) out[a][k] = num(h && h[a] && h[a][k]); }
    return out;
  }
  const sameHoldings = (a, b) => JSON.stringify(cleanHoldings(a)) === JSON.stringify(cleanHoldings(b));
  function sanitizeEntries(list) {
    if (!Array.isArray(list)) return [];
    return list
      .filter((e) => e && typeof e.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(e.from))
      .map((e) => ({ from: e.from, savedAt: typeof e.savedAt === "string" ? e.savedAt : "", holdings: cleanHoldings(e.holdings) }))
      .sort((a, b) => a.from.localeCompare(b.from));
  }
  function storageWorks() {
    try { localStorage.setItem("__t", "1"); localStorage.removeItem("__t"); return true; } catch (e) { return false; }
  }
  const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
  const unb64 = (text) => Uint8Array.from(atob(text), c => c.charCodeAt(0));
  async function deriveKey(password, salt) {
    const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 250000, hash: "SHA-256" }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  async function encryptEntries(entries, password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(password, salt);
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify({ version: 2, entries })));
    return JSON.stringify({ version: 2, salt: b64(salt), iv: b64(iv), ciphertext: b64(ciphertext) });
  }
  async function decryptEntries(record, password) {
    const key = await deriveKey(password, unb64(record.salt));
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(record.iv) }, key, unb64(record.ciphertext));
    return sanitizeEntries(JSON.parse(new TextDecoder().decode(plain)).entries);
  }
  async function unlock() {
    const raw = localStorage.getItem(ENCRYPTED_STORE_KEY);
    if (!raw) return true;
    const password = prompt("자산 데이터 암호를 입력하세요. 암호를 잊으면 복구할 수 없습니다.");
    if (!password) return false;
    try { state.entries = await decryptEntries(JSON.parse(raw), password); encryptionPassword = password; return true; }
    catch (e) { alert("암호가 틀렸거나 백업 데이터가 손상되었습니다."); return false; }
  }
  async function persist() {
    try {
      if (!encryptionPassword) {
        encryptionPassword = prompt("처음 저장합니다. 자산 데이터 암호를 설정하세요. 암호를 잊으면 복구할 수 없습니다.");
        if (!encryptionPassword || encryptionPassword.length < 8) { encryptionPassword = null; flash("암호는 8자 이상이어야 합니다."); return false; }
      }
      localStorage.setItem(ENCRYPTED_STORE_KEY, await encryptEntries(state.entries, encryptionPassword));
      localStorage.removeItem(STORE_KEY);
      return true;
    } catch (e) { return false; }
  }
  function holdingsAt(date) {
    let h = null;
    for (const e of state.entries) { if (e.from <= date) h = e.holdings; else break; }
    return h;
  }
  const qtyOf = (h, asset) => LOCATIONS.reduce((s, [k]) => s + h[asset][k], 0);

  /* ---------- 입력 칸 ---------- */
  function buildInputs(h) {
    $("inputs").innerHTML = ASSETS.map((a) => `<tr><th scope="row">${esc(a)}</th>${LOCATIONS.map(([k, name]) =>
      `<td><input type="text" inputmode="decimal" autocomplete="off" placeholder="0" data-asset="${a}" data-loc="${k}" aria-label="${esc(name)} ${esc(a)} 수량" value="${h && h[a][k] ? h[a][k] : ""}"></td>`
    ).join("")}</tr>`).join("");
  }
  function readInputs() {
    const h = {};
    let valid = true;
    for (const a of ASSETS) {
      h[a] = {};
      for (const [k] of LOCATIONS) {
        const el = document.querySelector(`input[data-asset="${a}"][data-loc="${k}"]`);
        const raw = String(el.value).replace(/,/g, "").trim();
        let n = raw === "" ? 0 : Number(raw);
        const bad = !Number.isFinite(n) || n < 0;
        el.setAttribute("aria-invalid", String(bad));
        if (bad) { valid = false; n = 0; }
        h[a][k] = n;
      }
    }
    return { h, valid };
  }
  function flash(text) { $("flash").textContent = text; }

  function updateStatus(h, valid) {
    const last = state.entries[state.entries.length - 1];
    let text;
    if (!valid) text = "숫자가 아닌 값이 있습니다. 빨간 칸을 확인해 주세요.";
    else if (!last) text = "아직 저장된 수량이 없습니다. 입력한 뒤 저장을 누르면 추이 기록이 시작됩니다.";
    else if (!sameHoldings(h, last.holdings)) text = "저장하지 않은 변경이 있습니다. 아래 평가액은 입력한 값 기준이고, 추이는 저장한 값 기준입니다.";
    else {
      text = "저장된 수량과 같습니다.";
      if (last.from > dayLabel()) text += ` 변경한 수량은 ${last.from.slice(5)} 09:00 기록부터 추이에 반영됩니다.`;
    }
    if (!state.storageOk) text += " 이 브라우저는 저장을 막고 있어 페이지를 닫으면 입력값이 사라집니다.";
    $("save-status").textContent = text;
  }

  function save() {
    const { h, valid } = readInputs();
    if (!valid) { flash("숫자가 아닌 값이 있어 저장하지 않았습니다."); return; }
    const last = state.entries[state.entries.length - 1];
    const nowIso = new Date().toISOString();
    if (!last) {
      state.entries.push({ from: BASELINE, savedAt: nowIso, holdings: h });
    } else if (sameHoldings(h, last.holdings)) {
      flash("변경된 수량이 없습니다.");
      updateStatus(h, true);
      return;
    } else if (savedDay(last.savedAt) === dayLabel()) {
      last.holdings = h;             // 같은 날 다시 저장하면 그 기록을 고쳐 씀 (오타 수정)
      last.savedAt = nowIso;
    } else {
      state.entries.push({ from: nextDay(dayLabel()), savedAt: nowIso, holdings: h });
    }
    persist().then(ok => { flash(ok ? "암호화하여 저장했습니다." : "저장하지 못했습니다. 암호 또는 브라우저 저장 상태를 확인하세요."); renderPortfolio(); });
  }

  async function exportBackup() {
    if (!encryptionPassword) { encryptionPassword = prompt("백업 암호를 설정/입력하세요(8자 이상)."); }
    if (!encryptionPassword || encryptionPassword.length < 8) { flash("백업 암호는 8자 이상이어야 합니다."); return; }
    try {
      const blob = new Blob([await encryptEntries(state.entries, encryptionPassword)], { type: "application/json" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
      a.download = "portfolio-backup-encrypted-" + dayLabel() + ".json";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000); flash("암호화 백업 파일을 내려받았습니다.");
    } catch (e) { flash("암호화 백업에 실패했습니다."); }
  }

  async function importBackup(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      let entries;
      try {
        const parsed = JSON.parse(String(reader.result));
        if (parsed.version === 2 && parsed.ciphertext) {
          const password = prompt("백업 파일 암호를 입력하세요.");
          if (!password) return;
          entries = await decryptEntries(parsed, password);
          encryptionPassword = password;
        } else { entries = sanitizeEntries(parsed.entries); }
      } catch (e) { entries = []; }
      if (!entries.length) { flash("백업 파일을 읽지 못했거나 암호가 틀렸습니다."); return; }
      if (state.entries.length && !confirm("현재 저장된 수량과 변경 이력을 백업 내용으로 바꿉니다. 계속할까요?")) return;
      state.entries = entries;
      persist().then(ok => { flash(ok ? "백업을 암호화하여 가져왔습니다." : "가져왔지만 저장하지 못했습니다."); buildInputs(entries[entries.length - 1].holdings); renderPortfolio(); });
    };
    reader.readAsText(file);
  }

  function resetAll() {
    if (!confirm("이 브라우저에 저장된 보유 수량과 변경 이력을 모두 지울까요? 되돌릴 수 없습니다.")) return;
    try { localStorage.removeItem(STORE_KEY); } catch (e) { /* 무시 */ }
    state.entries = [];
    buildInputs(null);
    flash("모두 지웠습니다.");
    renderPortfolio();
  }

  /* ---------- 데이터 ---------- */
  async function loadJson(url) {
    const res = await fetch(url + "?t=" + Date.now(), { cache: "no-store" });
    if (!res.ok) throw new Error(url + " " + res.status);
    return res.json();
  }
  function withChange(pts) {
    return pts.map((p, i) => ({
      date: p.date, v: p.v,
      prev: i > 0 ? pts[i - 1].v : null,
      r: i > 0 && pts[i - 1].v !== 0 ? p.v / pts[i - 1].v - 1 : null,
    }));
  }
  function seriesFor(label) {
    return withChange(state.history.filter((r) => typeof r[label] === "number").map((r) => ({ date: r.date, v: r[label] })));
  }
  function priceOf(asset, quote) {
    if (asset === "USDT" && quote === "USDT") return 1;
    const it = state.latest && state.latest.items.find((i) => i.label === asset + "/" + quote);
    return it ? it.price : null;
  }
  // 저장한 수량 × 각 날짜 09:00 시세. 수량이 있는 자산의 시세가 없는 날은 건너뜀.
  function portfolioSeries(quote) {
    const pts = [];
    for (const row of state.history) {
      const h = holdingsAt(row.date);
      if (!h) continue;
      let total = 0, ok = true;
      for (const a of ASSETS) {
        const q = qtyOf(h, a);
        if (q <= 0) continue;
        const p = a === "USDT" && quote === "USDT" ? 1 : row[a + "/" + quote];
        if (typeof p !== "number") { ok = false; break; }
        total += q * p;
      }
      if (ok && total > 0) pts.push({ date: row.date, v: total });
    }
    return withChange(pts);
  }

  /* ---------- 차트 (두 화면 공용) ---------- */
  function drawChart(cfg) {
    if (state.charts[cfg.key]) { state.charts[cfg.key].destroy(); state.charts[cfg.key] = null; }
    const wrap = $(cfg.wrapId), msg = $(cfg.msgId);
    const stop = (text) => { wrap.hidden = true; msg.textContent = text; msg.hidden = false; };
    if (typeof Chart === "undefined") return stop("차트 라이브러리를 불러오지 못했습니다. 네트워크 연결을 확인해 주세요.");
    if (!cfg.points.length) return stop(cfg.emptyText);
    wrap.hidden = false;
    msg.hidden = true;

    const ink = cssVar("--ink"), up = cssVar("--up"), down = cssVar("--down");
    Chart.defaults.color = cssVar("--muted");
    Chart.defaults.borderColor = cssVar("--line");
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    const s = cfg.points;

    state.charts[cfg.key] = new Chart($(cfg.canvasId), {
      data: {
        labels: s.map((p) => p.date.slice(5)),
        datasets: [
          {
            type: "line", label: cfg.valueLabel, data: s.map((p) => p.v), yAxisID: "y", order: 0,
            borderColor: ink, backgroundColor: ink, borderWidth: 2, tension: 0.2,
            pointRadius: s.length > 60 ? 0 : 3, pointHoverRadius: 5,
          },
          {
            type: "bar", label: "전일 대비 증감률", data: s.map((p) => (p.r == null ? null : p.r * 100)), yAxisID: "y1", order: 1,
            backgroundColor: (c) => (c.raw >= 0 ? up : down), borderWidth: 0, maxBarThickness: 14,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { position: "bottom", labels: { usePointStyle: true, boxWidth: 8 } },
          tooltip: {
            callbacks: {
              title: (items) => s[items[0].dataIndex].date + " 09:00",
              label: (c) => c.datasetIndex === 0
                ? " " + cfg.valFmt(c.raw)
                : " 전일 대비 " + (c.raw == null ? "–" : (c.raw > 0 ? "+" : "") + c.raw.toFixed(2) + "%"),
            },
          },
        },
        scales: {
          x: { grid: { display: false }, ticks: { maxTicksLimit: 8, maxRotation: 0 } },
          y: { position: "left", grace: "5%", ticks: { callback: (v) => cfg.tickFmt(v) } },
          y1: { position: "right", grid: { drawOnChartArea: false }, ticks: { callback: (v) => v.toFixed(1) + "%" } },
        },
      },
    });
  }

  /* ---------- 화면: 내 자산 ---------- */
  function renderValuation() {
    const { h, valid } = readInputs();
    updateStatus(h, valid);
    const ready = !!state.latest;

    const rows = ASSETS.map((a) => {
      const q = qtyOf(h, a);
      const pu = ready ? priceOf(a, "USDT") : null;
      const pk = ready ? priceOf(a, "KRW") : null;
      return { a, q, pu, pk, vu: pu == null ? null : q * pu, vk: pk == null ? null : q * pk };
    });
    const missing = rows.filter((r) => r.q > 0 && (r.pu == null || r.pk == null)).map((r) => r.a);
    const sumU = rows.reduce((s, r) => s + (r.vu || 0), 0);
    const sumK = rows.reduce((s, r) => s + (r.vk || 0), 0);

    $("tot-krw").textContent = ready ? fmtKrw(sumK) + "원" : "–";
    $("tot-usdt").textContent = ready ? fmtUsdt(sumU) + " USDT" : "–";

    const note = $("val-note");
    if (!ready) { note.textContent = "시세를 불러오지 못했습니다. 잠시 후 다시 확인해 주세요."; note.hidden = false; }
    else if (missing.length) { note.textContent = "시세가 없어 합계에서 빠진 자산: " + missing.join(", "); note.hidden = false; }
    else note.hidden = true;

    // 오늘 09:00 시세 대비 (같은 수량으로 09:00 시점 시세와 비교 = 시세 변동만 반영)
    const last = state.history[state.history.length - 1];
    let baseK = null;
    if (last) {
      baseK = 0;
      for (const r of rows) {
        if (r.q <= 0) continue;
        const p = last[r.a + "/KRW"];
        if (typeof p !== "number") { baseK = null; break; }
        baseK += r.q * p;
      }
    }
    const delta = $("tot-delta");
    if (ready && !missing.length && baseK > 0) {
      const r = sumK / baseK - 1;
      const d = sumK - baseK;
      delta.className = "t-delta " + tone(r);
      delta.textContent = `${last.date.slice(5)} 09:00 대비 ${d > 0 ? "+" : ""}${fmtKrw(d)}원 (${pct(r)})`;
    } else {
      delta.className = "t-delta flat";
      delta.textContent = "";
    }

    $("asset-rows").innerHTML = rows.map((r) => `<tr>
      <th scope="row">${esc(r.a)}</th><td>${fmtQty(r.q)}</td><td>${fmt(r.pu)}</td><td>${fmt(r.pk)}</td>
      <td>${fmtUsdt(r.vu)}</td><td>${fmtKrw(r.vk)}</td></tr>`).join("");
    $("asset-foot").innerHTML = `<tr><th scope="row">합계</th><td></td><td></td><td></td>
      <td>${ready ? fmtUsdt(sumU) : "–"}</td><td>${ready ? fmtKrw(sumK) : "–"}</td></tr>`;

    $("loc-rows").innerHTML = LOCATIONS.map(([k, name]) => {
      let vu = 0, vk = 0;
      for (const r of rows) {
        const q = h[r.a][k];
        if (q <= 0) continue;
        if (r.pu != null) vu += q * r.pu;
        if (r.pk != null) vk += q * r.pk;
      }
      const share = sumK > 0 ? (vk / sumK * 100).toFixed(1) + "%" : "–";
      return `<tr><th scope="row">${esc(name)}</th><td>${ready ? fmtUsdt(vu) : "–"}</td><td>${ready ? fmtKrw(vk) : "–"}</td><td>${share}</td></tr>`;
    }).join("");
  }

  function renderPfChart() {
    const full = portfolioSeries(state.quote);
    const pts = state.pfDays > 0 ? full.slice(-state.pfDays) : full;
    const krw = state.quote === "KRW";
    drawChart({
      key: "pf", canvasId: "pf-chart", wrapId: "pf-chart-wrap", msgId: "pf-chart-msg", points: pts,
      valueLabel: krw ? "09:00 평가액 (원)" : "09:00 평가액 (USDT)",
      tickFmt: (v) => compact(v),
      valFmt: (v) => (krw ? fmtKrw(v) + "원" : fmtUsdt(v) + " USDT"),
      emptyText: state.entries.length ? "평가액을 계산할 시세 기록이 아직 없습니다." : "보유 수량을 저장하면 추이가 표시됩니다.",
    });
  }

  function renderPfTable() {
    const krw = state.quote === "KRW";
    $("pf-table-title").textContent = "일별 평가액 기록 (" + (krw ? "원화" : "USDT") + ")";
    const full = portfolioSeries(state.quote);
    const body = $("pf-rows");
    if (!full.length) { body.innerHTML = '<tr><td colspan="4" class="flat">기록이 아직 없습니다.</td></tr>'; return; }
    const f = krw ? fmtKrw : fmtUsdt;
    const sg = (v) => (v > 0 ? "+" : "") + f(v);
    body.innerHTML = full.slice(-60).reverse().map((p) => `<tr>
      <td>${p.date}</td><td>${f(p.v)}</td>
      <td class="${tone(p.r)}">${p.prev == null ? "–" : sg(p.v - p.prev)}</td>
      <td class="${tone(p.r)}">${pct(p.r)}</td></tr>`).join("");
  }

  function renderPortfolio() { renderValuation(); renderPfChart(); renderPfTable(); }

  /* ---------- 화면: 시세 ---------- */
  function renderWatch() {
    const list = $("watch");
    if (!state.latest) {
      list.innerHTML = '<li><p class="msg">시세를 불러오지 못했습니다. GitHub의 Actions 탭에서 실행 결과를 확인해 주세요.</p></li>';
      return;
    }
    list.innerHTML = state.latest.items.map((it) => {
      const s = seriesFor(it.label);
      const base = s.length ? s[s.length - 1] : null;
      let delta = '<span class="flat">–</span>';
      if (it.daily) delta = '<span class="flat">하루 1회 갱신</span>';
      else if (base && base.v) {
        const r = it.price / base.v - 1;
        delta = `<span class="${tone(r)}">${pct(r)}</span>`;
      }
      const baseText = base ? `${base.date.slice(5)} 09:00 · ${fmt(base.v)}` : "기록 없음";
      const current = it.label === state.label ? ' aria-current="true"' : "";
      return `<li><button type="button" data-label="${esc(it.label)}"${current}>
        <span class="w-name">${esc(it.label)}</span><span class="w-price">${fmt(it.price)}</span>
        <span class="w-base">${esc(baseText)}</span><span class="w-delta">${delta}</span>
      </button></li>`;
    }).join("");
  }

  function renderChart() {
    $("chart-title").textContent = (state.label || "") + " 09:00 기준 추이";
    const full = state.label ? seriesFor(state.label) : [];
    drawChart({
      key: "px", canvasId: "chart", wrapId: "chart-wrap", msgId: "chart-msg",
      points: state.days > 0 ? full.slice(-state.days) : full,
      valueLabel: "09:00 값", tickFmt: fmt, valFmt: (v) => "값 " + fmt(v),
      emptyText: "이 종목의 기록이 아직 없습니다.",
    });
  }

  function renderTable() {
    $("table-title").textContent = (state.label || "") + " 일별 기록";
    const full = state.label ? seriesFor(state.label) : [];
    const body = $("rows");
    if (!full.length) { body.innerHTML = '<tr><td colspan="4" class="flat">기록이 아직 없습니다.</td></tr>'; return; }
    body.innerHTML = full.slice(-60).reverse().map((p) => `<tr>
      <td>${p.date}</td><td>${fmt(p.v)}</td>
      <td class="${tone(p.r)}">${p.prev == null ? "–" : signed(p.v - p.prev)}</td>
      <td class="${tone(p.r)}">${pct(p.r)}</td></tr>`).join("");
  }

  function renderPrices() { renderWatch(); renderChart(); renderTable(); }

  /* ---------- 공통 ---------- */
  function renderHeader() {
    const el = $("updated"), stale = $("stale");
    if (!state.latest) { el.textContent = "시세를 불러오지 못했습니다"; stale.hidden = true; return; }
    const t = new Date(state.latest.updated);
    el.textContent = "시세 업데이트 " + t.toLocaleString("ko-KR", {
      timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
    }) + " KST";
    stale.hidden = (Date.now() - t.getTime()) / 60000 <= STALE_MINUTES;
  }

  function renderActive() {
    renderHeader();
    if (state.tab === "pf") renderPortfolio(); else renderPrices();
  }

  function showTab(name) {
    state.tab = name;
    $("view-pf").hidden = name !== "pf";
    $("view-px").hidden = name !== "px";
    if (name === "pf") $("tab-pf").setAttribute("aria-current", "page"); else $("tab-pf").removeAttribute("aria-current");
    if (name === "px") $("tab-px").setAttribute("aria-current", "page"); else $("tab-px").removeAttribute("aria-current");
    try { localStorage.setItem(TAB_KEY, name); } catch (e) { /* 무시 */ }
    renderActive();
  }

  async function refresh() {
    const [latest, hist] = await Promise.allSettled([loadJson("data/latest.json"), loadJson("data/history.json")]);
    if (latest.status === "fulfilled") state.latest = latest.value;
    if (hist.status === "fulfilled") state.history = hist.value.rows || [];

    const labels = state.latest ? state.latest.items.map((i) => i.label) : [];
    if (!state.label || (labels.length && !labels.includes(state.label))) state.label = labels[0] || null;

    // 데이터가 바뀌지 않았으면 다시 그리지 않음 (입력 중 깜빡임 방지)
    const lastRow = state.history[state.history.length - 1];
    const sig = (state.latest ? state.latest.updated : "") + "|" + state.history.length + "|" + JSON.stringify(lastRow || {});
    if (sig === state.sig) return;
    state.sig = sig;
    renderActive();
  }

  /* ---------- 이벤트 ---------- */
  $("tab-pf").addEventListener("click", () => showTab("pf"));
  $("tab-px").addEventListener("click", () => showTab("px"));

  $("inputs").addEventListener("input", renderValuation);
  $("btn-save").addEventListener("click", save);
  $("btn-export").addEventListener("click", exportBackup);
  $("btn-import").addEventListener("click", () => $("file-import").click());
  $("file-import").addEventListener("change", (e) => { importBackup(e.target.files[0]); e.target.value = ""; });
  $("btn-reset").addEventListener("click", resetAll);

  function bindSeg(id, attr, onPick) {
    $(id).addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      $(id).querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      onPick(b.dataset[attr]);
    });
  }
  bindSeg("pf-quote", "quote", (v) => { state.quote = v; renderPfChart(); renderPfTable(); });
  bindSeg("pf-ranges", "days", (v) => { state.pfDays = Number(v); renderPfChart(); });
  bindSeg("px-ranges", "days", (v) => { state.days = Number(v); renderChart(); });

  $("watch").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-label]");
    if (!btn) return;
    state.label = btn.dataset.label;
    renderPrices();
  });

  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (state.tab === "pf") renderPfChart(); else renderChart();
  });

  /* ---------- 시작 ---------- */
  state.storageOk = storageWorks();
  (async () => {
    if (!state.storageOk) { flash("브라우저 저장 기능을 사용할 수 없습니다."); }
    const encrypted = state.storageOk ? localStorage.getItem(ENCRYPTED_STORE_KEY) : null;
    if (encrypted) {
      if (!(await unlock())) return;
    } else {
      try {
        const legacy = state.storageOk ? localStorage.getItem(STORE_KEY) : null;
        state.entries = legacy ? sanitizeEntries(JSON.parse(legacy).entries) : [];
        if (state.entries.length) {
          const ok = await persist();
          if (!ok) { flash("기존 데이터 암호화에 실패했습니다."); return; }
        }
      } catch (e) { state.entries = []; }
    }
    const lastEntry = state.entries[state.entries.length - 1];
    buildInputs(lastEntry ? lastEntry.holdings : null);
    let startTab = "pf";
    try { if (localStorage.getItem(TAB_KEY) === "px") startTab = "px"; } catch (e) {}
    showTab(startTab);
    refresh();
    setInterval(refresh, REFRESH_MS);
  })();
})();
