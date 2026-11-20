// 离散秒级模拟引擎。
// 关键约束（对应题意）：
// 1. 一个人一旦被分到某通道（入场），就固定在该通道队列里，任何后续秒都不会再被改派；
// 2. 关闸区间 [closeAtSecond, reopenAtSecond) 内该通道零服务，队列只进不出，重开当秒恢复；
// 3. 两种策略拿到的是同一份 capacities（同一容量版本）和同一份到场/事件数据，
//    差别只在「每秒把新人分到哪条通道」这一步。

import { isClosedAt, validateScenario } from './scenario.js';

export class SimulationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SimulationError';
  }
}

export const STRATEGIES = ['preset', 'dynamic'];

// 最大余数法按权重（闸机能力）分摊整数人数，保证分摊之和严格等于 total。
export function apportion(total, weights) {
  const keys = Object.keys(weights);
  const weightSum = keys.reduce((s, k) => s + weights[k], 0);
  if (weightSum <= 0) throw new SimulationError('分摊权重之和必须为正');
  const exact = keys.map((k) => (total * weights[k]) / weightSum);
  const floors = exact.map((x) => Math.floor(x));
  let remainder = total - floors.reduce((s, x) => s + x, 0);
  // 小数部分大的优先补 1，平局时按闸机 id 排序保证结果确定
  const order = keys
    .map((k, i) => ({ k, frac: exact[i] - floors[i], i }))
    .sort((a, b) => b.frac - a.frac || a.k.localeCompare(b.k));
  const result = {};
  keys.forEach((k, i) => { result[k] = floors[i]; });
  for (const item of order) {
    if (remainder <= 0) break;
    result[item.k] += 1;
    remainder -= 1;
  }
  return result;
}

function emptyGateStat(gateId, capacity) {
  return {
    gateId,
    capacity,
    assignedTotal: 0,
    servedTotal: 0,
    leftover: 0,
    maxQueueLength: 0,
    totalWaitSeconds: 0,
    maxWaitSeconds: 0,
    closureSeconds: 0,
  };
}

export function simulate(scenario, capacities, strategy) {
  if (!STRATEGIES.includes(strategy)) {
    throw new SimulationError(`未知策略 ${strategy}，支持: ${STRATEGIES.join(', ')}`);
  }
  validateScenario(scenario, capacities);

  const gateIds = scenario.gates.map((g) => g.id);
  const queues = new Map(gateIds.map((id) => [id, []]));
  const stats = new Map(gateIds.map((id) => [id, emptyGateStat(id, capacities[id])]));
  const persons = [];
  const timeline = [];
  let personSeq = 0;
  let cumulativeAdmitted = 0;
  let maxMergeWaiting = 0;
  let totalQueueSeconds = 0; // 每秒末在队人数之和，用于守恒校验

  for (let t = 0; t < scenario.horizonSeconds; t += 1) {
    const closedGates = gateIds.filter((id) => isClosedAt(scenario, id, t));
    const openGates = gateIds.filter((id) => !closedGates.includes(id));
    closedGates.forEach((id) => { stats.get(id).closureSeconds += 1; });

    // ---- 1. 本秒到场 ----
    const arrivals = scenario.arrivalsPerSecond[t];
    const newPersons = [];
    for (let i = 0; i < arrivals; i += 1) {
      const p = {
        id: `p${personSeq++}`,
        arrivalSecond: t,
        gateId: null,
        assignedSecond: null,
        admittedSecond: null,
        waitSeconds: null,
        status: 'arrived',
      };
      persons.push(p);
      newPersons.push(p);
    }

    // ---- 2. 路线分配（入场）。已在队列里的人绝不参与重新分配 ----
    let plan;
    if (newPersons.length > 0) {
      if (strategy === 'preset') {
        // 预先分流：按设计能力固定比例切分到场流，关闸也不改派，B 的份额在 B 队列里等
        const weights = Object.fromEntries(gateIds.map((id) => [id, capacities[id]]));
        plan = apportion(newPersons.length, weights);
      } else {
        // 动态切换：只把新人分给当前开放的通道，按开放能力加权
        const weights = Object.fromEntries(openGates.map((id) => [id, capacities[id]]));
        plan = apportion(newPersons.length, weights);
        closedGates.forEach((id) => { plan[id] = 0; });
      }
    } else {
      plan = Object.fromEntries(gateIds.map((id) => [id, 0]));
    }

    let cursor = 0;
    for (const gateId of gateIds) {
      const take = plan[gateId] ?? 0;
      const slice = newPersons.slice(cursor, cursor + take);
      cursor += take;
      for (const p of slice) {
        p.gateId = gateId; // 入场后终身固定，不再改派
        p.assignedSecond = t;
        p.status = 'waiting';
        queues.get(gateId).push(p);
      }
      stats.get(gateId).assignedTotal += take;
    }
    if (cursor !== newPersons.length) {
      throw new SimulationError('内部分摊人数与到场人数不一致');
    }

    // ---- 3. 各开放通道按能力 FIFO 服务；关闭通道零服务 ----
    const perGate = gateIds.map((gateId) => {
      const closed = closedGates.includes(gateId);
      const queue = queues.get(gateId);
      const stat = stats.get(gateId);
      let served = 0;
      let servedWaitSeconds = 0;
      if (!closed) {
        const budget = Math.min(capacities[gateId], queue.length);
        for (let i = 0; i < budget; i += 1) {
          const p = queue.shift();
          p.admittedSecond = t;
          p.waitSeconds = t - p.arrivalSecond;
          p.status = 'admitted';
          served += 1;
          servedWaitSeconds += p.waitSeconds;
          stat.totalWaitSeconds += p.waitSeconds;
          stat.maxWaitSeconds = Math.max(stat.maxWaitSeconds, p.waitSeconds);
        }
      }
      stat.servedTotal += served;
      cumulativeAdmitted += served;
      stat.maxQueueLength = Math.max(stat.maxQueueLength, queue.length);
      const waitingWaitSeconds = queue.reduce((s, p) => s + (t - p.arrivalSecond), 0);
      return {
        gateId,
        closed,
        capacity: capacities[gateId],
        newAssigned: plan[gateId] ?? 0,
        served,
        servedWaitSeconds,
        queueLength: queue.length,
        waitingWaitSeconds,
      };
    });

    const mergeWaiting = perGate.reduce((s, g) => s + g.queueLength, 0);
    maxMergeWaiting = Math.max(maxMergeWaiting, mergeWaiting);
    totalQueueSeconds += mergeWaiting;
    timeline.push({
      second: t,
      arrivals,
      closedGates,
      gates: perGate,
      merge: {
        waitingTotal: mergeWaiting, // 两路合流处的等待人数（两条队列剩余之和）
        throughputThisSecond: perGate.reduce((s, g) => s + g.served, 0),
        cumulativeAdmitted,
      },
    });
  }

  // 收尾：模拟结束仍在队列里的人
  let leftover = 0;
  for (const gateId of gateIds) {
    const q = queues.get(gateId);
    stats.get(gateId).leftover = q.length;
    leftover += q.length;
  }

  const gateStats = gateIds.map((id) => ({ ...stats.get(id) }));
  const totalWaitSeconds = gateStats.reduce((s, g) => s + g.totalWaitSeconds, 0);
  const maxWaitSeconds = gateStats.reduce((m, g) => Math.max(m, g.maxWaitSeconds), 0);

  return {
    strategy,
    capacityVersion: scenario.capacityVersion,
    horizonSeconds: scenario.horizonSeconds,
    totalArrivals: persons.length,
    totalAdmitted: cumulativeAdmitted,
    leftover,
    totalWaitSeconds,
    maxWaitSeconds,
    maxMergeWaiting,
    totalQueueSeconds,
    gateStats,
    timeline,
    persons,
  };
}

// 同一批到场、同一关闸/重开边界、同一容量版本下跑两种策略，输出可对比结果。
export function compareStrategies(scenario, capacities) {
  const preset = simulate(scenario, capacities, 'preset');
  const dynamic = simulate(scenario, capacities, 'dynamic');
  return {
    shared: {
      capacityVersion: scenario.capacityVersion,
      horizonSeconds: scenario.horizonSeconds,
      totalArrivals: preset.totalArrivals,
      closures: scenario.closures ?? [],
      gates: scenario.gates.map((g) => ({ id: g.id, label: g.label ?? g.id, capacity: capacities[g.id] })),
    },
    preset,
    dynamic,
    differences: {
      maxWaitSecondsDelta: preset.maxWaitSeconds - dynamic.maxWaitSeconds,
      // 动态切换不把新人送进关闭通道，聚合排队人·秒不高于预先分流，差值即动态减少的等待
      totalQueueSecondsDelta: preset.totalQueueSeconds - dynamic.totalQueueSeconds,
      servedWaitSecondsDelta: preset.totalWaitSeconds - dynamic.totalWaitSeconds,
      maxMergeWaitingDelta: preset.maxMergeWaiting - dynamic.maxMergeWaiting,
      leftoverDelta: preset.leftover - dynamic.leftover,
    },
  };
}
