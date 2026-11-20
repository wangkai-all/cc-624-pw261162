// 视图层：把引擎的原始模拟结果整成页面/API 需要的结构。
// 这里不产生任何业务数字，只做投影和重排，数字全部来自 engine.simulate。

function gateMeta(scenario, capacities) {
  return scenario.gates.map((g) => ({
    id: g.id,
    label: g.label ?? g.id,
    capacityPerSecond: capacities[g.id],
  }));
}

export function scenarioView(state) {
  const { scenario, capacities, registry } = state;
  return {
    id: scenario.id,
    label: scenario.label,
    capacityVersion: scenario.capacityVersion,
    capacityVersions: registry.listVersions(),
    horizonSeconds: scenario.horizonSeconds,
    gates: gateMeta(scenario, capacities),
    arrivalsPerSecond: scenario.arrivalsPerSecond,
    closures: scenario.closures,
  };
}

export function simulateView(result, scenario, capacities) {
  return {
    strategy: result.strategy,
    capacityVersion: result.capacityVersion,
    horizonSeconds: result.horizonSeconds,
    totals: {
      totalArrivals: result.totalArrivals,
      totalAdmitted: result.totalAdmitted,
      leftover: result.leftover,
      totalWaitSeconds: result.totalWaitSeconds,
      maxWaitSeconds: result.maxWaitSeconds,
      maxMergeWaiting: result.maxMergeWaiting,
    },
    gates: gateMeta(scenario, capacities),
    gateStats: result.gateStats,
    timeline: result.timeline,
  };
}

// 事件回放：关闸/重开生命周期事件 + 每秒 tick，按发生顺序排好，页面逐条播放。
export function replayView(result, scenario) {
  const events = [];
  for (const c of scenario.closures ?? []) {
    events.push({
      type: 'gate_closed',
      second: c.closeAtSecond,
      gateId: c.gateId,
      reason: c.reason ?? '临时关闸',
    });
    events.push({
      type: 'gate_reopened',
      second: c.reopenAtSecond,
      gateId: c.gateId,
    });
  }
  for (const snap of result.timeline) {
    events.push({ type: 'tick', ...snap });
  }
  events.sort((a, b) => a.second - b.second || (a.type === 'tick' ? 1 : -1));
  return {
    strategy: result.strategy,
    capacityVersion: result.capacityVersion,
    scenarioId: scenario.id,
    closures: scenario.closures ?? [],
    eventCount: events.length,
    events,
    totals: {
      totalArrivals: result.totalArrivals,
      totalAdmitted: result.totalAdmitted,
      leftover: result.leftover,
      maxWaitSeconds: result.maxWaitSeconds,
      maxMergeWaiting: result.maxMergeWaiting,
    },
  };
}

// 各队列等待视图：每条通道的剩余队列长度/在等时长序列 + 两路合流序列 + 模拟末仍在队的人。
export function queueView(result) {
  const perGate = new Map();
  for (const g of result.gateStats) {
    perGate.set(g.gateId, {
      gateId: g.gateId,
      capacity: g.capacity,
      queueLengthSeries: [],
      waitingWaitSecondsSeries: [],
      servedSeries: [],
      closureSeconds: g.closureSeconds,
      maxQueueLength: g.maxQueueLength,
      maxWaitSeconds: g.maxWaitSeconds,
      totalWaitSeconds: g.totalWaitSeconds,
    });
  }
  const merge = {
    waitingTotalSeries: [],
    throughputSeries: [],
    cumulativeAdmittedSeries: [],
  };
  for (const snap of result.timeline) {
    for (const g of snap.gates) {
      const row = perGate.get(g.gateId);
      row.queueLengthSeries.push(g.queueLength);
      row.waitingWaitSecondsSeries.push(g.waitingWaitSeconds);
      row.servedSeries.push(g.served);
    }
    merge.waitingTotalSeries.push(snap.merge.waitingTotal);
    merge.throughputSeries.push(snap.merge.throughputThisSecond);
    merge.cumulativeAdmittedSeries.push(snap.merge.cumulativeAdmitted);
  }
  // 模拟结束时刻仍未入场的人（剩余队列明细）
  const finalQueues = {};
  for (const p of result.persons.filter((x) => x.status !== 'admitted')) {
    (finalQueues[p.gateId] ??= []).push({
      id: p.id,
      arrivalSecond: p.arrivalSecond,
      waitedUpToHorizon: result.horizonSeconds - p.arrivalSecond,
    });
  }
  return {
    strategy: result.strategy,
    capacityVersion: result.capacityVersion,
    horizonSeconds: result.horizonSeconds,
    gates: [...perGate.values()],
    merge,
    finalQueues,
  };
}

export function compareView(comparison, scenario) {
  return {
    shared: comparison.shared,
    scenarioId: scenario.id,
    closures: scenario.closures ?? [],
    differences: comparison.differences,
    preset: {
      totals: pickTotals(comparison.preset),
      gateStats: comparison.preset.gateStats,
      timeline: comparison.preset.timeline,
    },
    dynamic: {
      totals: pickTotals(comparison.dynamic),
      gateStats: comparison.dynamic.gateStats,
      timeline: comparison.dynamic.timeline,
    },
  };
}

function pickTotals(result) {
  return {
    totalArrivals: result.totalArrivals,
    totalAdmitted: result.totalAdmitted,
    leftover: result.leftover,
    totalWaitSeconds: result.totalWaitSeconds,
    maxWaitSeconds: result.maxWaitSeconds,
    maxMergeWaiting: result.maxMergeWaiting,
  };
}
