// 多设备云端同步冲突 — 策略级仿真测试
// ---------------------------------------------------------------
// 目的：在不依赖真实 Supabase 实例的情况下，按 index.html 的合并/冲突
// 规则重写一套等价的纯函数实现，用同一份"云端"对象作为权威态，
// 让两台模拟设备并发地编辑/删除/同步，断言最终结果。
// 不模拟 RLS / 网络错误 / Auth — 仅验证合并语义。

import assert from 'node:assert/strict';

// ─────────────────────────────────────────────
// 共享"墙钟" — 模拟所有设备 + 云端使用大致同步的真实时间
// ─────────────────────────────────────────────
const WallClock = (() => {
  let now = 1_700_000_000;  // 类 unix 秒
  return {
    now() { return now; },
    advance(by = 1) { now += by; return now; },
  };
})();

// ─────────────────────────────────────────────
// "云端" — 等价于 Supabase qbanks/qbank_questions
// ─────────────────────────────────────────────
function makeCloud() {
  const tick = () => WallClock.advance();
  return {
    banks: new Map(),       // id → { id, user_id, name, created_at, updated_at }
    questions: new Map(),   // id → { id, user_id, bank_id, stem, ..., updated_at }
    advanceClock(ms = 1) { return WallClock.advance(ms); },
    tick,
    upsertBank(row) {
      const existing = this.banks.get(row.id);
      // Postgres trigger: BEFORE UPDATE → updated_at = now()
      // INSERT → keep supplied updated_at
      const updated_at = existing ? tick() : (row.updated_at ?? tick());
      this.banks.set(row.id, { ...existing, ...row, updated_at });
      return this.banks.get(row.id);
    },
    upsertQuestion(row) {
      const existing = this.questions.get(row.id);
      const updated_at = existing ? tick() : (row.updated_at ?? tick());
      this.questions.set(row.id, { ...existing, ...row, updated_at });
      return this.questions.get(row.id);
    },
    deleteBank(id) {
      // cascade
      this.banks.delete(id);
      for (const [qid, q] of this.questions) if (q.bank_id === id) this.questions.delete(qid);
    },
    deleteQuestion(id) { this.questions.delete(id); },
    selectBanks(userId) { return [...this.banks.values()].filter(b => b.user_id === userId); },
    selectQuestions(userId) { return [...this.questions.values()].filter(q => q.user_id === userId); },
  };
}

// ─────────────────────────────────────────────
// "本地设备" — IndexedDB + lastKnownCloudTimes + tombstones
// ─────────────────────────────────────────────
function makeDevice(name, userId) {
  let localId = 0;
  return {
    name,
    userId,
    banks: new Map(),       // localId → { id, cloudId, ownerId, name, createdAt, updatedAt }
    questions: new Map(),   // localId → { id, cloudId, ownerId, bankId, stem, ..., updatedAt }
    tombstones: [],         // { entity, cloudId, ownerId, shouldDeleteCloud, createdAt }
    lastSyncAt: 0,
    lastPullAt: 0,
    lastKnownCloudTimes: { banks: new Map(), questions: new Map() },
    advanceClock(ms = 1) { return WallClock.advance(ms); },
    nextLocalId() { return ++localId; },

    // Edits create local records / mutate them; mark updatedAt with device's local clock
    addBankLocal(name) {
      const id = this.nextLocalId();
      const t = this.advanceClock();
      this.banks.set(id, { id, name, createdAt: t, updatedAt: t });
      return id;
    },
    editBank(id, patch) {
      const b = this.banks.get(id);
      if (!b) throw new Error('bank not found');
      const t = this.advanceClock();
      this.banks.set(id, { ...b, ...patch, updatedAt: t });
    },
    addQuestionLocal(bankId, stem) {
      const id = this.nextLocalId();
      const t = this.advanceClock();
      this.questions.set(id, { id, bankId, stem, createdAt: t, updatedAt: t });
      return id;
    },
    editQuestion(id, patch) {
      const q = this.questions.get(id);
      if (!q) throw new Error('question not found');
      const t = this.advanceClock();
      this.questions.set(id, { ...q, ...patch, updatedAt: t });
    },
    deleteQuestionLocal(id) {
      const q = this.questions.get(id);
      if (!q) return;
      if (q.cloudId) {
        this.tombstones.push({
          entity: 'question', cloudId: q.cloudId, ownerId: q.ownerId || null,
          shouldDeleteCloud: Boolean(q.ownerId), createdAt: this.advanceClock()
        });
      }
      this.questions.delete(id);
    },
    deleteBankLocal(id) {
      const b = this.banks.get(id);
      if (b?.cloudId) {
        this.tombstones.push({
          entity: 'bank', cloudId: b.cloudId, ownerId: b.ownerId || null,
          shouldDeleteCloud: Boolean(b.ownerId), createdAt: this.advanceClock()
        });
      }
      for (const [qid, q] of this.questions) if (q.bankId === id) this.questions.delete(qid);
      this.banks.delete(id);
    },

    hasLocalChangesAfterLastSync(record) {
      return this.lastSyncAt > 0 && (record.updatedAt || record.createdAt || 0) > this.lastSyncAt;
    },
  };
}

// ─────────────────────────────────────────────
// 同步函数（重写自 index.html L2972-3354）
// ─────────────────────────────────────────────
function processTombstones(device, cloud) {
  const skippedBankDeletes = new Set();
  const tombs = [...device.tombstones].sort((a, b) => {
    if (a.entity === b.entity) return 0;
    return a.entity === 'bank' ? -1 : 1;
  });
  device.tombstones = [];
  for (const item of tombs) {
    if (!item.cloudId) continue;
    if (item.ownerId && item.ownerId !== device.userId) { device.tombstones.push(item); continue; }
    if (!item.shouldDeleteCloud) continue;
    const table = item.entity === 'bank' ? cloud.banks : cloud.questions;
    const existing = table.get(item.cloudId);
    if (!existing || existing.user_id !== device.userId) continue;
    if (item.entity === 'question' && skippedBankDeletes.has(existing.bank_id)) continue;
    if (existing.updated_at > item.createdAt) {
      if (item.entity === 'bank') skippedBankDeletes.add(item.cloudId);
      continue;
    }
    // 修复 #2：bank 删除还要检查子题是否在删除请求之后被编辑过
    if (item.entity === 'bank') {
      const childChanged = [...cloud.questions.values()].some(
        q => q.bank_id === item.cloudId && q.user_id === device.userId && q.updated_at > item.createdAt
      );
      if (childChanged) {
        skippedBankDeletes.add(item.cloudId);
        continue;
      }
    }
    if (item.entity === 'bank') cloud.deleteBank(item.cloudId);
    else cloud.deleteQuestion(item.cloudId);
  }
}

function pushBanks(device, cloud) {
  const conflicts = [];
  let upserted = 0;
  const cloudRows = new Map(cloud.selectBanks(device.userId).map(r => [r.id, r]));
  const known = device.lastKnownCloudTimes.banks;
  for (const [, bank] of device.banks) {
    if (bank.ownerId && bank.ownerId !== device.userId) continue;
    if (bank.cloudId && !bank.ownerId) continue; // orphaned
    const cloudRow = bank.cloudId ? cloudRows.get(bank.cloudId) : null;
    if (cloudRow && (bank.updatedAt || bank.createdAt) <= cloudRow.updated_at) continue;
    if (cloudRow && bank.cloudId) {
      const knownT = known.get(bank.cloudId) || 0;
      if (knownT > 0 && cloudRow.updated_at > knownT) {
        conflicts.push({ entity: 'bank', cloudId: bank.cloudId });
      }
    }
    upserted++;
    const isNew = !bank.cloudId;
    const cloudId = bank.cloudId || `cb-${cloud.tick()}-${bank.id}`;
    const saved = cloud.upsertBank({
      id: cloudId, user_id: device.userId, name: bank.name,
      created_at: bank.createdAt, updated_at: bank.updatedAt
    });
    bank.cloudId = cloudId;
    bank.ownerId = device.userId;
    bank.updatedAt = saved.updated_at;
    known.set(cloudId, saved.updated_at);
  }
  return { conflicts, upserted };
}

function pushQuestions(device, cloud) {
  const conflicts = [];
  let upserted = 0;
  const cloudRows = new Map(cloud.selectQuestions(device.userId).map(r => [r.id, r]));
  const known = device.lastKnownCloudTimes.questions;
  const bankCloud = new Map([...device.banks.values()]
    .filter(b => (!b.ownerId || b.ownerId === device.userId) && b.cloudId)
    .map(b => [b.id, b.cloudId]));
  for (const [, q] of device.questions) {
    if (q.ownerId && q.ownerId !== device.userId) continue;
    if (q.cloudId && !q.ownerId) continue;
    const cloudRow = q.cloudId ? cloudRows.get(q.cloudId) : null;
    if (cloudRow && (q.updatedAt || q.createdAt) <= cloudRow.updated_at) continue;
    if (cloudRow && q.cloudId) {
      const knownT = known.get(q.cloudId) || 0;
      if (knownT > 0 && cloudRow.updated_at > knownT) {
        conflicts.push({ entity: 'question', cloudId: q.cloudId, stem: q.stem });
      }
    }
    const bankCloudId = bankCloud.get(q.bankId);
    if (!bankCloudId) continue;
    upserted++;
    const isNew = !q.cloudId;
    const cloudId = q.cloudId || `cq-${cloud.tick()}-${q.id}`;
    const saved = cloud.upsertQuestion({
      id: cloudId, user_id: device.userId, bank_id: bankCloudId,
      stem: q.stem, answer: q.answer || '',
      created_at: q.createdAt, updated_at: q.updatedAt
    });
    q.cloudId = cloudId;
    q.ownerId = device.userId;
    q.updatedAt = saved.updated_at;
    known.set(cloudId, saved.updated_at);
  }
  return { conflicts, upserted };
}

function pullBanks(device, cloud) {
  const remote = cloud.selectBanks(device.userId);
  const remoteIds = new Set(remote.map(r => r.id));
  const myBanks = [...device.banks.values()].filter(b => b.ownerId === device.userId);
  for (const lb of myBanks) {
    if (!remoteIds.has(lb.cloudId)) {
      if (device.hasLocalChangesAfterLastSync(lb)) {
        lb.ownerId = null; // orphan
        for (const q of device.questions.values()) {
          if (q.bankId === lb.id && (!q.ownerId || q.ownerId === device.userId)) q.ownerId = null;
        }
      } else {
        for (const [qid, q] of device.questions) if (q.bankId === lb.id) device.questions.delete(qid);
        device.banks.delete(lb.id);
      }
    }
  }
  const bankCloudToLocal = new Map();
  for (const rb of remote) {
    let existing = [...device.banks.values()].find(b => b.cloudId === rb.id);
    if (existing) {
      if (device.hasLocalChangesAfterLastSync(existing)) {
        bankCloudToLocal.set(rb.id, existing.id); continue;
      }
      const localT = existing.updatedAt || existing.createdAt || 0;
      if (localT <= rb.updated_at) {
        existing.name = rb.name;
        existing.updatedAt = rb.updated_at;
        existing.ownerId = rb.user_id;
      }
      bankCloudToLocal.set(rb.id, existing.id);
    } else {
      const id = device.nextLocalId();
      device.banks.set(id, {
        id, cloudId: rb.id, ownerId: rb.user_id, name: rb.name,
        createdAt: rb.created_at, updatedAt: rb.updated_at
      });
      bankCloudToLocal.set(rb.id, id);
    }
    device.lastKnownCloudTimes.banks.set(rb.id, rb.updated_at);
  }
  return bankCloudToLocal;
}

function pullQuestions(device, cloud, bankMap) {
  const remote = cloud.selectQuestions(device.userId);
  const remoteIds = new Set(remote.map(r => r.id));
  const mine = [...device.questions.values()].filter(q => q.ownerId === device.userId);
  for (const lq of mine) {
    if (!remoteIds.has(lq.cloudId)) {
      if (device.hasLocalChangesAfterLastSync(lq)) lq.ownerId = null;
      else device.questions.delete(lq.id);
    }
  }
  for (const rq of remote) {
    const localBankId = bankMap.get(rq.bank_id);
    if (!localBankId) continue;
    let existing = [...device.questions.values()].find(q => q.cloudId === rq.id);
    if (existing) {
      if (device.hasLocalChangesAfterLastSync(existing)) continue;
      const localT = existing.updatedAt || existing.createdAt || 0;
      if (localT <= rq.updated_at) {
        existing.stem = rq.stem;
        existing.answer = rq.answer;
        existing.updatedAt = rq.updated_at;
        existing.ownerId = rq.user_id;
        existing.bankId = localBankId;
      }
    } else {
      const id = device.nextLocalId();
      device.questions.set(id, {
        id, cloudId: rq.id, ownerId: rq.user_id, bankId: localBankId,
        stem: rq.stem, answer: rq.answer, createdAt: rq.created_at, updatedAt: rq.updated_at
      });
    }
    device.lastKnownCloudTimes.questions.set(rq.id, rq.updated_at);
  }
  device.lastPullAt = cloud.advanceClock(0); // synthetic
}

function fullSync(device, cloud, mode = 'pullThenPush') {
  if (mode === 'pullThenPush' || mode === 'pull') {
    const bankMap = pullBanks(device, cloud);
    pullQuestions(device, cloud, bankMap);
  }
  if (mode === 'pullThenPush' || mode === 'push') {
    processTombstones(device, cloud);
    pushBanks(device, cloud);
    pushQuestions(device, cloud);
  }
  device.lastSyncAt = cloud.advanceClock(0);
}

// ─────────────────────────────────────────────
// 测试用例
// ─────────────────────────────────────────────
let failed = 0, passed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}
function section(name, fn) { console.log(`\n[${name}]`); fn(); }

// ─────────────────────────────────────────────
// 场景 1：基础并发编辑同一题目（last-write-wins）
// ─────────────────────────────────────────────
section('场景 1：A、B 并发编辑同一题目', () => {
  test('A 创建并上传，B 拉取后两端一致', () => {
    const cloud = makeCloud();
    const A = makeDevice('A', 'user-1');
    const B = makeDevice('B', 'user-1');
    const bA = A.addBankLocal('数学');
    const qA = A.addQuestionLocal(bA, '1+1=?');
    fullSync(A, cloud);
    fullSync(B, cloud);
    assert.equal(B.banks.size, 1);
    assert.equal(B.questions.size, 1);
    assert.equal([...B.questions.values()][0].stem, '1+1=?');
  });

  test('⚠️ 仅 push 场景：B 的较晚编辑被静默丢弃（服务器 now() 抢跑了 B 的本地时间）', () => {
    // 当推送顺序与编辑顺序相反时：A 推送后云端 updated_at 由 trigger 设为 server-now，
    // 这个时间往往比 B 的本地编辑时间更新。B 再 push 时本地 ≤ 云端 → 直接 skip stale，
    // 既不报冲突，也不覆盖 — B 的修改丢失。
    // 这是 LWW 的固有缺陷，**仅在不走 pull-then-push 流程时**才会触发。
    const cloud = makeCloud();
    const A = makeDevice('A', 'user-1');
    const B = makeDevice('B', 'user-1');
    const bA = A.addBankLocal('题库');
    const qA = A.addQuestionLocal(bA, 'orig');
    fullSync(A, cloud);
    fullSync(B, cloud);
    const qB = [...B.questions.values()][0].id;
    A.advanceClock(1); A.editQuestion(qA, { stem: 'A-edit' });
    B.advanceClock(1); B.editQuestion(qB, { stem: 'B-edit' });
    fullSync(A, cloud, 'push');                  // A 先 push
    const result = pushQuestions(B, cloud);      // B 仅 push，不 pull
    const final = cloud.selectQuestions('user-1')[0];
    assert.equal(result.conflicts.length, 0, '没有冲突日志（push 被 skip stale，未触发冲突分支）');
    assert.equal(final.stem, 'A-edit', 'B 的本地新值未被写入云端 — ��默丢失');
  });

  test('A、B 双方都先 pull 再 push（推荐流程）→ 冲突被发现，最后一个 push 仍然覆盖（LWW）', () => {
    const cloud = makeCloud();
    const A = makeDevice('A', 'user-1');
    const B = makeDevice('B', 'user-1');
    const bA = A.addBankLocal('题库');
    const qA = A.addQuestionLocal(bA, 'orig');
    fullSync(A, cloud);
    fullSync(B, cloud);
    const qBlocal = [...B.questions.values()][0].id;
    A.advanceClock(10); A.editQuestion(qA, { stem: 'A-v2' });
    fullSync(A, cloud, 'push');
    // B 编辑后推荐先 pull —— 但本地未同步的修改受保护
    B.advanceClock(20); B.editQuestion(qBlocal, { stem: 'B-v2' });
    fullSync(B, cloud);  // pull-then-push
    const final = cloud.selectQuestions('user-1')[0];
    assert.equal(final.stem, 'B-v2', 'B 的本地编辑受 hasLocalChangesAfterLastSync 保护，且最终 push 覆盖云端');
  });
});

// ─────────────────────────────────────────────
// 场景 2：删除 vs 编辑（最危险）
// ─────────────────────────────────────────────
section('场景 2：删除 vs 编辑', () => {
  test('A 删除题目，B 同时编辑该题 → B 推送后云端保留 B 的编辑', () => {
    const cloud = makeCloud();
    const A = makeDevice('A', 'user-1');
    const B = makeDevice('B', 'user-1');
    const bA = A.addBankLocal('题库');
    const qA = A.addQuestionLocal(bA, 'orig');
    fullSync(A, cloud);
    fullSync(B, cloud);
    const qBlocal = [...B.questions.values()][0].id;
    A.advanceClock(5); A.deleteQuestionLocal(qA);   // A 删除
    B.advanceClock(10); B.editQuestion(qBlocal, { stem: 'B-edit' }); // B 编辑
    fullSync(B, cloud, 'push');  // B 先推
    fullSync(A, cloud, 'push');  // A 再推 tombstone — 但云端 updated_at 已被 B 更新
    // 期望：tombstone 被放弃 → 云端仍保留 B 的题目
    const remaining = cloud.selectQuestions('user-1');
    assert.equal(remaining.length, 1, 'tombstone 被放弃，题目保留');
    assert.equal(remaining[0].stem, 'B-edit');
  });

  test('A 删除题目（先推），B 后编辑 → B 推送时，cloudRow 已不存在，B 当作新题/孤立处理', () => {
    const cloud = makeCloud();
    const A = makeDevice('A', 'user-1');
    const B = makeDevice('B', 'user-1');
    const bA = A.addBankLocal('题库');
    const qA = A.addQuestionLocal(bA, 'orig');
    fullSync(A, cloud);
    fullSync(B, cloud);
    const qBlocal = [...B.questions.values()][0].id;
    A.advanceClock(5); A.deleteQuestionLocal(qA);
    fullSync(A, cloud, 'push');  // 云端题目已删除
    B.advanceClock(10); B.editQuestion(qBlocal, { stem: 'B-edit' });
    fullSync(B, cloud);  // pull 后题目应被孤立或保留本地编辑
    const localQ = [...B.questions.values()][0];
    assert.equal(localQ.ownerId, null, 'B 本地的题目被孤立（保护本地编辑）');
    assert.equal(localQ.stem, 'B-edit');
    const cloudQ = cloud.selectQuestions('user-1');
    assert.equal(cloudQ.length, 0, '云端已无该题（因为孤立后 push 被 cloudId && !ownerId 拦截，不会复活）');
  });

  test('⚠️ 已知风险：A 删除题库，B 编辑该题库下的题 — B 的编辑会丢失', () => {
    const cloud = makeCloud();
    const A = makeDevice('A', 'user-1');
    const B = makeDevice('B', 'user-1');
    const bA = A.addBankLocal('题库');
    A.addQuestionLocal(bA, 'orig');
    fullSync(A, cloud);
    fullSync(B, cloud);
    const qBlocal = [...B.questions.values()][0].id;
    const bBlocal = [...B.banks.values()][0].id;
    A.advanceClock(5); A.deleteBankLocal([...A.banks.keys()][0]);
    B.advanceClock(10); B.editQuestion(qBlocal, { stem: 'B-edit' });
    fullSync(A, cloud, 'push');  // 题库被删除，问题级联删除
    fullSync(B, cloud);  // B pull → 本地题库被孤立（因有本地变更）
    const remainingBanks = [...B.banks.values()].filter(b => b.ownerId === 'user-1');
    assert.equal(remainingBanks.length, 0);
    // 结论：云端无内容；B 本地保留为孤立副本，但无法再同步回云端
    const cloudBanks = cloud.selectBanks('user-1');
    assert.equal(cloudBanks.length, 0, '云端无题库');
  });
});

// ─────────────────────────────────────────────
// 场景 3：离线编辑 + 后续同步
// ─────────────────────────────────────────────
section('场景 3：离线场景', () => {
  test('A 离线编辑 5 条题，重连后一次性上传', () => {
    const cloud = makeCloud();
    const A = makeDevice('A', 'user-1');
    const bA = A.addBankLocal('题库');
    fullSync(A, cloud);
    for (let i = 0; i < 5; i++) {
      A.advanceClock(); A.addQuestionLocal(bA, `题${i}`);
    }
    fullSync(A, cloud, 'push');
    assert.equal(cloud.selectQuestions('user-1').length, 5);
  });

  test('A 离线删除 2 条题，重连后云端正确删除', () => {
    const cloud = makeCloud();
    const A = makeDevice('A', 'user-1');
    const bA = A.addBankLocal('题库');
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push(A.addQuestionLocal(bA, `题${i}`));
    fullSync(A, cloud);
    A.advanceClock(); A.deleteQuestionLocal(ids[0]);
    A.advanceClock(); A.deleteQuestionLocal(ids[1]);
    fullSync(A, cloud, 'push');
    assert.equal(cloud.selectQuestions('user-1').length, 1);
  });
});

// ─────────────────────────────────────────────
// 场景 4：三设备并发
// ─────────────────────────────────────────────
section('场景 4：三设备并发', () => {
  test('A、B、C 各自创建 1 条题 → 二轮同步后云端有 3 条，每台都能看到', () => {
    const cloud = makeCloud();
    const A = makeDevice('A', 'user-1');
    const B = makeDevice('B', 'user-1');
    const C = makeDevice('C', 'user-1');
    const bA = A.addBankLocal('题库');
    fullSync(A, cloud);
    fullSync(B, cloud);
    fullSync(C, cloud);
    A.advanceClock(); A.addQuestionLocal(bA, 'A-题');
    B.advanceClock(); B.addQuestionLocal([...B.banks.keys()][0], 'B-题');
    C.advanceClock(); C.addQuestionLocal([...C.banks.keys()][0], 'C-题');
    // 第一轮：每台都 pull-then-push
    fullSync(A, cloud);
    fullSync(B, cloud);
    fullSync(C, cloud);
    // 第二轮：让 A 和 B 拉到所有人的题
    fullSync(A, cloud);
    fullSync(B, cloud);
    assert.equal(cloud.selectQuestions('user-1').length, 3);
    assert.equal([...A.questions.values()].length, 3, 'A 应有 3 条');
    assert.equal([...B.questions.values()].length, 3, 'B 应有 3 条');
    assert.equal([...C.questions.values()].length, 3, 'C 应有 3 条');
  });
});

// ─────────────────────────────────────────────
// 场景 5：⚠️ 已知 race —— 同步进行中的本地编辑会被覆盖
// ─────────────────────────────────────────────
section('场景 5：同步进行中的本地编辑 (race)', () => {
  test('⚠️ 同步过程中的本地编辑可能被后续 pull 覆盖', () => {
    // 模拟时序：
    //   T1: A 开始 sync
    //   T2: 用户在 A 上编辑题目（lastSync 此时还是旧值，但 lastSync 在 sync 完成时被更新到当前）
    //   T3: A sync 完成 → lastSyncAt = T3
    //   T4: A 再次 pull
    //   此时 record.updatedAt = T2 < lastSyncAt = T3 → hasLocalChangesAfterLastSync = false → 本地编辑被云端覆盖
    const cloud = makeCloud();
    const A = makeDevice('A', 'user-1');
    const B = makeDevice('B', 'user-1');
    const bA = A.addBankLocal('题库');
    const qA = A.addQuestionLocal(bA, 'orig');
    fullSync(A, cloud);
    fullSync(B, cloud);

    // B 修改并推送到云端
    const qBlocal = [...B.questions.values()][0].id;
    B.advanceClock(10); B.editQuestion(qBlocal, { stem: 'B-edit' });
    fullSync(B, cloud, 'push');

    // 模拟 A 同步过程中的并发本地编辑：
    //   "sync-in-progress" 时刻，用户给 A 的 qA 改了 stem='A-during-sync'
    //   这条编辑的 updatedAt = T_during（介于 sync 开始和结束之间）
    A.advanceClock(5); A.editQuestion(qA, { stem: 'A-during-sync' });
    const editTime = A.banks.get(bA) ? A.banks.get(bA).updatedAt : 0;
    const editedQUpdatedAt = A.questions.get(qA).updatedAt;
    // 现在模拟 sync 结束 → lastSyncAt 被更新为 "更新的时间"
    // 真实代码：setLastSyncAt 只在 sync 任务完成 *后* 用 new Date().toISOString() 设置
    A.lastSyncAt = editedQUpdatedAt + 100;  // sync 完成时间 > 编辑时间
    // 之后再来一次 pull
    fullSync(A, cloud, 'pull');
    const finalA = A.questions.get(qA);
    // 期望（应该）：finalA.stem === 'A-during-sync'（保护用户编辑）
    // 实际：finalA.stem === 'B-edit'（被覆盖，编辑丢失）
    if (finalA.stem === 'B-edit') {
      throw new Error(
        'BUG 复现：同步进行中的本地编辑 (T_edit < T_lastSync) 被云端覆盖。\n    ' +
        '修复建议：将 lastSyncAt 记录为同步 *开始* 的时间，而非结束时间；' +
        '或在记录 updatedAt 时，单独维护"自上次 push 起的脏集合"。'
      );
    }
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
