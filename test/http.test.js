// HTTP 层测试：真实监听 127.0.0.1 临时端口，经 fetch 走完整 JSON 处理流程。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from '../src/server.js';

const server = createServer();
let base;

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function post(path, payload) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });
}

test('GET / 首页含 data-evidence-result 业务结果区', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /data-evidence-result/);
  assert.match(html, /回放原入场安排/);
  assert.match(html, /关闭一条通道再重开/);
  assert.match(html, /查看各队列等待/);
});

test('静态资源与越界路径防护', async () => {
  const js = await fetch(`${base}/app.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  const escaped = await fetch(`${base}/../src/server.js`);
  // URL 规范化后 /../src/server.js 会被折叠，静态目录里不存在该文件 -> 404 或 403，绝不回源码
  assert.ok([403, 404].includes(escaped.status));
  const encoded = await fetch(`${base}/%2e%2e%2f%2e%2e%2fpackage.json`);
  assert.ok([403, 404].includes(encoded.status));
  const missing = await fetch(`${base}/nope.css`);
  assert.equal(missing.status, 404);
});

test('GET /api/scenario 返回合成样例与容量版本', async () => {
  const res = await fetch(`${base}/api/scenario`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.capacityVersion, 'cap-v1');
  assert.deepEqual(data.gates.map((g) => g.capacityPerSecond), [6, 4]);
  assert.equal(data.arrivalsPerSecond.length, data.horizonSeconds);
  assert.equal(data.closures[0].gateId, 'B');
});

test('POST /api/replay 回放原入场安排：事件按秒排序且含关闸/重开生命周期', async () => {
  const res = await post('/api/replay', {});
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.strategy, 'preset'); // 回放固定原入场安排
  const types = data.events.map((e) => e.type);
  assert.ok(types.includes('gate_closed'));
  assert.ok(types.includes('gate_reopened'));
  assert.ok(types.filter((t) => t === 'tick').length === 30);
  // 事件整体按秒升序；同秒内生命周期事件排在 tick 前
  for (let i = 1; i < data.events.length; i += 1) {
    const a = data.events[i - 1], b = data.events[i];
    assert.ok(a.second < b.second || (a.second === b.second && a.type !== 'tick'));
  }
  // 重开事件之后的第一个 tick：B 已恢复开放
  const reopen = data.events.find((e) => e.type === 'gate_reopened');
  const tickAfter = data.events.find((e) => e.type === 'tick' && e.second === reopen.second);
  const bGate = tickAfter.gates.find((g) => g.gateId === 'B');
  assert.equal(bGate.closed, false);
  assert.ok(bGate.served > 0);
  assert.equal(data.totals.totalAdmitted + data.totals.leftover, data.totals.totalArrivals);
});

test('POST /api/compare 同批到场同边界对比：最终态动态不劣、合流字段自洽', async () => {
  const res = await post('/api/compare', {});
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.preset.totals.totalArrivals, data.dynamic.totals.totalArrivals);
  // 每条时间线快照的合流字段都等于两通道队列之和（视图投影自洽）
  for (const side of ['preset', 'dynamic']) {
    for (const snap of data[side].timeline) {
      assert.equal(
        snap.merge.waitingTotal,
        snap.gates.reduce((s, g) => s + g.queueLength, 0),
      );
    }
  }
  // 最终态：动态剩余不更多、累计入场不更少、最长等待不更长
  assert.ok(data.dynamic.totals.leftover <= data.preset.totals.leftover);
  assert.ok(data.dynamic.totals.totalAdmitted >= data.preset.totals.totalAdmitted);
  assert.ok(data.dynamic.totals.maxWaitSeconds <= data.preset.totals.maxWaitSeconds);
  assert.equal(data.shared.capacityVersion, 'cap-v1');
  // 时间线逐秒带合流字段
  for (const side of ['preset', 'dynamic']) {
    for (const snap of data[side].timeline) {
      assert.equal(
        snap.merge.waitingTotal,
        snap.gates.reduce((s, g) => s + g.queueLength, 0),
      );
    }
  }
});

test('POST /api/queues 各队列等待：序列长度、合流序列与明细自洽', async () => {
  const res = await post('/api/queues', { strategy: 'dynamic' });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.strategy, 'dynamic');
  assert.equal(data.gates.length, 2);
  for (const g of data.gates) {
    assert.equal(g.queueLengthSeries.length, 30);
    assert.equal(g.servedSeries.length, 30);
  }
  for (let t = 0; t < 30; t += 1) {
    assert.equal(
      data.merge.waitingTotalSeries[t],
      data.gates.reduce((s, g) => s + g.queueLengthSeries[t], 0),
    );
  }
  // finalQueues 中每个人的归属通道与等待秒数合理
  for (const [gateId, list] of Object.entries(data.finalQueues)) {
    assert.ok(['A', 'B'].includes(gateId));
    for (const p of list) {
      assert.ok(p.waitedUpToHorizon >= 0 && p.waitedUpToHorizon <= 30);
    }
  }
});

test('自定义关闸事件：关闭 A 通道再重开，两种策略都接受且共享同一容量版本', async () => {
  const payload = { closure: { gateId: 'A', closeAtSecond: 5, reopenAtSecond: 9, replace: true } };
  const [simRes, cmpRes] = await Promise.all([
    post('/api/simulate', { strategy: 'preset', ...payload }),
    post('/api/compare', payload),
  ]);
  assert.equal(simRes.status, 200);
  assert.equal(cmpRes.status, 200);
  const sim = await simRes.json();
  const cmp = await cmpRes.json();
  assert.equal(sim.capacityVersion, 'cap-v1');
  assert.equal(cmp.shared.capacityVersion, 'cap-v1');
  assert.deepEqual(cmp.closures, [{ gateId: 'A', closeAtSecond: 5, reopenAtSecond: 9,
    reason: '页面操作：关闭一条通道再重开' }]);
  const closedTick = sim.timeline[5].gates.find((g) => g.gateId === 'A');
  assert.equal(closedTick.closed, true);
  assert.equal(closedTick.served, 0);
  assert.equal(sim.timeline[9].gates.find((g) => g.gateId === 'A').closed, false);
});

test('异常：非法 strategy、未知闸机、重开不晚于关闭、全关死锁、坏 JSON、未知版本均返回 400', async () => {
  const cases = [
    ['/api/simulate', { strategy: 'random' }],
    ['/api/queues', { strategy: 'dynamic', closure: { gateId: 'Z', closeAtSecond: 1, reopenAtSecond: 3 } }],
    ['/api/compare', { closure: { gateId: 'B', closeAtSecond: 10, reopenAtSecond: 10, replace: true } }],
    ['/api/simulate', { capacityVersion: 'does-not-exist' }],
  ];
  for (const [path, payload] of cases) {
    const res = await post(path, payload);
    assert.equal(res.status, 400, `${path} ${JSON.stringify(payload)} 应返回 400`);
    const body = await res.json();
    assert.equal(body.status, 400);
    assert.ok(typeof body.error === 'string' && body.error.length > 0);
  }

  // 全关死锁：样例自带 B[10,16)，再追加 A 在同一窗口关闭 -> 第 10~15 秒无开放闸机
  const realDeadlock = await post('/api/compare', {
    closure: { gateId: 'A', closeAtSecond: 10, reopenAtSecond: 14 },
    extraClosures: [],
  });
  // 注意：不替换时 A[10,14) 与样例 B[10,16) 重叠 => 全关
  assert.equal(realDeadlock.status, 400);
  assert.match((await realDeadlock.json()).error, /所有闸机均关闭/);

  // 坏 JSON
  const badJson = await fetch(`${base}/api/simulate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json',
  });
  assert.equal(badJson.status, 400);

  // 数组体不接受
  const arrBody = await post('/api/simulate', [1, 2, 3]);
  assert.equal(arrBody.status, 400);
});

test('未知路由 404，错误方法 405', async () => {
  const notFound = await fetch(`${base}/api/ghost`);
  assert.equal(notFound.status, 404);
  const methodNotAllowed = await fetch(`${base}/index.html`, { method: 'POST' });
  assert.equal(methodNotAllowed.status, 405);
});
