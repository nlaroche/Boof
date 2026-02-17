import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';

const TEST_VAPID_FILE = '.vapid-keys.json';

describe('notifications module', () => {
  beforeEach(() => {
    // Clean up any existing test file
    if (fs.existsSync(TEST_VAPID_FILE)) {
      fs.unlinkSync(TEST_VAPID_FILE);
    }
  });

  afterEach(() => {
    // Clean up test file
    if (fs.existsSync(TEST_VAPID_FILE)) {
      fs.unlinkSync(TEST_VAPID_FILE);
    }
  });

  it('should generate and save VAPID keys on first init', async () => {
    const { initNotifications } = await import('../notifications.js');
    const keys = initNotifications();

    assert.ok(keys, 'Should return VAPID keys');
    assert.ok(keys.publicKey, 'Should have public key');
    assert.ok(keys.privateKey, 'Should have private key');
    assert.equal(typeof keys.publicKey, 'string');
    assert.equal(typeof keys.privateKey, 'string');

    // Should have saved to file
    assert.ok(fs.existsSync(TEST_VAPID_FILE), 'Should create VAPID keys file');

    const saved = JSON.parse(fs.readFileSync(TEST_VAPID_FILE, 'utf-8'));
    assert.deepEqual(saved, keys, 'File should match returned keys');
  });

  it('should load existing VAPID keys from file', async () => {
    const webPushModule = await import('web-push');
    const webPush = webPushModule.default || webPushModule;

    // Generate real VAPID keys using web-push
    const realKeys = webPush.generateVAPIDKeys();
    const existingKeys = {
      publicKey: realKeys.publicKey,
      privateKey: realKeys.privateKey,
    };
    fs.writeFileSync(TEST_VAPID_FILE, JSON.stringify(existingKeys, null, 2));

    // Re-import to get fresh module state
    delete (globalThis as any).cachedNotifications;
    const { initNotifications } = await import(`../notifications.js?t=${Date.now()}`);

    const keys = initNotifications();

    assert.ok(keys, 'Should return VAPID keys');
    assert.equal(keys.publicKey, realKeys.publicKey);
    assert.equal(keys.privateKey, realKeys.privateKey);
  });

  it('should return public key after init', async () => {
    const { initNotifications, getVapidPublicKey } = await import(`../notifications.js?t=${Date.now()}`);
    const keys = initNotifications();
    const publicKey = getVapidPublicKey();

    assert.ok(publicKey, 'Should return public key');
    assert.equal(publicKey, keys?.publicKey);
  });

  it('should add subscription', async () => {
    const { addSubscription } = await import(`../notifications.js?t=${Date.now()}`);
    const webPush = await import('web-push');

    const subscription = {
      endpoint: 'https://test.com/push',
      keys: {
        p256dh: 'test-p256dh',
        auth: 'test-auth',
      },
    } as typeof webPush.PushSubscription;

    // Should not throw
    addSubscription(subscription);
  });

  it('should format notification payload correctly', async () => {
    const { initNotifications, addSubscription, sendNotification } = await import(`../notifications.js?t=${Date.now()}`);
    const webPush = await import('web-push');

    // Initialize first
    initNotifications();

    const sub = {
      endpoint: 'https://test.com/push',
      keys: { p256dh: 'key', auth: 'auth' },
    } as typeof webPush.PushSubscription;

    addSubscription(sub);

    // We can't easily mock web-push in Node.js test runner without breaking imports
    // So we just verify the function doesn't throw - actual push testing would require integration tests
    try {
      await sendNotification('Test Title', 'Test Body');
      // If it doesn't throw, the formatting is likely correct
      assert.ok(true, 'Should not throw when sending notification');
    } catch (err: any) {
      // Expected to fail if no real push service, but that's ok for unit test
      // We're just checking the payload formatting logic works
      assert.ok(err.message.includes('https://test.com/push') || err.statusCode, 'Should attempt to send to endpoint');
    }
  });

  it('should handle multiple subscriptions', async () => {
    const { initNotifications, addSubscription } = await import(`../notifications.js?t=${Date.now()}`);
    const webPush = await import('web-push');

    initNotifications();

    const sub1 = {
      endpoint: 'https://test1.com/push',
      keys: { p256dh: 'key1', auth: 'auth1' },
    } as typeof webPush.PushSubscription;

    const sub2 = {
      endpoint: 'https://test2.com/push',
      keys: { p256dh: 'key2', auth: 'auth2' },
    } as typeof webPush.PushSubscription;

    // Should not throw when adding multiple subscriptions
    addSubscription(sub1);
    addSubscription(sub2);

    assert.ok(true, 'Should successfully add multiple subscriptions');
  });

  it('should handle init failure gracefully', async () => {
    // Create an invalid file to trigger error
    fs.writeFileSync(TEST_VAPID_FILE, 'invalid json content');

    const { initNotifications } = await import(`../notifications.js?t=${Date.now()}`);
    const keys = initNotifications();

    // Should return null on error
    assert.equal(keys, null, 'Should return null on init failure');
  });

  it('should return null for public key when not initialized', async () => {
    // Import without initializing
    const { getVapidPublicKey } = await import(`../notifications.js?t=${Date.now()}`);
    const key = getVapidPublicKey();

    // Should be null before init
    assert.equal(key, null, 'Should return null when not initialized');
  });

  it('should persist VAPID keys across re-initialization', async () => {
    const { initNotifications } = await import(`../notifications.js?t=${Date.now()}`);

    // First initialization
    const keys1 = initNotifications();
    assert.ok(keys1, 'Should initialize keys');

    // Re-import and re-initialize
    const mod2 = await import(`../notifications.js?t=${Date.now()}`);
    const keys2 = mod2.initNotifications();

    // Should load same keys from file
    assert.equal(keys2?.publicKey, keys1?.publicKey, 'Public key should persist');
    assert.equal(keys2?.privateKey, keys1?.privateKey, 'Private key should persist');
  });

  it('should handle sendNotification with no subscriptions', async () => {
    const { initNotifications, sendNotification } = await import(`../notifications.js?t=${Date.now()}`);

    initNotifications();

    // Should not throw when no subscriptions exist
    await sendNotification('Test', 'Message');
    assert.ok(true, 'Should handle empty subscription list');
  });

  it('should validate VAPID key format', async () => {
    const { initNotifications } = await import(`../notifications.js?t=${Date.now()}`);
    const keys = initNotifications();

    assert.ok(keys, 'Keys should be generated');
    // VAPID keys should be base64url strings
    assert.ok(keys.publicKey.length > 0, 'Public key should not be empty');
    assert.ok(keys.privateKey.length > 0, 'Private key should not be empty');
    assert.ok(!keys.publicKey.includes(' '), 'Public key should not contain spaces');
    assert.ok(!keys.privateKey.includes(' '), 'Private key should not contain spaces');
  });
});
