// 服务端共享状态：一个容量版本注册中心 + 合成样例场景。
// HTTP 的每一条请求都从这里 resolve 同一个容量版本，保证路线分配与事件回放不串版本。

import { CapacityRegistry } from './capacity.js';
import { buildSampleScenario, validateScenario, ScenarioValidationError } from './scenario.js';
import { STRATEGIES } from './engine.js';

export const CAPACITY_VERSION = 'cap-v1';

export function createAppState() {
  const registry = new CapacityRegistry();
  // 两路合流：A 每秒 6 人、B 每秒 4 人
  registry.publish(CAPACITY_VERSION, { A: 6, B: 4 });
  const capacities = registry.resolve(CAPACITY_VERSION);
  const scenario = buildSampleScenario(CAPACITY_VERSION);
  validateScenario(scenario, capacities);
  return { registry, scenario, capacities };
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export function parseStrategy(body) {
  const strategy = body?.strategy ?? 'preset';
  if (!STRATEGIES.includes(strategy)) {
    throw new HttpError(400, `strategy 必须是 ${STRATEGIES.join(' / ')} 之一，收到 ${String(strategy)}`);
  }
  return strategy;
}

export function parseGateId(body, state) {
  const gateId = body?.gateId;
  if (typeof gateId !== 'string' || gateId === '') {
    throw new HttpError(400, 'gateId 必须是非空字符串');
  }
  const known = state.scenario.gates.map((g) => g.id);
  if (!known.includes(gateId)) {
    throw new HttpError(400, `闸机 ${gateId} 不存在，可选: ${known.join(', ')}`);
  }
  return gateId;
}

// 以样例场景为底构造关闸事件（用于「关闭一条通道再重开」按钮，可选择关哪台）。
// 容量版本保持不变，只是在同一版本的能力表上叠加事件。
// - replace=true：只保留本次事件（页面按钮的默认语义：换成关另一条通道）；
// - extraClosures：在样例自带事件之外追加的事件（用于构造多路同关等边界）。
export function scenarioWithClosure(
  baseScenario,
  capacities,
  gateId,
  closeAtSecond,
  reopenAtSecond,
  { replace = false, extraClosures = [] } = {},
) {
  const primary = { gateId, closeAtSecond, reopenAtSecond, reason: '页面操作：关闭一条通道再重开' };
  const closures = replace
    ? [primary]
    : [...(baseScenario.closures ?? []), primary, ...extraClosures];
  const derived = {
    ...baseScenario,
    id: `${baseScenario.id}--close-${gateId}-${closeAtSecond}-${reopenAtSecond}`,
    closures,
  };
  validateScenario(derived, capacities); // 失败会抛 ScenarioValidationError（含全关/重叠/越界等）
  return derived;
}

export { ScenarioValidationError };
