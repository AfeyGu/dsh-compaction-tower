/**
 * Tower 的配置存储：把「界面上改的值」与「profile 里写的值」分开保存。
 *
 * 优先级：用户覆盖（本文件） > profile 条目配置（cordis.patch.yml 里的 config:） > DEFAULTS。
 * 落盘位置：`<DSH_HOME>/storages/compaction-tower/config.json`，与宿主自己的 storages 同级，
 * 只存用户改过的键（稀疏），删掉这个文件就回到 YAML 里的值。
 *
 * 写入是原子的：先写同目录临时文件再 rename，避免半个 JSON 让下次启动读不出来。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { DEFAULTS, FIELDS, pickPatch, resolveConfig } from './config.js';

/** 覆盖配置文件的位置（跟随 DSH_HOME，沙盒里就是沙盒的 home）。 */
export function configPath() {
  return dshHomePath('storages', 'compaction-tower', 'config.json');
}

export class ConfigStore {
  /**
   * @param {object} entryConfig profile 条目里写的配置（可能是空对象）
   */
  constructor(entryConfig = {}) {
    this.entry = { ...entryConfig };
    this.overrides = {};
    this.revision = 0;
    this.path = configPath();
    this.loadProblem = undefined;
    /** @type {((next: object) => void) | undefined} 生效后的回调（把新值推给 Tower） */
    this.onChange = undefined;
    this.reload();
  }

  /** 从磁盘读覆盖层并算出当前生效配置。坏文件只记问题，不阻止启动。 */
  reload() {
    this.overrides = {};
    this.loadProblem = undefined;
    try {
      const raw = readFileSync(this.path, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.overrides = pickPatch(parsed);
      } else {
        this.loadProblem = '配置文件不是一个 JSON 对象，已忽略';
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') this.loadProblem = `读取 ${this.path} 失败：${error?.message ?? error}`;
    }
    this.effective = resolveConfig({ ...this.entry, ...this.overrides });
    return this.effective;
  }

  /** 当前生效配置。 */
  get config() {
    return this.effective;
  }

  /**
   * 合并一批改动并落盘。
   * @param {object} patch 只含要改的键
   * @returns {object} 新的生效配置
   */
  save(patch) {
    const clean = pickPatch(patch);
    const nextOverrides = { ...this.overrides, ...clean };
    const nextEffective = resolveConfig({ ...this.entry, ...nextOverrides });
    this.persist(nextOverrides);
    this.overrides = nextOverrides;
    this.effective = nextEffective;
    this.revision += 1;
    this.onChange?.(nextEffective);
    return nextEffective;
  }

  /**
   * 去掉若干键的覆盖，回到 profile / 默认值。
   * @param {string[]} keys 要恢复的键
   * @returns {object} 新的生效配置
   */
  reset(keys) {
    if (!Array.isArray(keys) || keys.length === 0) throw new Error('tower: reset 需要至少一个键');
    const nextOverrides = { ...this.overrides };
    for (const key of keys) {
      if (!(key in DEFAULTS)) throw new Error(`tower: 未知配置项 "${key}"`);
      delete nextOverrides[key];
    }
    const nextEffective = resolveConfig({ ...this.entry, ...nextOverrides });
    this.persist(nextOverrides);
    this.overrides = nextOverrides;
    this.effective = nextEffective;
    this.revision += 1;
    this.onChange?.(nextEffective);
    return nextEffective;
  }

  persist(overrides) {
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, `${JSON.stringify(overrides, null, 2)}\n`, 'utf8');
    renameSync(temp, this.path);
  }

  /** 给配置界面用的快照：字段元数据 + 三个来源的值。 */
  snapshot() {
    const groups = [];
    const byGroup = new Map();
    for (const field of FIELDS) {
      if (!byGroup.has(field.group)) {
        const group = { title: field.group, fields: [] };
        byGroup.set(field.group, group);
        groups.push(group);
      }
      const value = this.effective[field.key];
      byGroup.get(field.group).fields.push({
        key: field.key,
        label: field.label,
        type: field.type,
        min: field.min,
        max: field.max,
        step: field.step,
        unit: field.unit,
        hint: field.hint,
        source: field.source,
        pairKey: field.pairKey,
        options: field.options,
        rows: field.rows,
        placeholder: field.placeholder,
        modeKey: field.modeKey,
        presetFor: field.presetFor,
        targetKey: field.targetKey,
        value,
        percent: field.type === 'ratio' ? Math.round(value * 1000) / 10 : undefined,
        default: DEFAULTS[field.key],
        base: this.entry[field.key] ?? DEFAULTS[field.key],
        override: Object.hasOwn(this.overrides, field.key),
      });
    }
    return {
      path: this.path,
      revision: this.revision,
      groups,
      problem: this.loadProblem,
    };
  }
}
