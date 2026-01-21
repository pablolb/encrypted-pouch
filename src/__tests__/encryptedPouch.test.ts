/**
 * Tests for EncryptedPouch with PouchDB
 */

import {
  jest,
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
} from "@jest/globals";
import PouchDB from "pouchdb";
import MemoryAdapter from "pouchdb-adapter-memory";

// Note: Tests use 'pouchdb' with memory adapter (Node.js environment)
// Your app should use 'pouchdb-browser' in the browser
import { EncryptedPouch } from "../encryptedPouch.js";
import type {
  Doc,
  DocRef,
  ConflictInfo,
  SyncInfo,
  DecryptionErrorEvent,
} from "../encryptedPouch.js";

// Use memory adapter for tests
PouchDB.plugin(MemoryAdapter);

describe("EncryptedPouch", () => {
  let db: PouchDB.Database;
  let store: EncryptedPouch;

  beforeEach(() => {
    db = new PouchDB("test-db", { adapter: "memory" });
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe("Basic Operations", () => {
    test("should put and get a document", async () => {
      store = new EncryptedPouch(db, "test-password");
      await store.loadAll();

      const doc = await store.put("expenses", {
        _id: "lunch",
        amount: 15.5,
        description: "Lunch",
      });

      expect(doc._id).toBe("lunch");
      expect(doc._rev).toBeDefined();
      expect(doc.amount).toBe(15.5);

      const retrieved = await store.get("expenses", "lunch");
      expect(retrieved).toEqual({
        _id: "lunch",
        _rev: expect.any(String),
        amount: 15.5,
        description: "Lunch",
      });
    });

    test("should auto-generate ID if not provided", async () => {
      store = new EncryptedPouch(db, "test-password");
      await store.loadAll();

      const doc = await store.put("expenses", {
        amount: 20,
        description: "Dinner",
      });

      expect(doc._id).toBeDefined();
      expect(doc._id.length).toBeGreaterThan(0);

      const retrieved = await store.get("expenses", doc._id);
      expect(retrieved?.amount).toBe(20);
    });

    test("should update existing document", async () => {
      store = new EncryptedPouch(db, "test-password");
      await store.loadAll();

      await store.put("expenses", { _id: "lunch", amount: 15 });

      // Get the document with _rev
      const doc = await store.get("expenses", "lunch");
      expect(doc).not.toBeNull();

      // Update with _rev
      await store.put("expenses", {
        _id: "lunch",
        _rev: doc!._rev,
        amount: 20,
      });

      const retrieved = await store.get("expenses", "lunch");
      expect(retrieved?.amount).toBe(20);
    });

    test("should detect conflicts when updating with stale _rev", async () => {
      store = new EncryptedPouch(db, "test-password");
      await store.loadAll();

      // Create initial document
      await store.put("expenses", { _id: "lunch", amount: 15 });
      const doc1 = await store.get("expenses", "lunch");
      expect(doc1).not.toBeNull();

      // Update it (this will change the _rev)
      await store.put("expenses", {
        _id: "lunch",
        _rev: doc1!._rev,
        amount: 20,
      });

      // Try to update with the old _rev - should fail with conflict
      await expect(
        store.put("expenses", { _id: "lunch", _rev: doc1!._rev, amount: 25 }),
      ).rejects.toThrow();
    });

    test("should delete a document", async () => {
      const onDelete =
        jest.fn<
          (deletions: Array<{ table: string; docs: { _id: string }[] }>) => void
        >();
      store = new EncryptedPouch(db, "test-password", {
        onChange: jest.fn(),
        onDelete,
      });
      await store.loadAll();

      await store.put("expenses", { _id: "lunch", amount: 15 });
      await store.delete("expenses", "lunch");

      const retrieved = await store.get("expenses", "lunch");
      expect(retrieved).toBeNull();

      // Verify onDelete was called
      await waitFor(() => expect(onDelete).toHaveBeenCalled());
      const deletions = onDelete.mock.calls[0][0];
      expect(deletions[0].table).toBe("expenses");
      expect(deletions[0].docs[0]._id).toBe("lunch");
    });

    test("should return null for non-existent document", async () => {
      store = new EncryptedPouch(db, "test-password");
      await store.loadAll();

      const retrieved = await store.get("expenses", "nonexistent");
      expect(retrieved).toBeNull();
    });
  });

  describe("Change Detection", () => {
    test("should trigger onChange when document is added", async () => {
      const onChange =
        jest.fn<(changes: Array<{ table: string; docs: Doc[] }>) => void>();
      store = new EncryptedPouch(db, "test-password", {
        onChange,
        onDelete: jest.fn(),
      });
      await store.loadAll();

      await store.put("expenses", { _id: "lunch", amount: 15 });

      await waitFor(() => expect(onChange).toHaveBeenCalled());

      const calls = onChange.mock.calls;
      const lastCall = calls[calls.length - 1][0];
      expect(lastCall[0].table).toBe("expenses");
      expect(lastCall[0].docs[0]._id).toBe("lunch");
      expect(lastCall[0].docs[0].amount).toBe(15);
    });

    test("should trigger onChange when document is updated", async () => {
      const onChange =
        jest.fn<(changes: Array<{ table: string; docs: Doc[] }>) => void>();
      store = new EncryptedPouch(db, "test-password", {
        onChange,
        onDelete: jest.fn(),
      });
      await store.loadAll();

      await store.put("expenses", { _id: "lunch", amount: 15 });
      await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));

      onChange.mockClear();

      // Get the document with _rev before updating
      const doc = await store.get("expenses", "lunch");
      expect(doc).not.toBeNull();

      // Update with _rev
      await store.put("expenses", {
        _id: "lunch",
        _rev: doc!._rev,
        amount: 20,
      });
      await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));

      const lastCall = onChange.mock.calls[0][0];
      expect(lastCall[0].table).toBe("expenses");
      expect(lastCall[0].docs[0].amount).toBe(20);
    });

    test("should trigger onDelete when document is deleted", async () => {
      const onDelete =
        jest.fn<
          (deletions: Array<{ table: string; docs: { _id: string }[] }>) => void
        >();
      store = new EncryptedPouch(db, "test-password", {
        onChange: jest.fn(),
        onDelete,
      });
      await store.loadAll();

      await store.put("expenses", { _id: "lunch", amount: 15 });
      await waitFor(() => expect(onDelete).not.toHaveBeenCalled());

      await store.delete("expenses", "lunch");
      await waitFor(() => expect(onDelete).toHaveBeenCalled());

      const deletions = onDelete.mock.calls[0][0];
      expect(deletions[0].table).toBe("expenses");
      expect(deletions[0].docs[0]._id).toBe("lunch");
    });

    test("should load existing documents on loadAll", async () => {
      // Create some documents directly in PouchDB
      const helper = new (await import("../encryption.js")).EncryptionHelper(
        "test-password",
      );
      await db.put({
        _id: "expenses_lunch",
        d: await helper.encrypt(JSON.stringify({ amount: 15 })),
      });

      const onChange =
        jest.fn<(changes: Array<{ table: string; docs: Doc[] }>) => void>();
      store = new EncryptedPouch(db, "test-password", {
        onChange,
        onDelete: jest.fn(),
      });
      await store.loadAll();

      expect(onChange).toHaveBeenCalled();
      const changes = onChange.mock.calls[0][0];
      expect(changes[0].table).toBe("expenses");
      expect(changes[0].docs[0]._id).toBe("lunch");
      expect(changes[0].docs[0]._rev).toBeDefined();
      expect(changes[0].docs[0].amount).toBe(15);
    });
  });

  describe("Encryption", () => {
    test("should encrypt data before storing in PouchDB", async () => {
      store = new EncryptedPouch(db, "test-password");
      await store.loadAll();

      await store.put("expenses", { _id: "lunch", amount: 15, secret: "data" });

      // Get raw document from PouchDB
      const rawDoc = (await db.get("expenses_lunch")) as any;
      expect(rawDoc.d).toBeDefined();
      expect(typeof rawDoc.d).toBe("string");
      expect(rawDoc.d).toContain("|"); // encrypted format: iv|ciphertext
      expect(rawDoc.amount).toBeUndefined();
      expect(rawDoc.secret).toBeUndefined();
    });

    test("should fail to decrypt with wrong password", async () => {
      const helper = new (await import("../encryption.js")).EncryptionHelper(
        "correct-password",
      );
      await db.put({
        _id: "expenses_lunch",
        d: await helper.encrypt(JSON.stringify({ amount: 15 })),
      });

      const onError = jest.fn();
      store = new EncryptedPouch(db, "wrong-password", {
        onChange: jest.fn(),
        onDelete: jest.fn(),
        onError,
      });
      await store.loadAll();

      expect(onError).toHaveBeenCalled();
      const errors = onError.mock.calls[0][0] as DecryptionErrorEvent[];
      expect(errors[0].docId).toBe("expenses_lunch");
      expect(errors[0].error.name).toBe("DecryptionError");
    });

    test("should handle corrupted encrypted data", async () => {
      await db.put({
        _id: "expenses_lunch",
        d: "invalid-encrypted-data",
      });

      const onError = jest.fn();
      store = new EncryptedPouch(db, "test-password", {
        onChange: jest.fn(),
        onDelete: jest.fn(),
        onError,
      });
      await store.loadAll();

      expect(onError).toHaveBeenCalled();
      const errors = onError.mock.calls[0][0] as DecryptionErrorEvent[];
      expect(errors[0].docId).toBe("expenses_lunch");
    });
  });

  describe("Conflict Detection", () => {
    test("should expose conflict resolution methods", async () => {
      store = new EncryptedPouch(db, "test-password");
      await store.loadAll();

      // Verify the methods exist
      expect(typeof store.resolveConflict).toBe("function");
      expect(typeof store.getConflictInfo).toBe("function");

      // Create a document and check for conflicts (should be none)
      await store.put("expenses", { _id: "lunch", amount: 15 });
      const conflictInfo = await store.getConflictInfo("expenses", "lunch");
      expect(conflictInfo).toBeNull();

      // Non-existent document should also return null
      const noDoc = await store.getConflictInfo("expenses", "nonexistent");
      expect(noDoc).toBeNull();
    });
  });

  describe("Multiple Tables", () => {
    test("should handle multiple tables independently", async () => {
      store = new EncryptedPouch(db, "test-password");
      await store.loadAll();

      // Create documents in different tables, including same ID in different tables
      await store.put("expenses", { _id: "lunch", amount: 15 });
      await store.put("expenses", { _id: "dinner", amount: 25 });
      await store.put("tasks", { _id: "lunch", title: "Lunch meeting" });
      await store.put("notes", { _id: "note1", text: "Meeting notes" });

      // Verify documents are stored in correct tables
      const expense = await store.get("expenses", "lunch");
      const task = await store.get("tasks", "lunch");

      expect(expense?.amount).toBe(15);
      expect(expense?.title).toBeUndefined();

      expect(task?.title).toBe("Lunch meeting");
      expect(task?.amount).toBeUndefined();

      // Verify getAll() works with and without table filter
      const allDocs = await store.getAll();
      expect(allDocs.length).toBe(4);

      const expenses = await store.getAll("expenses");
      expect(expenses.length).toBe(2);

      const tasks = await store.getAll("tasks");
      expect(tasks.length).toBe(1);
    });
  });

  describe("Sync Events", () => {
    test("should emit sync events when syncing", async () => {
      const onSync = jest.fn();
      const remoteDb = new PouchDB("remote-test-db", { adapter: "memory" });

      try {
        store = new EncryptedPouch(db, "test-password", {
          onChange: () => {},
          onDelete: () => {},
          onSync,
        });
        await store.loadAll();

        await store.put("expenses", { _id: "lunch", amount: 15 });

        // Connect to remote (in-memory, so instant)
        await store.connectRemote({
          url: remoteDb as any,
          live: false, // Don't use live sync in tests
          retry: false,
        });

        // Wait for sync to complete
        await waitFor(() => expect(onSync).toHaveBeenCalled(), 3000);

        const syncInfo = onSync.mock.calls[0][0] as SyncInfo;
        expect(syncInfo.direction).toBeDefined();
        expect(syncInfo.change).toBeDefined();
      } finally {
        store.disconnectRemote();
        await remoteDb.destroy();
      }
    });

    test("should manually sync with syncNow()", async () => {
      const remoteDb = new PouchDB("remote-test-db-2", {
        adapter: "memory",
      });
      const onSync = jest.fn();

      try {
        store = new EncryptedPouch(db, "test-password", {
          onChange: () => {},
          onDelete: () => {},
          onSync,
        });
        await store.loadAll();

        // Add a document first
        await store.put("expenses", { _id: "dinner", amount: 25 });

        // Connect to remote without live sync
        await store.connectRemote({
          url: remoteDb as any,
          live: false,
          retry: false,
        });

        // Manually trigger sync
        await store.syncNow();

        // Verify document was synced to remote
        const allDocs = await remoteDb.allDocs({ include_docs: true });
        expect(allDocs.rows.length).toBeGreaterThan(0);
        expect(allDocs.rows.some((row) => row.id === "expenses_dinner")).toBe(
          true,
        );

        // Verify onSync callback was triggered
        expect(onSync).toHaveBeenCalled();
      } finally {
        store.disconnectRemote();
        await remoteDb.destroy();
      }
    }, 10000);

    test("should throw error when syncNow() called without remote", async () => {
      store = new EncryptedPouch(db, "test-password");
      await store.loadAll();

      await expect(store.syncNow()).rejects.toThrow(
        "No remote connection configured",
      );
    });

    test("should trigger onSync callback even when no changes occur", async () => {
      const remoteDb = new PouchDB("remote-test-db-3", {
        adapter: "memory",
      });
      const onSync = jest.fn();

      try {
        store = new EncryptedPouch(db, "test-password", {
          onChange: () => {},
          onDelete: () => {},
          onSync,
        });
        await store.loadAll();

        // Connect to remote
        await store.connectRemote({
          url: remoteDb as any,
          live: false,
          retry: false,
        });

        // Sync once to ensure databases are in sync
        await store.syncNow();
        onSync.mockClear();

        // Sync again with no changes
        await store.syncNow();

        // Verify onSync callback was still triggered
        expect(onSync).toHaveBeenCalled();
      } finally {
        store.disconnectRemote();
        await remoteDb.destroy();
      }
    }, 10000);

    test("should sync remote deletions and trigger onDelete", async () => {
      const remoteDb = new PouchDB("remote-test-db-4", {
        adapter: "memory",
      });
      const onDelete =
        jest.fn<
          (deletions: Array<{ table: string; docs: { _id: string }[] }>) => void
        >();

      try {
        store = new EncryptedPouch(db, "test-password", {
          onChange: () => {},
          onDelete,
        });
        await store.loadAll();

        // 1. Save document in encrypted store
        await store.put("expenses", { _id: "some-id", data: "secret" });

        // 2. One-shot sync to remote
        await store.connectRemote({
          url: remoteDb as any,
          live: false,
          retry: false,
        });
        await store.syncNow();

        // Verify document was synced
        const doc = await remoteDb.get("expenses_some-id");
        expect(doc).toBeDefined();

        // 3. Delete in remote database
        await remoteDb.remove(doc);

        // 4. One-shot sync back
        await store.syncNow();

        // 5. Verify onDelete was called
        await waitFor(() => expect(onDelete).toHaveBeenCalled(), 3000);
        const deletions = onDelete.mock.calls[0][0];
        expect(deletions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              table: "expenses",
              docs: expect.arrayContaining([
                expect.objectContaining({
                  _id: "some-id",
                }),
              ]),
            }),
          ]),
        );

        // Verify document is deleted locally
        const retrieved = await store.get("expenses", "some-id");
        expect(retrieved).toBeNull();
      } finally {
        store.disconnectRemote();
        await remoteDb.destroy();
      }
    }, 10000);
  });

  describe("Security", () => {
    test("⚠️ WARNING: underscore-prefixed fields are passed through (not encrypted)", async () => {
      store = new EncryptedPouch(db, "test-password");
      await store.loadAll();

      // Test 1: Normal usage - only encrypted fields
      await store.put("expenses", {
        _id: "lunch",
        amount: 15,
        secretData: "this is encrypted",
      });

      const retrieved = await store.get("expenses", "lunch");
      expect(retrieved?.amount).toBe(15);
      expect(retrieved?.secretData).toBe("this is encrypted");

      // Verify the raw document in PouchDB
      const rawDoc = await db.get("expenses_lunch");
      expect(rawDoc).toBeDefined();

      // Verify encrypted data 'd' exists (normal fields are encrypted)
      expect((rawDoc as any).d).toBeDefined();
      expect(typeof (rawDoc as any).d).toBe("string");
      expect((rawDoc as any).d).toMatch(/^[0-9a-f]+\|[0-9a-f]+$/);

      // The encrypted data contains only non-underscore fields
      const decrypted = JSON.parse(
        await new (await import("../encryption.js")).EncryptionHelper(
          "test-password",
        ).decrypt((rawDoc as any).d),
      );
      expect(decrypted.amount).toBe(15);
      expect(decrypted.secretData).toBe("this is encrypted");

      // Test 2: Valid PouchDB _ fields work (_deleted, _attachments, etc.)
      // These are passed through and NOT encrypted
      const putResult = await store.put("expenses", {
        _id: "valid-underscore",
        amount: 25,
        _deleted: false, // Valid PouchDB field
      });

      // PouchDB accepts _deleted but doesn't return it when false
      // Check that the put succeeded (proves _deleted was accepted)
      expect(putResult._id).toBe("valid-underscore");
      const rawDoc2 = await db.get("expenses_valid-underscore");
      expect((rawDoc2 as any).d).toBeDefined(); // Encrypted data exists

      // Test 3: Invalid custom _ fields are rejected by PouchDB
      await expect(
        store.put("expenses", {
          _id: "invalid",
          amount: 20,
          _customField: "PouchDB will reject this",
        }),
      ).rejects.toThrow(/doc_validation|Bad special document member/);
    });
  });
});

// Helper function to wait for async conditions
function waitFor(
  condition: () => boolean | void,
  timeout: number = 1000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    const check = () => {
      try {
        const result = condition();
        if (result !== false) {
          resolve();
          return;
        }
      } catch (error) {
        // Condition not met yet
      }

      if (Date.now() - startTime > timeout) {
        reject(new Error("Timeout waiting for condition"));
        return;
      }

      setTimeout(check, 50);
    };

    check();
  });
}
