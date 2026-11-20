// HTTP 入口：只用 Node 内置模块。node server.js 启动，PORT 可覆盖，绑定 127.0.0.1。
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CapacityVersionError } from './capacity.js';
import { ScenarioValidationError } from './scenario.js';
import { SimulationError } from './engine.js';
import { simulate, compareStrategies } from './engine.js';
import {
  createAppState,
  HttpError,
  parseGateId,
  parseStrategy,
  scenarioWithClosure,
} from './app-state.js';
import {
  compareView,
  queueView,
  replayView,
  scenarioView,
  simulateView,
} from './views.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export function createServer(state = createAppState()) {
  async function readJsonBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1_048_576) throw new HttpError(413, '请求体超过 1MB 上限');
      chunks.push(chunk);
    }
    if (chunks.length === 0) return {};
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new HttpError(400, 'JSON 请求体必须是对象');
      }
      return parsed;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, `JSON 解析失败: ${err.message}`);
    }
  }

  // 每个请求都从注册中心按版本拿能力表——路线分配与事件回放因此共享同一容量版本。
  function capacitiesFor(body = {}) {
    const version = body.capacityVersion ?? state.registry.defaultVersionId;
    try {
      return { version, capacities: state.registry.resolve(version) };
    } catch (err) {
      if (err instanceof CapacityVersionError) throw new HttpError(400, err.message);
      throw err;
    }
  }

  // 页面可在请求里指定关哪条通道及关闭/重开秒；缺省使用样例自带的 B[10,16)。
  // closure.replace=true 表示用本次事件替换样例事件；extraClosures 用于追加事件。
  function resolveScenario(body) {
    if (body.closure === undefined) return state.scenario;
    const c = body.closure;
    if (c === null || typeof c !== 'object' || Array.isArray(c)) {
      throw new HttpError(400, 'closure 必须是对象 { gateId, closeAtSecond, reopenAtSecond }');
    }
    const gateId = parseGateId(c, state);
    const closeAtSecond = c.closeAtSecond;
    const reopenAtSecond = c.reopenAtSecond;
    if (!Number.isInteger(closeAtSecond) || !Number.isInteger(reopenAtSecond)) {
      throw new HttpError(400, 'closeAtSecond / reopenAtSecond 必须是整数秒');
    }
    const extraClosures = Array.isArray(body.extraClosures) ? body.extraClosures : [];
    for (const ec of extraClosures) {
      if (ec === null || typeof ec !== 'object' || !Number.isInteger(ec.closeAtSecond)
        || !Number.isInteger(ec.reopenAtSecond) || typeof ec.gateId !== 'string') {
        throw new HttpError(400, 'extraClosures 每项必须是 { gateId, closeAtSecond, reopenAtSecond }');
      }
    }
    try {
      return scenarioWithClosure(
        state.scenario, state.capacities, gateId, closeAtSecond, reopenAtSecond,
        { replace: c.replace === true, extraClosures },
      );
    } catch (err) {
      if (err instanceof ScenarioValidationError) throw new HttpError(400, err.message);
      throw err;
    }
  }

  async function handleApi(req, res, url) {
    const route = url.pathname;
    const body = ['POST', 'PUT'].includes(req.method) ? await readJsonBody(req) : {};

    if (req.method === 'GET' && route === '/api/scenario') {
      return json(res, 200, scenarioView(state));
    }

    if (req.method === 'POST' && route === '/api/simulate') {
      const strategy = parseStrategy(body);
      const { version, capacities } = capacitiesFor(body);
      const scenario = resolveScenario(body);
      const result = runSim(() => simulate(scenario, capacities, strategy));
      return json(res, 200, simulateView(result, scenario, capacities));
    }

    if (req.method === 'POST' && route === '/api/replay') {
      // 回放原入场安排：固定 preset 策略，忽略 body 里的 strategy
      const { capacities } = capacitiesFor(body);
      const scenario = resolveScenario(body);
      const result = runSim(() => simulate(scenario, capacities, 'preset'));
      return json(res, 200, replayView(result, scenario));
    }

    if (req.method === 'POST' && route === '/api/queues') {
      const strategy = parseStrategy(body);
      const { capacities } = capacitiesFor(body);
      const scenario = resolveScenario(body);
      const result = runSim(() => simulate(scenario, capacities, strategy));
      return json(res, 200, queueView(result));
    }

    if (req.method === 'POST' && route === '/api/compare') {
      const { capacities } = capacitiesFor(body);
      const scenario = resolveScenario(body);
      const comparison = runSim(() => compareStrategies(scenario, capacities));
      return json(res, 200, compareView(comparison, scenario));
    }

    throw new HttpError(404, `没有这个接口: ${req.method} ${route}`);
  }

  function runSim(fn) {
    try {
      return fn();
    } catch (err) {
      if (err instanceof ScenarioValidationError || err instanceof SimulationError
        || err instanceof CapacityVersionError) {
        throw new HttpError(400, err.message);
      }
      throw err;
    }
  }

  async function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      throw new HttpError(405, '静态资源只支持 GET/HEAD');
    }
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const safePath = normalize(join(PUBLIC_DIR, rel));
    if (!safePath.startsWith(PUBLIC_DIR + sep) && safePath !== PUBLIC_DIR) {
      throw new HttpError(403, '非法路径');
    }
    let content;
    try {
      content = await readFile(safePath);
    } catch {
      throw new HttpError(404, `资源不存在: ${rel}`);
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(safePath)] ?? 'application/octet-stream' });
    if (req.method === 'HEAD') res.end();
    else res.end(content);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
      } else {
        await serveStatic(req, res, url);
      }
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      json(res, status, { error: status === 500 ? '服务器内部错误' : err.message, status });
    }
  });

  // 给测试用：直接拿到内部状态，不必猜端口
  server.appState = state;
  return server;
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// 直接执行时启动；被测试 import 时不自动监听。
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number.parseInt(process.env.PORT ?? '3000', 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`PORT 非法: ${process.env.PORT}`);
    process.exit(1);
  }
  const server = createServer();
  server.listen(port, '127.0.0.1', () => {
    console.log(`闸机分流模拟服务已启动: http://127.0.0.1:${port} (绑定 127.0.0.1)`);
  });
}
