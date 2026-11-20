// 前端：所有数字都来自 /api/* 的真实模拟结果，本文件只负责取数与渲染（SVG 手绘，无第三方库）。

const resultEl = document.querySelector('#result');
const errorBox = document.querySelector('#error-box');
const COLORS = { A: 'var(--series-a)', B: 'var(--series-b)', merge: 'var(--series-merge)' };
const HEX = { A: getHex('--series-a'), B: getHex('--series-b'), merge: getHex('--series-merge') };

function getHex(token) {
  return getComputedStyle(document.documentElement).getPropertyValue(token).trim() || '#888';
}

async function api(path, payload) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.error ?? `请求失败 HTTP ${res.status}`);
  }
  return data;
}

function showError(err) {
  errorBox.hidden = false;
  errorBox.textContent = `操作失败：${err.message}`;
}
function clearError() { errorBox.hidden = true; errorBox.textContent = ''; }

function setBusy(buttons, busy) {
  buttons.forEach((b) => { b.disabled = busy; });
}
function setResult(html, state) {
  resultEl.dataset.state = state;
  resultEl.innerHTML = html;
}
function h(strings, ...values) {
  return strings.reduce((acc, s, i) => acc + s + (i < values.length ? escapeHtml(values[i]) : ''), '');
}
function escapeHtml(v) {
  return String(v).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* ---------- 场景元信息 ---------- */
async function loadScenario() {
  const s = await fetch('/api/scenario').then((r) => r.json());
  document.querySelector('#meta-scenario').textContent = s.label;
  document.querySelector('#meta-version').textContent = s.capacityVersion;
  document.querySelector('#meta-horizon').textContent = `${s.horizonSeconds} 秒`;
  document.querySelector('#meta-gates').textContent =
    s.gates.map((g) => `${g.id}(${g.capacityPerSecond}/秒)`).join(' + ');
  const select = document.querySelector('#closure-gate');
  select.innerHTML = s.gates.map((g) => `<option value="${g.id}">${g.label}</option>`).join('');
  select.value = s.closures[0]?.gateId ?? s.gates[1]?.id ?? s.gates[0].id;
  document.querySelector('#close-at').value = s.closures[0]?.closeAtSecond ?? 10;
  document.querySelector('#reopen-at').value = s.closures[0]?.reopenAtSecond ?? 16;
  return s;
}

function closurePayload() {
  return {
    // 页面按钮语义：用所选通道的关闸事件替换样例事件，保证两路对比只有一个关闸源
    closure: {
      gateId: document.querySelector('#closure-gate').value,
      closeAtSecond: Number(document.querySelector('#close-at').value),
      reopenAtSecond: Number(document.querySelector('#reopen-at').value),
      replace: true,
    },
  };
}

/* ---------- SVG 折线/面积图（带十字准星 tooltip 与关闸带） ---------- */
const CHART_W = 960;
const CHART_PAD = { l: 46, r: 56, t: 16, b: 30 };

function lineChart({ series, horizon, closures, height = 260, yLabel }) {
  const padL = CHART_PAD.l, padR = CHART_PAD.r, padT = CHART_PAD.t, padB = CHART_PAD.b;
  const plotW = CHART_W - padL - padR;
  const plotH = height - padT - padB;
  const maxY = Math.max(1, ...series.flatMap((s) => s.data));
  const x = (t) => padL + (horizon <= 1 ? 0 : (t / (horizon - 1)) * plotW);
  const y = (v) => padT + plotH - (v / maxY) * plotH;
  const yTicks = new Set([0, Math.ceil(maxY / 2), maxY]);

  const bands = (closures ?? []).map((c) => {
    const x1 = x(c.closeAtSecond), x2 = x(Math.min(c.reopenAtSecond, horizon - 1));
    return `<rect class="closure-band" x="${x1}" y="${padT}" width="${Math.max(2, x2 - x1)}" height="${plotH}"/>
      <text class="closure-label" x="${x1 + 4}" y="${padT + 12}">${escapeHtml(c.gateId)}关闸</text>`;
  }).join('');

  const grid = [...yTicks].map((tv) => `
    <line class="gridline" x1="${padL}" x2="${CHART_W - padR}" y1="${y(tv)}" y2="${y(tv)}"/>
    <text class="tick-label" x="${padL - 8}" y="${y(tv) + 4}" text-anchor="end">${tv}</text>`).join('');

  const xTicks = Array.from({ length: horizon }, (_, t) => t)
    .filter((t) => t % 5 === 0 || t === horizon - 1)
    .map((t) => `<text class="tick-label" x="${x(t)}" y="${height - 8}" text-anchor="middle">${t}s</text>`).join('');

  const paths = series.map((s) => {
    const pts = s.data.map((v, t) => `${x(t)},${y(v)}`).join(' ');
    const area = `M${x(0)},${y(0)} L${s.data.map((v, t) => `${x(t)},${y(v)}`).join(' L ')} L${x(horizon - 1)},${y(0)} Z`;
    const last = s.data.length - 1;
    return `
      <path class="series-area" d="${area}" fill="${s.color}"/>
      <polyline class="series-line" points="${pts}" stroke="${s.color}"/>
      <circle class="end-dot" cx="${x(last)}" cy="${y(s.data[last])}" r="4.5" fill="${s.color}"/>
      <text class="direct-label" x="${x(last) + 7}" y="${y(s.data[last]) + 4}">${escapeHtml(s.name)} ${s.data[last]}</text>`;
  }).join('');

  const legend = series.map((s) =>
    `<span class="key"><span class="swatch line" style="background:${s.color}"></span>${escapeHtml(s.name)}</span>`).join('');

  const wrapId = `cw-${Math.random().toString(36).slice(2, 9)}`;
  const meta = JSON.stringify(series.map((s) => ({ name: s.name, data: s.data, color: s.color })));
  return `
    <div class="legend">${legend}</div>
    <div class="chart-wrap" id="${wrapId}">
      <svg class="chart" viewBox="0 0 ${CHART_W} ${height}" role="img" aria-label="${escapeHtml(yLabel)}"
        data-series='${escapeAttr(meta)}' data-horizon="${horizon}"
        data-padl="${padL}" data-plotw="${plotW}" data-ploth="${plotH}" data-padt="${padT}">
        ${bands}${grid}
        <line class="axis-line" x1="${padL}" x2="${CHART_W - padR}" y1="${padT + plotH}" y2="${padT + plotH}"/>
        ${xTicks}${paths}
        <line class="crosshair" x1="0" x2="0" y1="${padT}" y2="${padT + plotH}" hidden/>
        <rect class="hover-hit" x="${padL}" y="${padT}" width="${plotW}" height="${plotH}"/>
      </svg>
    </div>
    <div class="tooltip" id="${wrapId}-tt" hidden></div>`;
}

// 给折线图挂 hover（事件代理挂在容器上，避免内联事件）
function bindLineChart(wrapId) {
  const wrap = document.getElementById(wrapId);
  if (!wrap) return;
  const svg = wrap.querySelector('svg');
  const hit = svg.querySelector('.hover-hit');
  const cross = svg.querySelector('.crosshair');
  const tt = document.getElementById(`${wrapId}-tt`);
  const series = JSON.parse(svg.dataset.series);
  const horizon = Number(svg.dataset.horizon);
  const padL = Number(svg.dataset.padl);
  const plotW = Number(svg.dataset.plotw);

  hit.addEventListener('mousemove', (ev) => {
    const rect = svg.getBoundingClientRect();
    const sx = ((ev.clientX - rect.left) / rect.width) * CHART_W;
    const t = Math.round(((sx - padL) / plotW) * (horizon - 1));
    if (t < 0 || t >= horizon) { cross.hidden = true; tt.hidden = true; return; }
    const cx = padL + (t / (horizon - 1)) * plotW;
    cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.hidden = false;
    tt.innerHTML = `<div class="tt-title">第 ${t} 秒末</div>` + series.map((s) =>
      `<div class="tt-row"><span><span class="tt-dot" style="background:${s.color}"></span>${escapeHtml(s.name)}</span><strong>${s.data[t]}</strong></div>`).join('');
    tt.hidden = false;
    tt.style.left = `${Math.min(window.innerWidth - 180, ev.clientX + 14)}px`;
    tt.style.top = `${ev.clientY + 14}px`;
  });
  hit.addEventListener('mouseleave', () => { cross.hidden = true; tt.hidden = true; });
}

// 统一入口：生成图表 HTML 之后由 bindAllCharts 挂交互
const chart = lineChart;
function escapeAttr(v) { return escapeHtml(v).replaceAll('&#39;', "'"); }

function bindAllCharts(root = document) {
  root.querySelectorAll('.chart-wrap').forEach((w) => bindLineChart(w.id));
}

/* ---------- 柱状图：每秒到场 ---------- */
function arrivalBars(arrivals, closures) {
  const max = Math.max(1, ...arrivals);
  const height = 180;
  const bars = arrivals.map((v, t) => {
    const h = (v / max) * (height - 26);
    const closed = (closures ?? []).some((c) => t >= c.closeAtSecond && t < c.reopenAtSecond);
    return `<rect class="bar-rect" x="${t * 1.0}" y="${height - 18 - h}" width="0.72" height="${h}" fill="${closed ? HEX.B : HEX.A}">
      <title>第${t}秒到场 ${v} 人${closed ? '（关闸期间）' : ''}</title></rect>`;
  }).join('');
  return `<div class="chart-wrap"><svg class="chart" viewBox="-1 0 ${arrivals.length + 2} ${height}" role="img" aria-label="每秒到场人数柱状图">${bars}
    <line class="axis-line" x1="0" x2="${arrivals.length}" y1="${height - 18}" y2="${height - 18}"/></svg></div>
    <div class="legend"><span class="key"><span class="swatch" style="background:${HEX.A}"></span>正常秒</span>
    <span class="key"><span class="swatch" style="background:${HEX.B}"></span>关闸期间的到场</span></div>`;
}

/* ---------- 指标卡 ---------- */
function tiles(items) {
  return `<div class="tiles">${items.map((it) => `
    <div class="tile"><div class="label">${escapeHtml(it.label)}</div>
      <div class="value">${escapeHtml(it.value)}</div>
      ${it.delta ? `<div class="delta ${it.good ? 'good' : it.bad ? 'bad' : ''}">${escapeHtml(it.delta)}</div>` : ''}
    </div>`).join('')}</div>`;
}

/* ---------- 操作 1：回放原入场安排（preset） ---------- */
const btnReplay = document.querySelector('#btn-replay');
btnReplay.addEventListener('click', async () => {
  clearError();
  setBusy([btnReplay, document.querySelector('#btn-compare'), document.querySelector('#btn-queues')], true);
  try {
    const data = await api('/api/replay', closurePayload());
    renderReplay(data);
  } catch (err) { showError(err); } finally {
    setBusy([btnReplay, document.querySelector('#btn-compare'), document.querySelector('#btn-queues')], false);
  }
});

function renderReplay(data) {
  setResult(`
    <h2 class="section-title">事件回放 · 原入场安排（预先分流）<span class="tag">容量版本 ${escapeHtml(data.capacityVersion)}</span></h2>
    <div class="panel">
      <h3>回放控制</h3>
      <p class="panel-sub">按秒重放关闸/重开事件与队列变化；同一批到场、同一重开边界下，可与动态切换对照。</p>
      <div class="replayer">
        <button class="btn btn-primary" id="rp-play" type="button">▶ 播放</button>
        <div class="replay-progress"><span id="rp-bar"></span></div>
        <span id="rp-count" style="color:var(--text-muted);font-size:12px;font-variant-numeric:tabular-nums">0 / ${data.eventCount}</span>
      </div>
      <div class="replay-log" id="rp-log"></div>
    </div>
    <div class="panel">
      <h3>回放结束后的汇总（真实模拟结果）</h3>
      ${tiles([
        { label: '总到场（人）', value: data.totals.totalArrivals },
        { label: '已入场（人）', value: data.totals.totalAdmitted },
        { label: '剩余队列（人）', value: data.totals.leftover },
        { label: '最长等待（秒）', value: data.totals.maxWaitSeconds },
        { label: '合流处峰值等待（人）', value: data.totals.maxMergeWaiting },
      ])}
    </div>`, 'replay');

  const log = document.querySelector('#rp-log');
  const bar = document.querySelector('#rp-bar');
  const count = document.querySelector('#rp-count');
  const play = document.querySelector('#rp-play');
  let idx = 0, timer = null;

  const lineFor = (ev) => {
    if (ev.type === 'gate_closed') return [ev.second, '关闸', `${ev.gateId} 通道关闭（${escapeHtml(ev.reason)}），该通道起零服务`];
    if (ev.type === 'gate_reopened') return [ev.second, '重开', `${ev.gateId} 通道重开，当秒恢复 ${ev.gateId === 'A' ? 6 : 4} 人/秒能力`];
    const q = ev.gates.map((g) => `${g.gateId} 队列 ${g.queueLength}（本秒服务 ${g.served}${g.closed ? '，关闭中' : ''}）`).join('；');
    return [ev.second, 'tick', `到场 ${ev.arrivals}；${q}；合流等待 ${ev.merge.waitingTotal}`];
  };

  function paint(n) {
    log.innerHTML = data.events.slice(0, n).map((ev) => {
      const [sec, kind, text] = lineFor(ev);
      const cls = ev.type === 'gate_closed' ? 'event-closed' : ev.type === 'gate_reopened' ? 'event-reopened' : '';
      return `<div class="log-row ${cls}"><span class="sec">${sec}s</span><span class="kind">${kind}</span><span>${text}</span></div>`;
    }).join('');
    log.scrollTop = log.scrollHeight;
    bar.style.width = `${(n / data.eventCount) * 100}%`;
    count.textContent = `${n} / ${data.eventCount}`;
  }
  paint(0);

  play.addEventListener('click', () => {
    if (timer) { clearInterval(timer); timer = null; play.textContent = '▶ 播放'; return; }
    if (idx >= data.eventCount) { idx = 0; paint(0); }
    play.textContent = '⏸ 暂停';
    timer = setInterval(() => {
      idx += 1;
      paint(idx);
      if (idx >= data.eventCount) { clearInterval(timer); timer = null; play.textContent = '▶ 重新播放'; }
    }, 220);
  });
}

/* ---------- 操作 2：关闭一条通道再重开（双策略对比） ---------- */
const btnCompare = document.querySelector('#btn-compare');
btnCompare.addEventListener('click', async () => {
  clearError();
  setBusy([btnReplay, btnCompare, document.querySelector('#btn-queues')], true);
  try {
    const data = await api('/api/compare', closurePayload());
    renderCompare(data);
  } catch (err) { showError(err); } finally {
    setBusy([btnReplay, btnCompare, document.querySelector('#btn-queues')], false);
  }
});

function timelineSeries(result, gateId, key) {
  return result.timeline.map((snap) => snap.gates.find((g) => g.gateId === gateId)[key]);
}
function mergeSeries(result) {
  return result.timeline.map((snap) => snap.merge.waitingTotal);
}

function renderCompare(data) {
  const c = data.closures[0];
  const closureText = c ? `${c.gateId} 通道 [${c.closeAtSecond}s, ${c.reopenAtSecond}s) 关闭，${c.reopenAtSecond}s 整重开` : '无关闸事件';
  const d = data.differences;
  setResult(`
    <h2 class="section-title">关闭一条通道再重开 · 预先分流 vs 动态切换
      <span class="tag">同一容量版本 ${escapeHtml(data.shared.capacityVersion)} · 同一重开边界</span></h2>
    <div class="panel">
      <h3>边界条件（两路完全一致）</h3>
      <p class="panel-sub">${escapeHtml(closureText)}；总到场 ${data.shared.totalArrivals} 人；
      闸机能力 ${data.shared.gates.map((g) => `${g.id}=${g.capacity}/秒`).join('，')}。
      区别仅在每秒新人的通道选择：预先分流按能力固定比例，动态切换只把新人分给开放通道。</p>
    </div>
    ${tiles([
      {
        label: '最长等待差（预先−动态，秒）', value: d.maxWaitSecondsDelta,
        delta: d.maxWaitSecondsDelta > 0 ? '动态更优' : d.maxWaitSecondsDelta < 0 ? '预先分流更优' : '持平',
        good: d.maxWaitSecondsDelta >= 0, bad: d.maxWaitSecondsDelta < 0,
      },
      {
        label: '排队人·秒差（预先−动态）', value: d.totalQueueSecondsDelta,
        delta: d.totalQueueSecondsDelta > 0 ? '动态聚合等待更少' : d.totalQueueSecondsDelta < 0 ? '动态聚合等待更多' : '持平',
        good: d.totalQueueSecondsDelta >= 0, bad: d.totalQueueSecondsDelta < 0,
      },
      { label: '已入场者等待秒数差（人·秒）', value: d.servedWaitSecondsDelta, delta: '受模拟末仍在队人数影响，可正可负' },
      {
        label: '合流峰值等待差（人）', value: d.maxMergeWaitingDelta,
        delta: d.maxMergeWaitingDelta > 0 ? '动态峰值更低' : d.maxMergeWaitingDelta < 0 ? '动态峰值更高' : '峰值相同',
      },
      {
        label: '剩余队列差（人）', value: d.leftoverDelta,
        delta: d.leftoverDelta > 0 ? '动态剩余更少' : d.leftoverDelta < 0 ? '动态剩余更多' : '剩余相同',
        good: d.leftoverDelta >= 0, bad: d.leftoverDelta < 0,
      },
    ])}
    <div class="two-col">
      <div class="panel">
        <h3>预先分流：两路剩余队列</h3>
        <p class="panel-sub">关闸期间分配给被关通道的人在该队列里等待，不会改派。</p>
        ${chart({
          series: data.shared.gates.map((g) => ({ name: `${g.id} 队列`, data: timelineSeries(data.preset, g.id, 'queueLength'), color: HEX[g.id] })),
          horizon: data.shared.horizon, closures: data.closures, yLabel: '预先分流各通道队列长度',
        })}
      </div>
      <div class="panel">
        <h3>动态切换：两路剩余队列</h3>
        <p class="panel-sub">关闸期间新人只进入开放通道，被关通道队列只出不进（关闭时出=0）。</p>
        ${chart({
          series: data.shared.gates.map((g) => ({ name: `${g.id} 队列`, data: timelineSeries(data.dynamic, g.id, 'queueLength'), color: HEX[g.id] })),
          horizon: data.shared.horizon, closures: data.closures, yLabel: '动态切换各通道队列长度',
        })}
      </div>
    </div>
    <div class="panel">
      <h3>两路合流处的等待人数</h3>
      <p class="panel-sub">两条通道剩余队列之和。同一批到场与同一重开边界下，两策略瞬时队列互有高低；动态切换在模拟末剩余更少、最长等待更短（见上方指标卡）。</p>
      ${chart({
        series: [
          { name: '预先分流·合流等待', data: mergeSeries(data.preset), color: HEX.merge },
          { name: '动态切换·合流等待', data: mergeSeries(data.dynamic), color: HEX.A },
        ],
        horizon: data.shared.horizon, closures: data.closures, yLabel: '合流等待人数',
      })}
    </div>
    <div class="panel">
      <h3>分通道汇总对照</h3>
      <div class="table-scroll"><table class="data-table">
        <thead><tr><th>通道 / 策略</th><th>分配人数</th><th>服务人数</th><th>峰值队列</th><th>最长等待(秒)</th><th>等待总量(人·秒)</th><th>关闭秒数</th></tr></thead>
        <tbody>
          ${['preset', 'dynamic'].map((key) => data[key].gateStats.map((g) => `
            <tr><td><span class="gate-badge gate-${g.gateId.toLowerCase()}">${g.gateId} · ${key === 'preset' ? '预先分流' : '动态切换'}</span></td>
            <td>${g.assignedTotal}</td><td>${g.servedTotal}</td><td>${g.maxQueueLength}</td>
            <td>${g.maxWaitSeconds}</td><td>${g.totalWaitSeconds}</td><td>${g.closureSeconds}</td></tr>`).join('')).join('')}
        </tbody>
      </table></div>
    </div>`, 'compare');
  bindAllCharts();
}

/* ---------- 操作 3：查看各队列等待 ---------- */
const btnQueues = document.querySelector('#btn-queues');
btnQueues.addEventListener('click', async () => {
  clearError();
  setBusy([btnReplay, btnCompare, btnQueues], true);
  try {
    const strategy = document.querySelector('#queue-strategy').value;
    const [data, scenario] = await Promise.all([
      api('/api/queues', { strategy, ...closurePayload() }),
      fetch('/api/scenario').then((r) => r.json()),
    ]);
    renderQueues(data, scenario);
  } catch (err) { showError(err); } finally {
    setBusy([btnReplay, btnCompare, btnQueues], false);
  }
});

function renderQueues(data, scenario) {
  const closures = scenario.closures;
  setResult(`
    <h2 class="section-title">各队列等待 · ${data.strategy === 'preset' ? '预先分流' : '动态切换'}
      <span class="tag">容量版本 ${escapeHtml(data.capacityVersion)}</span></h2>
    <div class="panel">
      <h3>每条通道的剩余队列长度（按秒）</h3>
      <p class="panel-sub">合流等待 = 两条通道剩余队列之和，另用紫色单独绘制。</p>
      ${chart({
        series: [
          ...data.gates.map((g) => ({ name: `${g.gateId} 队列剩余`, data: g.queueLengthSeries, color: HEX[g.gateId] })),
          { name: '两路合流等待', data: data.merge.waitingTotalSeries, color: HEX.merge },
        ],
        horizon: data.horizonSeconds, closures, yLabel: '各队列剩余长度与合流等待',
      })}
    </div>
    <div class="panel">
      <h3>每秒到场需求（关闸期间用橙色柱标出）</h3>
      ${arrivalBars(scenario.arrivalsPerSecond, closures)}
    </div>
    <div class="two-col">
      ${data.gates.map((g) => `
        <div class="panel">
          <h3><span class="gate-badge gate-${g.gateId.toLowerCase()}">${g.gateId} 通道</span>（能力 ${g.capacity}/秒）</h3>
          ${tiles([
            { label: '峰值队列（人）', value: g.maxQueueLength },
            { label: '最长等待（秒）', value: g.maxWaitSeconds },
            { label: '等待总量（人·秒）', value: g.totalWaitSeconds },
            { label: '关闭秒数', value: g.closureSeconds },
          ])}
        </div>`).join('')}
    </div>
    <div class="panel">
      <h3>模拟末仍在队列中的人（剩余队列明细）</h3>
      ${Object.keys(data.finalQueues).length === 0
        ? '<p class="panel-sub">无：所有到场者均已在模拟时长内入场。</p>'
        : `<div class="table-scroll"><table class="data-table"><thead><tr><th>通道</th><th>人员</th><th>到场秒</th><th>截至模拟末已等待(秒)</th></tr></thead><tbody>
          ${Object.entries(data.finalQueues).flatMap(([gateId, list]) => list.map((p) => `
            <tr><td>${gateId}</td><td>${p.id}</td><td>${p.arrivalSecond}</td><td>${p.waitedUpToHorizon}</td></tr>`)).join('')}
        </tbody></table></div>`}
    </div>
    <div class="panel">
      <h3>逐秒队列数据（表格视图）</h3>
      <div class="table-scroll"><table class="data-table">
        <thead><tr><th>秒</th>${data.gates.map((g) => `<th>${g.gateId}剩余</th><th>${g.gateId}在等人·秒</th><th>${g.gateId}本秒服务</th>`).join('')}<th>合流剩余</th><th>合流本秒通过</th></tr></thead>
        <tbody>${Array.from({ length: data.horizonSeconds }, (_, t) => `
          <tr><td>${t}s</td>
          ${data.gates.map((g) => `<td>${g.queueLengthSeries[t]}</td><td>${g.waitingWaitSecondsSeries[t]}</td><td>${g.servedSeries[t]}</td>`).join('')}
          <td>${data.merge.waitingTotalSeries[t]}</td><td>${data.merge.throughputSeries[t]}</td></tr>`).join('')}
        </tbody>
      </table></div>
    </div>`, 'queues');
  bindAllCharts();
}

/* ---------- 启动 ---------- */
loadScenario().catch(showError);
