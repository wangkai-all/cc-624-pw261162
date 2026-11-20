# 闸机通道分流模拟

按秒到场需求 + 各闸机固定能力下的入场模拟，对比**预先分流**与**动态切换**两种路线分配策略，
支持关闸/重开事件回放与各通道队列等待分析。仅依赖 Node.js 内置模块。

## 启动

```bash
node src/server.js          # 默认 http://127.0.0.1:3000
PORT=8080 node src/server.js
```

服务只绑定 `127.0.0.1`，端口读 `PORT` 环境变量（非法值直接退出）。

## 测试

```bash
node --test
```

## 模型约定

- 离散秒级模拟，每秒依次处理：**到场 → 路线分配（入场）→ 开放闸机按能力 FIFO 服务**。
- 一个人一旦被分配到某通道就**终身固定**，后续任何秒都不会改派到另一通道。
- 关闸区间 `[closeAtSecond, reopenAtSecond)` 内该通道零服务、队列只进不出；
  `reopenAtSecond` 当秒恢复能力——两次模拟用同一重开时刻即同一时间边界。
- 预先分流（`preset`）：按闸机设计能力固定比例切分每秒到场，关闸也不改派；
  动态切换（`dynamic`）：每秒只把新人分配给当前开放通道，按开放能力加权。
- **容量版本**：闸机能力存放在不可变的版本化注册表（`CapacityRegistry`）中，
  路线分配与事件回放通过同一版本号取同一份能力表；关闸/重开是叠加事件，不就地改能力。
- 两路合流处等待 = 两条通道剩余队列长度之和。

## 页面操作（数据均经服务端真实模拟）

| 按钮 | 接口 | 说明 |
|---|---|---|
| 回放原入场安排 | `POST /api/replay` | 固定 preset 策略，按秒播放关闸/重开生命周期与队列变化 |
| 关闭一条通道再重开 | `POST /api/compare` | 同批到场、同一重开边界下并排对比两种策略 |
| 查看各队列等待 | `POST /api/queues` | 每通道剩余队列/在等人·秒序列、合流序列、模拟末仍在队人员明细 |

页面业务结果区带 `data-evidence-result` 属性，所有操作结果渲染进该区域，便于核对。

## 目录

```
src/capacity.js   容量版本注册中心（不可变版本）
src/scenario.js   场景定义、校验、合成样例
src/engine.js     离散秒级模拟引擎（两种策略 + 对比）
src/app-state.js  服务端共享状态与请求参数解析
src/views.js      引擎结果 → API/页面视图的投影
src/server.js     HTTP 服务与静态资源（node:http）
public/           原生 HTML/CSS/JS 页面（SVG 手绘图表，无第三方库）
test/             node:test 用例（领域层 + HTTP 层，含正常与异常结果）
```

## 主要 API

- `GET  /api/scenario`：场景元信息（容量版本、闸机能力、到场序列、关闸事件）
- `POST /api/simulate` `{strategy, capacityVersion?, closure?}`：单次模拟
- `POST /api/replay` `{closure?}`：原入场安排事件流
- `POST /api/queues` `{strategy, closure?}`：队列等待视图
- `POST /api/compare` `{closure?, extraClosures?}`：双策略对比

`closure` 形如 `{gateId, closeAtSecond, reopenAtSecond, replace?}`；
`replace: true` 表示替换样例自带关闸事件，缺省为叠加（叠加出全关死锁会返回 400）。
