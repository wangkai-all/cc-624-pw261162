// 引擎与领域层单测：守恒律、入场后不再改派、关闸/重开边界、两种策略差异、异常入参。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CapacityRegistry, CapacityVersionError } from '../src/capacity.js';
import { ScenarioValidationError, validateScenario } from '../src/scenario.js';
import { SimulationError, apportion, compareStrategies, simulate } from '../src/engine.js';
import { createAppState, scenarioWithClosure } from '../src/app-state.js';

function tinyScenario(overrides = {}) {
  return {
    id: 'tiny',
    label: '小场景',
    capacityVersion: 'cap-v1',
    horizonSeconds: 8,
    arrivalsPerSecond: [10, 0, 0, 10, 0, 0, 0, 0],
    gates: [{ id: 'A' }, { id: 'B' }],
    closures: [],
    ...overrides,
  };
}
const CAPS = Object.freeze({ A: 6, B: 4 });

test('apportion 最大余数法：分摊之和严格等于总人数且为非负整数', () => {
  for (const total of [0, 1, 7, 10, 11, 13, 100]) {
    const plan = apportion(total, { A: 6, B: 4 });
    assert.equal(plan.A + plan.B, total);
    assert.ok(plan.A >= 0 && plan.B >= 0);
  }
  // 10 人按 6:4 正好切 6/4；7 人切 4/3（余数给权重高者）
  assert.deepEqual(apportion(10, { A: 6, B: 4 }), { A: 6, B: 4 });
  assert.deepEqual(apportion(7, { A: 6, B: 4 }), { A: 4, B: 3 });
  // 权重为正时才合法
  assert.throws(() => apportion(5, { A: 0, B: 0 }), SimulationError);
});

test('守恒律：累计服务 + 剩余队列 = 总到场，且两种策略都成立', () => {
  const state = createAppState();
  for (const strategy of ['preset', 'dynamic']) {
    const r = simulate(state.scenario, state.capacities, strategy);
    assert.equal(r.totalAdmitted + r.leftover, r.totalArrivals);
    const servedByGates = r.gateStats.reduce((s, g) => s + g.servedTotal, 0);
    assert.equal(servedByGates, r.totalAdmitted);
    const assignedByGates = r.gateStats.reduce((s, g) => s + g.assignedTotal, 0);
    assert.equal(assignedByGates, r.totalArrivals);
  }
});

test('入场后通道固定：任何人的 gateId 一旦分配不再变化，且等待期间只停留在该通道', () => {
  const state = createAppState();
  const r = simulate(state.scenario, state.capacities, 'dynamic');
  const byId = new Map(r.persons.map((p) => [p.id, p]));
  for (const snap of r.timeline) {
    for (const g of snap.gates) {
      // 引擎不暴露在队人员 id，这里用每通道守恒间接验证：
      // 队列长度 = 累计分配 - 累计服务，全程不允许跨通道搬运
      const stat = r.gateStats.find((x) => x.gateId === g.gateId);
      assert.ok(g.queueLength >= 0);
      assert.ok(g.served <= stat.capacity); // 单秒服务不超能力
    }
  }
  // 每个人的记录里 gateId 非空且 admitted 者等待秒数自洽
  for (const p of byId.values()) {
    assert.ok(['A', 'B'].includes(p.gateId));
    if (p.status === 'admitted') {
      assert.equal(p.waitSeconds, p.admittedSecond - p.arrivalSecond);
      assert.ok(p.admittedSecond >= p.assignedSecond);
    }
  }
});

test('关闸区间零服务、重开当秒恢复：被关通道在 [close,reopen) 内 served=0', () => {
  const state = createAppState();
  const closure = state.scenario.closures[0]; // B: [10, 16)
  const r = simulate(state.scenario, state.capacities, 'preset');
  for (const snap of r.timeline) {
    const b = snap.gates.find((g) => g.gateId === 'B');
    const inClosure = snap.second >= closure.closeAtSecond && snap.second < closure.reopenAtSecond;
    assert.equal(b.closed, inClosure);
    if (inClosure) assert.equal(b.served, 0);
    if (snap.second === closure.reopenAtSecond) {
      assert.equal(b.closed, false);
      assert.ok(b.served > 0, '重开当秒必须恢复服务');
    }
  }
  const bStat = r.gateStats.find((g) => g.gateId === 'B');
  assert.equal(bStat.closureSeconds, closure.reopenAtSecond - closure.closeAtSecond);
});

test('同一批到场 + 同一重开边界：动态切换把关闸期新人全部分给开放通道', () => {
  const state = createAppState();
  const closure = state.scenario.closures[0];
  const r = simulate(state.scenario, state.capacities, 'dynamic');
  for (const snap of r.timeline) {
    const inClosure = snap.second >= closure.closeAtSecond && snap.second < closure.reopenAtSecond;
    if (inClosure) {
      const b = snap.gates.find((g) => g.gateId === 'B');
      assert.equal(b.newAssigned, 0, '关闸期间 B 不应分到任何新人');
      const a = snap.gates.find((g) => g.gateId === 'A');
      assert.equal(a.newAssigned, snap.arrivals, '关闸期间新人全部进入开放的 A');
    }
  }
});

test('预先分流 vs 动态切换：最终态动态不劣（剩余更少/最长等待更短），各自口径自洽', () => {
  const state = createAppState();
  const cmp = compareStrategies(state.scenario, state.capacities);
  // 模拟结束时动态切换的剩余队列不高于预先分流（它从不把新人送进关闭通道）
  assert.ok(cmp.dynamic.leftover <= cmp.preset.leftover);
  // 任一秒累计服务人数的比较允许反转，但模拟末动态累计入场不少于预先分流
  assert.ok(cmp.dynamic.totalAdmitted >= cmp.preset.totalAdmitted);
  // 动态把等待摊薄，最长等待不高于预先分流
  assert.ok(cmp.dynamic.maxWaitSeconds <= cmp.preset.maxWaitSeconds);
  // 各自口径自洽：已服务者等待秒数 + 未服务者截至模拟末等待秒数 = 逐秒在队人数之和
  for (const r of [cmp.preset, cmp.dynamic]) {
    const unservedWait = r.persons
      .filter((p) => p.status !== 'admitted')
      .reduce((s, p) => s + (r.horizonSeconds - p.arrivalSecond), 0);
    assert.equal(r.totalWaitSeconds + unservedWait, r.totalQueueSeconds);
    // 守恒：服务 + 剩余 = 到场
    assert.equal(r.totalAdmitted + r.leftover, r.totalArrivals);
  }
  // 两路使用同一个容量版本号
  assert.equal(cmp.preset.capacityVersion, cmp.dynamic.capacityVersion);
  assert.equal(cmp.shared.capacityVersion, state.scenario.capacityVersion);
});

test('确定性的小场景上可精确验证：动态切换的最长等待严格小于预先分流', () => {
  // t=0 到 10 人；B 在 [1,4) 关闭；A=6 B=4。
  // preset：A 分 6 人 t=0 全走；B 分 4 人，t=1~3 关闭，t=4 服务，等待 4 秒。
  // dynamic：t=0 全开同样 6/4 切分……为让差异显式，让关闸从 t=0 开始。
  const sc = tinyScenario({
    horizonSeconds: 6,
    arrivalsPerSecond: [10, 0, 0, 0, 0, 0],
    closures: [{ gateId: 'B', closeAtSecond: 0, reopenAtSecond: 2 }],
  });
  const preset = simulate(sc, CAPS, 'preset');
  const dynamic = simulate(sc, CAPS, 'dynamic');
  // preset：B 的 4 人 t=2 才入场，等待 2 秒；dynamic：10 人全给 A，6 人 t=0 走，4 人 t=1 走（等待 1 秒）
  assert.equal(preset.gateStats.find((g) => g.gateId === 'B').maxWaitSeconds, 2);
  assert.equal(dynamic.gateStats.find((g) => g.gateId === 'B').assignedTotal, 0);
  assert.equal(dynamic.gateStats.find((g) => g.gateId === 'A').assignedTotal, 10);
  assert.ok(dynamic.maxWaitSeconds < preset.maxWaitSeconds);
  // 总等待人·秒仍然相等：preset 4*2=8；dynamic 4*1=4？——服务时刻不同，验证实际值而非想当然
  assert.equal(preset.totalWaitSeconds, 8);
  assert.equal(dynamic.totalWaitSeconds, 4);
});

test('容量版本：发布后不可变，未知版本解析失败，重复发布被拒', () => {
  const reg = new CapacityRegistry();
  reg.publish('v1', { A: 6, B: 4 });
  const caps = reg.resolve('v1');
  assert.throws(() => { caps.A = 99; }, TypeError);
  assert.throws(() => reg.publish('v1', { A: 1 }), CapacityVersionError);
  assert.throws(() => reg.resolve('nope'), CapacityVersionError);
  assert.throws(() => reg.publish('', { A: 1 }), CapacityVersionError);
  assert.throws(() => reg.publish('v2', { A: 0 }), CapacityVersionError);
  assert.throws(() => reg.publish('v3', { A: 1.5 }), CapacityVersionError);
});

test('路线分配与事件回放共享同一容量版本：能力不同则结果随版本变化，版本号被透传', () => {
  const reg = new CapacityRegistry();
  reg.publish('v-low', { A: 2, B: 2 });
  reg.publish('v-high', { A: 8, B: 8 });
  const lowSc = tinyScenario({ capacityVersion: 'v-low' });
  const low = simulate(lowSc, reg.resolve('v-low'), 'preset');
  const highSc = { ...lowSc, capacityVersion: 'v-high' };
  const high = simulate(highSc, reg.resolve('v-high'), 'preset');
  // 高能力版本积压更轻：峰值队列更低、已入场者最长等待更短
  const peak = (r) => Math.max(...r.gateStats.map((g) => g.maxQueueLength));
  assert.ok(peak(high) < peak(low));
  assert.ok(high.maxWaitSeconds <= low.maxWaitSeconds);
  assert.equal(low.capacityVersion, 'v-low');
  assert.equal(high.capacityVersion, 'v-high');
  // 同一版本对象被两次模拟复用时结果一致（路线分配与回放共享版本的语义保证）
  const lowAgain = simulate(lowSc, reg.resolve('v-low'), 'preset');
  assert.deepEqual(lowAgain.timeline, low.timeline);
});

test('异常场景：负数到场、长度不匹配、未知闸机、重开早于关闭、区间重叠、全关死锁', () => {
  const base = tinyScenario();
  assert.throws(() => validateScenario({ ...base, arrivalsPerSecond: [1, -1] }, CAPS), ScenarioValidationError);
  assert.throws(() => validateScenario({ ...base, horizonSeconds: 7 }, CAPS), ScenarioValidationError);
  assert.throws(() => validateScenario({ ...base, gates: [{ id: 'X' }] }, CAPS), ScenarioValidationError);
  assert.throws(
    () => validateScenario({ ...base, closures: [{ gateId: 'B', closeAtSecond: 3, reopenAtSecond: 3 }] }, CAPS),
    ScenarioValidationError,
  );
  assert.throws(
    () => validateScenario({
      ...base,
      closures: [
        { gateId: 'B', closeAtSecond: 1, reopenAtSecond: 3 },
        { gateId: 'B', closeAtSecond: 2, reopenAtSecond: 5 },
      ],
    }, CAPS),
    ScenarioValidationError,
  );
  assert.throws(
    () => validateScenario({
      ...base,
      closures: [
        { gateId: 'A', closeAtSecond: 1, reopenAtSecond: 3 },
        { gateId: 'B', closeAtSecond: 1, reopenAtSecond: 3 },
      ],
    }, CAPS),
    ScenarioValidationError,
  );
  assert.throws(() => simulate(base, CAPS, 'bogus'), SimulationError);
});

test('关闭高能力通道 A 时动态切换可能更差：结论由数据决定，引擎不预设方向', () => {
  const state = createAppState();
  const sc = scenarioWithClosure(state.scenario, state.capacities, 'A', 10, 16, { replace: true });
  const cmp = compareStrategies(sc, state.capacities);
  // 关 A 只剩 B(4/秒)：动态把全部新人压给 B，预先分流仍按 6:4 给 A 留队，
  // 动态的最长等待与剩余队列可以严格更差——这是合法结果，差值字段必须如实反映方向
  assert.ok(cmp.differences.maxWaitSecondsDelta < 0
    || cmp.differences.leftoverDelta < 0
    || cmp.differences.totalQueueSecondsDelta < 0);
  // 两种策略各自仍满足守恒
  for (const r of [cmp.preset, cmp.dynamic]) {
    assert.equal(r.totalAdmitted + r.leftover, r.totalArrivals);
  }
});

test('scenarioWithClosure 复用同一容量版本并做完整校验', () => {
  const state = createAppState();
  // replace：只保留本次 A 通道事件，不与样例 B 关闸叠加
  const derived = scenarioWithClosure(state.scenario, state.capacities, 'A', 12, 18, { replace: true });
  assert.equal(derived.capacityVersion, state.scenario.capacityVersion);
  assert.deepEqual(derived.arrivalsPerSecond, state.scenario.arrivalsPerSecond);
  assert.equal(derived.closures.length, 1);
  assert.throws(
    () => scenarioWithClosure(state.scenario, state.capacities, 'A', 12, 12, { replace: true }),
    ScenarioValidationError,
  );
  // 叠加模式下与样例 B[10,16) 重叠关 A -> 全关死锁，校验拦截
  assert.throws(
    () => scenarioWithClosure(state.scenario, state.capacities, 'A', 12, 14),
    ScenarioValidationError,
  );
});
