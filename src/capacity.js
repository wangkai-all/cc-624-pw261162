// 容量版本注册中心：路线分配（assign）和事件回放（replay）必须通过同一个
// 版本号拿到同一份闸机能力表，杜绝两路各用各的容量数据。
// 版本一旦发布即不可变（frozen），关闭/重开闸机走的是发布新版本，而不是就地改。

export class CapacityVersionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CapacityVersionError';
  }
}

function normalizeCapacities(capacities) {
  if (capacities === null || typeof capacities !== 'object' || Array.isArray(capacities)) {
    throw new CapacityVersionError('capacities 必须是 { 闸机id: 每秒能力 } 的对象');
  }
  const entries = Object.entries(capacities);
  if (entries.length === 0) {
    throw new CapacityVersionError('至少需要一台闸机的能力数据');
  }
  const result = {};
  for (const [gateId, perSecond] of entries) {
    if (!Number.isInteger(perSecond) || perSecond <= 0) {
      throw new CapacityVersionError(`闸机 ${gateId} 的每秒能力必须是正整数，收到 ${perSecond}`);
    }
    result[gateId] = perSecond;
  }
  return Object.freeze(result);
}

export class CapacityRegistry {
  constructor() {
    this.versions = new Map();
    this.defaultVersion = null;
  }

  // 发布一个不可变版本，返回版本号
  publish(version, capacities) {
    if (typeof version !== 'string' || version.trim() === '') {
      throw new CapacityVersionError('版本号必须是非空字符串');
    }
    if (this.versions.has(version)) {
      throw new CapacityVersionError(`容量版本 ${version} 已存在且不可变`);
    }
    const frozen = normalizeCapacities(capacities);
    this.versions.set(version, frozen);
    if (this.defaultVersion === null) this.defaultVersion = version;
    return version;
  }

  // 按版本号取能力表；不传版本号时用默认（首个发布）版本
  resolve(version) {
    const key = version ?? this.defaultVersion;
    if (key === null || !this.versions.has(key)) {
      throw new CapacityVersionError(`未知的容量版本: ${String(version)}`);
    }
    return this.versions.get(key);
  }

  get defaultVersionId() {
    return this.defaultVersion;
  }

  listVersions() {
    return [...this.versions.keys()];
  }
}
