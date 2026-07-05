import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import initSqlJs from 'sql.js';
import webPush from 'web-push';
import { initDb, getOne, getAll, runQuery, flushDb } from '../db.js';
import {
  addSubscription, removeSubscription, getSubscriptionCount, initNotifications,
} from '../notifications.js';
import { pruneRetention, generateId } from '../db-helpers.js';

const TEST_DB = './test-push.db';

// Use env-provided VAPID keys so initNotifications doesn't touch the filesystem.
const vk = webPush.generateVAPIDKeys();
process.env.VAPID_PUBLIC_KEY = vk.publicKey;
process.env.VAPID_PRIVATE_KEY = vk.privateKey;
process.env.PUSH_DISABLED = '1'; // never attempt a real network send in tests

/** Read a scalar from a fresh on-disk copy of the DB (bypasses the in-memory db). */
async function readDiskScalar(sql: string): Promise<number> {
  const SQL = await initSqlJs();
  const disk = new SQL.Database(fs.readFileSync(TEST_DB));
  const res = disk.exec(sql);
  const val = res.length ? Number(res[0].values[0][0]) : 0;
  disk.close();
  return val;
}

describe('push subscriptions + persistence hardening', () => {
  before(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    process.env.DB_PATH = TEST_DB;
    await initDb();
    initNotifications();
  });

  after(() => {
    flushDb();
    for (const f of [TEST_DB, `${TEST_DB}.bak`, `${TEST_DB}.tmp`]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    delete process.env.DB_PATH;
    delete process.env.PUSH_DISABLED;
  });

  // ── Subscription CRUD ──

  it('addSubscription persists to the DB and dedupes by endpoint', () => {
    const before = getSubscriptionCount();
    const sub = { endpoint: 'https://push.example/a', keys: { p256dh: 'k', auth: 'a' } } as any;
    addSubscription(sub);
    addSubscription(sub); // duplicate endpoint should not double-count

    assert.equal(getSubscriptionCount(), before + 1);
    const row = getOne<{ endpoint: string }>('SELECT endpoint FROM push_subscriptions WHERE endpoint = ?', [sub.endpoint]);
    assert.ok(row, 'subscription row persisted');
  });

  it('removeSubscription drops it from memory and the DB', () => {
    const sub = { endpoint: 'https://push.example/b', keys: { p256dh: 'k', auth: 'a' } } as any;
    addSubscription(sub);
    const withSub = getSubscriptionCount();

    removeSubscription(sub.endpoint);
    assert.equal(getSubscriptionCount(), withSub - 1);
    const row = getOne('SELECT endpoint FROM push_subscriptions WHERE endpoint = ?', [sub.endpoint]);
    assert.equal(row, null, 'subscription row deleted');
  });

  it('initNotifications loads persisted subscriptions from the DB', () => {
    runQuery(
      `INSERT OR REPLACE INTO push_subscriptions (endpoint, keys, created_at) VALUES (?, ?, ?)`,
      ['https://push.example/loaded', JSON.stringify({ p256dh: 'k', auth: 'a' }), new Date().toISOString()]
    );
    // Re-init should pick up the row into the in-memory map.
    initNotifications();
    assert.ok(getSubscriptionCount() >= 1, 'loaded at least the persisted subscription');
  });

  // ── Debounced flush (M4) ──

  it('runQuery debounces the disk write; flushDb forces it synchronously', async () => {
    flushDb(); // clear any pending timer and sync current state

    const marker = `debounce-${Date.now()}`;
    runQuery(`INSERT INTO folders (id, name) VALUES (?, ?)`, [generateId(), marker]);

    // In-memory reflects the write immediately...
    assert.equal(
      getOne<{ c: number }>('SELECT COUNT(*) c FROM folders WHERE name = ?', [marker])!.c, 1,
      'in-memory row present right after write'
    );
    // ...but the debounced write hasn't hit disk yet.
    const onDiskBefore = await readDiskScalar(`SELECT COUNT(*) FROM folders WHERE name = '${marker}'`);
    assert.equal(onDiskBefore, 0, 'row not yet flushed to disk (debounced)');

    flushDb();
    const onDiskAfter = await readDiskScalar(`SELECT COUNT(*) FROM folders WHERE name = '${marker}'`);
    assert.equal(onDiskAfter, 1, 'row flushed to disk after flushDb()');
  });

  it('atomic write leaves no leftover .tmp file after flush', () => {
    flushDb();
    assert.equal(fs.existsSync(`${TEST_DB}.tmp`), false, 'temp file renamed away');
  });

  // ── Retention prune (M4) ──

  it('pruneRetention truncates old large raw_output and deletes orphaned old commands', () => {
    const oldDate = new Date(Date.now() - 40 * 86_400_000).toISOString(); // 40 days ago
    const recentDate = new Date().toISOString();

    // A live agent so its command is NOT treated as orphaned.
    const agentId = generateId();
    runQuery(
      `INSERT INTO agents (id, name, working_directory, status) VALUES (?, ?, ?, 'idle')`,
      [agentId, 'PruneTest', 'D:/tmp']
    );

    const bigOutput = 'x'.repeat(20 * 1024); // 20KB > 10KB keep threshold

    // 1) Old command, big output, live agent → raw_output truncated (not deleted).
    const oldBig = generateId();
    runQuery(
      `INSERT INTO commands (id, agent_id, prompt, raw_output, started_at) VALUES (?, ?, ?, ?, ?)`,
      [oldBig, agentId, 'p', bigOutput, oldDate]
    );

    // 2) Old command, orphaned agent → deleted outright.
    const orphan = generateId();
    runQuery(
      `INSERT INTO commands (id, agent_id, prompt, raw_output, started_at) VALUES (?, ?, ?, ?, ?)`,
      [orphan, 'ghost-agent-id', 'p', 'small', oldDate]
    );

    // 3) Recent command, big output → left alone.
    const recentBig = generateId();
    runQuery(
      `INSERT INTO commands (id, agent_id, prompt, raw_output, started_at) VALUES (?, ?, ?, ?, ?)`,
      [recentBig, agentId, 'p', bigOutput, recentDate]
    );

    const result = pruneRetention();

    assert.ok(result.truncatedOutputs >= 1, 'at least one raw_output truncated');
    assert.ok(result.deletedCommands >= 1, 'at least one orphan command deleted');

    const truncated = getOne<{ raw_output: string }>('SELECT raw_output FROM commands WHERE id = ?', [oldBig]);
    assert.ok(truncated && truncated.raw_output.length < bigOutput.length, 'old big output was truncated');

    const gone = getOne('SELECT id FROM commands WHERE id = ?', [orphan]);
    assert.equal(gone, null, 'orphaned old command deleted');

    const kept = getOne<{ raw_output: string }>('SELECT raw_output FROM commands WHERE id = ?', [recentBig]);
    assert.ok(kept && kept.raw_output.length === bigOutput.length, 'recent big output untouched');
  });
});
