// 场景定义与校验：按秒到场需求、各闸机能力、关闸/重开事件。
// 同一个场景对象会被「路线分配」和「事件回放」共同引用，保证两路合流对比公平。

export class ScenarioValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScenarioValidationError';
  }
}

function assert(condition, message) {
  if (!condition) throw new ScenarioValidationError(message);
}

export function validateScenario(scenario, capacities) {
  assert(scenario && typeof scenario === 'object', 'scenario 必须是对象');
  assert(Number.isInteger(scenario.horizonSeconds) && scenario.horizonSeconds > 0,
    'horizonSeconds 必须是正整数');
  assert(Array.isArray(scenario.arrivalsPerSecond), 'arrivalsPerSecond 必须是数组');
  assert(scenario.arrivalsPerSecond.length === scenario.horizonSeconds,
    `arrivalsPerSecond 长度 ${scenario.arrivalsPerSecond.length} 与 horizonSeconds ${scenario.horizonSeconds} 不一致`);
  scenario.arrivalsPerSecond.forEach((n, t) => {
    assert(Number.isInteger(n) && n >= 0, `第 ${t} 秒到场人数必须是非负整数，收到 ${n}`);
  });

  const gateIds = Object.keys(capacities);
  assert(Array.isArray(scenario.gates) && scenario.gates.length >= 1, 'gates 至少要有一台闸机');
  const seen = new Set();
  for (const g of scenario.gates) {
    assert(g && typeof g.id === 'string' && g.id !== '', '闸机 id 必须是非空字符串');
    assert(!seen.has(g.id), `闸机 id 重复: ${g.id}`);
    seen.add(g.id);
    assert(Object.prototype.hasOwnProperty.call(capacities, g.id),
      `闸机 ${g.id} 在容量版本 ${scenario.capacityVersion} 中没有能力数据`);
  }

  const closures = scenario.closures ?? [];
  assert(Array.isArray(closures), 'closures 必须是数组');
  const busy = new Map(); // gateId -> 已占用的关闭区间
  for (const c of closures) {
    assert(c && typeof c.gateId === 'string', 'closure.gateId 必须是字符串');
    assert(seen.has(c.gateId), `closure 引用了不存在的闸机: ${c.gateId}`);
    assert(Number.isInteger(c.closeAtSecond) && Number.isInteger(c.reopenAtSecond),
      'closure 的 closeAtSecond/reopenAtSecond 必须是整数秒');
    assert(c.closeAtSecond >= 0, `闸机 ${c.gateId} 的 closeAtSecond 不能为负`);
    assert(c.reopenAtSecond > c.closeAtSecond,
      `闸机 ${c.gateId} 的重开时刻 ${c.reopenAtSecond} 必须晚于关闭时刻 ${c.closeAtSecond}`);
    assert(c.reopenAtSecond <= scenario.horizonSeconds,
      `闸机 ${c.gateId} 的重开时刻超出模拟时长 ${scenario.horizonSeconds}`);
    const ranges = busy.get(c.gateId) ?? [];
    for (const [a, b] of ranges) {
      assert(c.reopenAtSecond <= a || c.closeAtSecond >= b,
        `闸机 ${c.gateId} 存在重叠的关闸区间`);
    }
    ranges.push([c.closeAtSecond, c.reopenAtSecond]);
    busy.set(c.gateId, ranges);
  }

  // 边界校验：至少要留一台闸机在每个秒都能服务，否则全关即死锁
  for (let t = 0; t < scenario.horizonSeconds; t += 1) {
    const openGates = scenario.gates.filter((g) => !isClosedAt(scenario, g.id, t));
    assert(openGates.length >= 1, `第 ${t} 秒所有闸机均关闭，系统无法服务`);
  }
  return true;
}

// 秒 t（处理第 t 秒到场与服务的那个区间）闸机是否处于关闭状态。
// 约定：[closeAtSecond, reopenAtSecond) 内关闭，reopenAtSecond 当秒恢复服务，
// 即「重开时刻相同」的两次模拟在同一秒边界恢复能力。
export function isClosedAt(scenario, gateId, second) {
  const closures = scenario.closures ?? [];
  return closures.some(
    (c) => c.gateId === gateId && second >= c.closeAtSecond && second < c.reopenAtSecond,
  );
}

// 合成样例：两台闸机（A 能力 6/秒，B 能力 4/秒，合计 10/秒），
// B 在第 10 秒关闭、第 16 秒重开；到场呈低-高-回落的波峰形态。
export function buildSampleScenario(capacityVersion) {
  const horizonSeconds = 30;
  const pattern = [
    6, 7, 8, 9, 10, 12, 14, 13, 11, 10,
    12, 13, 12, 11, 10, 9,
    10, 11, 9, 8, 7, 6, 6, 5, 5, 5, 4, 4, 3, 3,
  ];
  return {
    id: 'sample-peak',
    label: '合成样例：双闸机波峰到场 + B 通道临时关闸',
    capacityVersion,
    horizonSeconds,
    arrivalsPerSecond: pattern.slice(0, horizonSeconds),
    gates: [
      { id: 'A', label: 'A 通道' },
      { id: 'B', label: 'B 通道' },
    ],
    closures: [
      { gateId: 'B', closeAtSecond: 10, reopenAtSecond: 16, reason: '临时关闸（样例）' },
    ],
  };
}
