/**
 * Encrypted storage with change detection using PouchDB
 * Simple API: put, get, delete, loadAll
 */

import { EncryptionHelper } from "./encryption.js";
import type PouchDB from "pouchdb";

/**
 * Document to be created or updated (before encryption)
 */
export interface NewDoc {
  /** Optional document ID. If not provided, one will be auto-generated */
  _id?: string;
  /** User data fields */
  [key: string]: any;
}

/**
 * Decrypted document with PouchDB metadata
 */
export interface Doc extends NewDoc {
  /** Document ID */
  _id: string;
  /** PouchDB revision ID */
  _rev: string;
}

/**
 * Document ID and revision pair
 */
export interface IdAndVersion {
  /** Document ID */
  id: string;
  /** PouchDB revision ID */
  rev: string;
}

/**
 * Reference to a deleted document
 */
export interface DocRef {
  /** Document ID */
  _id: string;
}

/**
 * Information about a decryption error
 */
export interface DecryptionErrorEvent {
  /** Discriminator for the error event kind */
  kind: "decrypt";
  /** Full PouchDB document ID (table_id format) */
  docId: string;
  /** The error that occurred during decryption */
  error: Error;
  /** The raw encrypted document from PouchDB */
  rawDoc: any;
}

/**
 * Information about a write error from a bulk operation (e.g. putAll).
 *
 * Surfaced when an individual document in a batch fails to write, for example
 * because of a revision conflict on update.
 */
export interface WriteErrorEvent {
  /** Discriminator for the error event kind */
  kind: "write";
  /** Full PouchDB document ID (table_id format) */
  docId: string;
  /** Document table name */
  table: string;
  /** Document ID within the table */
  id: string;
  /** The error reported by PouchDB */
  error: Error;
  /** The input document that failed to write */
  doc: NewDoc;
}

/**
 * Union of all error events surfaced via {@link PouchListener.onError}.
 *
 * Use the `kind` discriminator to distinguish decryption errors from
 * bulk-write errors.
 */
export type ErrorEvent = DecryptionErrorEvent | WriteErrorEvent;

/**
 * Information about a document conflict detected during sync
 */
export interface ConflictInfo {
  /** Full PouchDB document ID (table_id format) */
  docId: string;
  /** Document table name */
  table: string;
  /** Document ID within the table */
  id: string;
  /** Current revision ID */
  currentRev: string;
  /** Array of conflicting revision IDs */
  conflictRevs: string[];
  /** The winning (current) document version */
  winner: Doc;
  /** Array of losing (conflicting) document versions */
  losers: Doc[];
}

/**
 * Information about a sync operation
 */
export interface SyncInfo {
  /** Direction of sync: push to remote, pull from remote, or bidirectional */
  direction: "push" | "pull" | "both";
  /** Details about the changes that occurred */
  change: {
    /** Number of documents read during sync */
    docs_read?: number;
    /** Number of documents written during sync */
    docs_written?: number;
    /** Number of document write failures */
    doc_write_failures?: number;
    /** Array of errors that occurred */
    errors?: any[];
  };
}

/**
 * Callbacks for document changes, deletions, conflicts, sync events, and errors
 */
export interface PouchListener {
  /**
   * Called when documents are added or updated.
   * Documents are batched by table for performance.
   * On initial load with thousands of documents, you get one callback per table
   * instead of thousands of individual callbacks.
   *
   * @param changes - Array of changes, each containing a table name and array of documents
   */
  onChange: (changes: Array<{ table: string; docs: Doc[] }>) => void;

  /**
   * Called when documents are deleted.
   * Deletions are batched by table for performance.
   *
   * @param deletions - Array of deletions, each containing a table name and array of document references
   */
  onDelete: (deletions: Array<{ table: string; docs: DocRef[] }>) => void;

  /**
   * Optional callback for conflict detection.
   * Called when PouchDB detects conflicting versions of a document during sync.
   *
   * @param conflicts - Array of conflict information
   */
  onConflict?: (conflicts: ConflictInfo[]) => void;

  /**
   * Optional callback for sync progress events.
   * Called during sync operations to report progress.
   *
   * @param info - Information about the sync operation
   */
  onSync?: (info: SyncInfo) => void;

  /**
   * Optional callback for error events.
   *
   * Fires for two kinds of error:
   * - `kind: "decrypt"` — a stored document failed to decrypt
   *   (wrong password, corrupted ciphertext).
   * - `kind: "write"` — a document in a bulk write (see {@link EncryptedPouch.putAll})
   *   was rejected by PouchDB (e.g. a revision conflict).
   *
   * Use the `kind` discriminator to handle each case.
   *
   * @param errors - Array of error events
   */
  onError?: (errors: ErrorEvent[]) => void;
}

/**
 * Options for connecting to a remote CouchDB server
 */
export interface RemoteOptions {
  /** URL of the remote CouchDB server or PouchDB instance */
  url: string;
  /** Whether to use continuous (live) sync. Default: true */
  live?: boolean;
  /** Whether to automatically retry on connection failure. Default: true */
  retry?: boolean;
}

/**
 * Options for configuring the EncryptedPouch
 */
export interface EncryptedPouchOptions {
  /**
   * Key derivation mode for the passphrase.
   *
   * - `"derive"` (default): Use PBKDF2 with 100k iterations for user passphrases.
   *   Recommended for production use. Provides strong protection against brute-force
   *   and dictionary attacks. First unlock will take ~50-100ms.
   *
   * - `"raw"`: Use SHA-256 only. For pre-derived keys or advanced users who handle
   *   key derivation themselves. Allows full control over KDF algorithm, iterations,
   *   and progress UI.
   *
   * @default "derive"
   */
  passphraseMode?: "derive" | "raw";
}

interface EncryptedDoc {
  _id: string;
  _rev?: string;
  d: string;
}

/** Current {@link BackupDump} schema version. */
export const BACKUP_DUMP_VERSION = 1;

/**
 * A plaintext, re-loadable snapshot of a database: every document, decrypted and
 * grouped by table, with `_rev` stripped (a per-database storage detail that does
 * not survive a move to another database).
 *
 * Produced by {@link EncryptedPouch.export} and consumed by
 * {@link EncryptedPouch.loadFromJSONBackup}. Serialize it to JSON for an
 * off-device backup; the caller owns any outer envelope/metadata.
 */
export interface BackupDump {
  /** Dump schema version (see {@link BACKUP_DUMP_VERSION}). */
  version: number;
  /** table name → its documents (logical `_id`, no `_rev`). */
  tables: Record<string, NewDoc[]>;
}

/**
 * Encrypted document store with change detection and sync capabilities.
 *
 * This class provides a simple API for storing encrypted documents in PouchDB
 * with real-time change detection and optional sync to CouchDB servers.
 *
 * @example
 * ```typescript
 * const db = new PouchDB('myapp');
 * const store = new EncryptedPouch(db, 'my-password', {
 *   onChange: (changes) => {
 *     changes.forEach(({ table, docs }) => {
 *       console.log(`${docs.length} docs changed in ${table}`);
 *     });
 *   },
 *   onDelete: (deletions) => console.log('Deleted:', deletions)
 * });
 *
 * await store.loadAll();
 * await store.put('expenses', { _id: 'lunch', amount: 15 });
 * const doc = await store.get('expenses', 'lunch');
 * ```
 */
export class EncryptedPouch {
  private db: PouchDB.Database;
  private encryptionHelper: EncryptionHelper;
  private listener: PouchListener;
  private changesHandler: PouchDB.Core.Changes<any> | null = null;
  private syncHandler: PouchDB.Replication.Sync<any> | null = null;
  private remoteUrl: string | null = null;
  private processingChain: Promise<void> = Promise.resolve();

  /**
   * Creates a new EncryptedPouch instance.
   *
   * @param db - PouchDB database instance
   * @param password - Encryption password (will be derived using PBKDF2 by default)
   * @param listener - Optional callbacks for document changes, deletions, etc.
   * @param options - Optional configuration (e.g., passphraseMode)
   */
  constructor(
    db: PouchDB.Database,
    password: string,
    listener?: PouchListener,
    options?: EncryptedPouchOptions,
  ) {
    this.db = db;
    this.encryptionHelper = new EncryptionHelper(
      password,
      undefined,
      options?.passphraseMode || "derive",
    );
    this.listener = listener || { onChange: () => {}, onDelete: () => {} };
  }

  /**
   * Loads all existing documents from the database and starts change detection.
   *
   * This should be called once after creating the EncryptedStore instance.
   * It will decrypt all documents, trigger onChange callbacks (batched by table),
   * and set up real-time change listeners.
   *
   * @throws {Error} If documents fail to decrypt (reported via onError callback)
   *
   * @example
   * ```typescript
   * const store = new EncryptedPouch(db, 'password', { onChange, onDelete });
   * await store.loadAll(); // Loads existing docs and starts listening
   * ```
   */
  async loadAll(): Promise<void> {
    try {
      const result = await this.db.allDocs({
        include_docs: true,
        conflicts: true,
      });

      // Decrypt every doc in parallel. The previous sequential `await` per
      // row was the dominant cost on large datasets — WebCrypto can handle
      // many concurrent AES-GCM operations cheaply, so kicking them all off
      // at once and letting the runtime batch is dramatically faster than
      // walking them one by one (~1–2ms round-trip × N docs adds up).
      const decryptions = await Promise.all(
        result.rows.map(async (row) => {
          if (!row.doc || row.id.startsWith("_design/")) return null;
          const enc = row.doc as EncryptedDoc & { _conflicts?: string[] };
          if (!enc.d) return null;
          try {
            const doc = await this.decryptDoc(enc);
            return { enc, doc, error: null as Error | null };
          } catch (error) {
            return {
              enc,
              doc: null as Doc | null,
              error: error instanceof Error ? error : new Error(String(error)),
            };
          }
        }),
      );

      const docsByTable = new Map<string, Doc[]>();
      const errors: DecryptionErrorEvent[] = [];
      const conflictInputs: Array<{
        enc: EncryptedDoc & { _conflicts?: string[] };
        doc: Doc;
      }> = [];

      for (const item of decryptions) {
        if (!item) continue;
        if (item.error) {
          errors.push({
            kind: "decrypt",
            docId: item.enc._id,
            error: item.error,
            rawDoc: item.enc,
          });
          continue;
        }
        const parsed = this.parseFullId(item.enc._id);
        if (parsed) {
          if (!docsByTable.has(parsed.table)) {
            docsByTable.set(parsed.table, []);
          }
          docsByTable.get(parsed.table)!.push(item.doc!);
        }
        if (item.enc._conflicts && item.enc._conflicts.length > 0) {
          conflictInputs.push({ enc: item.enc, doc: item.doc! });
        }
      }

      // Conflict resolution is also a string of decrypts — parallelize too.
      const conflicts = await Promise.all(
        conflictInputs.map((c) =>
          this.buildConflictInfo(
            c.enc._id,
            c.enc._rev!,
            c.enc._conflicts!,
            c.doc,
          ),
        ),
      );

      if (docsByTable.size > 0) {
        const changes = Array.from(docsByTable.entries()).map(
          ([table, docs]) => ({ table, docs }),
        );
        this.listener.onChange(changes);
      }
      if (errors.length > 0 && this.listener.onError) {
        this.listener.onError(errors);
      }
      if (conflicts.length > 0 && this.listener.onConflict) {
        this.listener.onConflict(conflicts);
      }
    } catch (error) {
      console.error("[EncryptedPouch] loadAll failed:", error);
    }

    this.setupSubscription();
  }

  /**
   * Creates or updates a document in the specified table.
   *
   * If the document has no `_id`, one will be auto-generated.
   * If the document has an `_id` and `_rev`, it will be updated.
   * If the `_rev` doesn't match the current revision, a conflict error is thrown.
   *
   * @param table - Document type/table (e.g., "expenses", "tasks")
   * @param doc - Document to store. Include `_rev` for updates.
   * @returns The saved document with `_id` and `_rev` populated
   * @throws {Error} If there's a revision conflict
   *
   * @example
   * ```typescript
   * // Create new document
   * const doc = await store.put('expenses', { amount: 15, desc: 'Lunch' });
   *
   * // Update existing document
   * const updated = await store.put('expenses', {
   *   _id: doc._id,
   *   _rev: doc._rev,
   *   amount: 20
   * });
   * ```
   */
  async put(table: string, doc: NewDoc): Promise<Doc> {
    // Generate ID if not provided (for new documents)
    if (!doc._id) {
      doc._id =
        crypto.randomUUID?.() ||
        `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }

    const fullId = `${table}_${doc._id}`;
    const encryptedDoc = await this.encryptDoc(doc, fullId);

    // If doc has _rev, it's an update - preserve it
    if ("_rev" in doc && doc._rev) {
      encryptedDoc._rev = doc._rev;
    }
    // Otherwise it's a create - no _rev needed

    const result = await this.db.put(encryptedDoc);

    return { ...doc, _id: doc._id, _rev: result.rev };
  }

  /**
   * Writes multiple documents to a table in a single bulk operation.
   *
   * Documents without an `_id` get one auto-generated. Documents with an `_id`
   * are upserted: include `_rev` to update an existing document, omit it to
   * create a new one (a stale or missing `_rev` on an existing document
   * surfaces as a write error via {@link PouchListener.onError} with
   * `kind: "write"`, while the rest of the batch still succeeds).
   *
   * Successful writes flow through the existing changes feed and are reported
   * via {@link PouchListener.onChange}, batched per table.
   *
   * @param table - Document table name
   * @param docs - Documents to write
   *
   * @example
   * ```typescript
   * await store.putAll('expenses', [
   *   { _id: 'lunch', amount: 15 },
   *   { _id: 'dinner', amount: 25 },
   *   { amount: 5 }, // _id auto-generated
   * ]);
   * ```
   */
  async putAll(table: string, docs: NewDoc[]): Promise<void> {
    if (docs.length === 0) return;

    const encryptedDocs: EncryptedDoc[] = [];
    const inputByFullId = new Map<string, NewDoc>();

    for (const doc of docs) {
      if (!doc._id) {
        doc._id =
          crypto.randomUUID?.() ||
          `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      }
      const fullId = `${table}_${doc._id}`;
      const encryptedDoc = await this.encryptDoc(doc, fullId);
      if ("_rev" in doc && doc._rev) {
        encryptedDoc._rev = doc._rev;
      }
      encryptedDocs.push(encryptedDoc);
      inputByFullId.set(fullId, doc);
    }

    const results = await this.db.bulkDocs(encryptedDocs);

    const writeErrors: WriteErrorEvent[] = [];
    for (const result of results) {
      if ("error" in result && result.error) {
        const fullId = result.id ?? "";
        const parsed = this.parseFullId(fullId);
        const inputDoc = inputByFullId.get(fullId);
        if (parsed && inputDoc) {
          writeErrors.push({
            kind: "write",
            docId: fullId,
            table: parsed.table,
            id: parsed.id,
            error:
              result instanceof Error
                ? result
                : new Error(result.message || result.name || "Write failed"),
            doc: inputDoc,
          });
        }
      }
    }

    if (writeErrors.length > 0 && this.listener.onError) {
      this.listener.onError(writeErrors);
    }
  }

  /**
   * Retrieves a document by table and ID.
   *
   * @param table - Document table name
   * @param id - Document ID within the table
   * @returns The decrypted document, or null if not found
   *
   * @example
   * ```typescript
   * const expense = await store.get('expenses', 'lunch');
   * if (expense) {
   *   console.log(expense.amount);
   * }
   * ```
   */
  async get(table: string, id: string): Promise<Doc | null> {
    try {
      const fullId = `${table}_${id}`;
      const encryptedDoc = (await this.db.get(fullId, {
        conflicts: true,
      })) as EncryptedDoc & { _conflicts?: string[] };

      const doc = await this.decryptDoc(encryptedDoc);

      // Notify about conflicts if present
      if (
        encryptedDoc._conflicts &&
        encryptedDoc._conflicts.length > 0 &&
        this.listener.onConflict
      ) {
        const conflictInfo = await this.buildConflictInfo(
          encryptedDoc._id,
          encryptedDoc._rev!,
          encryptedDoc._conflicts,
          doc,
        );
        this.listener.onConflict([conflictInfo]);
      }

      return doc;
    } catch {
      return null;
    }
  }

  /**
   * Deletes a document from the specified table.
   *
   * @param table - Document table name
   * @param id - Document ID within the table
   *
   * @example
   * ```typescript
   * await store.delete('expenses', 'lunch');
   * ```
   */
  async delete(table: string, id: string): Promise<void> {
    const fullId = `${table}_${id}`;
    try {
      const doc = await this.db.get(fullId);
      await this.db.remove(doc);
    } catch (error) {
      console.warn(`[EncryptedPouch] Could not delete ${fullId}:`, error);
    }
  }

  /**
   * Deletes all documents from the local database only.
   *
   * Automatically disconnects sync first to prevent deletions from propagating to remote.
   * Use this when you want to clear local data without affecting the remote server.
   *
   * @example
   * ```typescript
   * await store.deleteAllLocal(); // Clear local data only
   * ```
   */
  async deleteAllLocal(): Promise<void> {
    // Disconnect sync to ensure deletions stay local
    this.disconnectRemote();

    const result = await this.db.allDocs({ include_docs: false });

    const docsToDelete = result.rows
      .filter((row) => !row.id.startsWith("_design/"))
      .map((row) => ({
        _id: row.id,
        _rev: row.value.rev,
        _deleted: true,
      }));

    if (docsToDelete.length > 0) {
      await this.db.bulkDocs(docsToDelete);
    }
  }

  /**
   * Deletes all documents locally AND propagates deletions to remote server.
   *
   * Waits for sync to complete before returning.
   * The remote connection must be established first with `connectRemote()`.
   *
   * @throws {Error} If sync is not connected
   *
   * @example
   * ```typescript
   * await store.connectRemote({ url: 'http://localhost:5984/mydb' });
   * await store.deleteAllAndSync(); // Delete everything locally and remotely
   * ```
   */
  async deleteAllAndSync(): Promise<void> {
    if (!this.syncHandler) {
      throw new Error(
        "Sync is not connected. Call connectRemote() first or use deleteAllLocal() instead.",
      );
    }

    const result = await this.db.allDocs({ include_docs: false });

    const docsToDelete = result.rows
      .filter((row) => !row.id.startsWith("_design/"))
      .map((row) => ({
        _id: row.id,
        _rev: row.value.rev,
        _deleted: true,
      }));

    if (docsToDelete.length === 0) {
      return; // Nothing to delete
    }

    // Delete all documents
    await this.db.bulkDocs(docsToDelete);

    // Wait for sync to propagate deletions
    return new Promise<void>((resolve, reject) => {
      let changeCount = 0;
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          reject(new Error("Timeout waiting for deletions to sync to remote"));
        }
      }, 30000); // 30 second timeout

      const changeHandler = (info: any) => {
        if (info.direction === "push") {
          changeCount += info.change.docs_written || 0;

          // Wait until all deletions have been pushed
          if (changeCount >= docsToDelete.length && !resolved) {
            clearTimeout(timeout);
            resolved = true;
            this.syncHandler?.removeListener("change", changeHandler);
            this.syncHandler?.removeListener("error", errorHandler);
            resolve();
          }
        }
      };

      const errorHandler = (err: any) => {
        if (!resolved) {
          clearTimeout(timeout);
          resolved = true;
          this.syncHandler?.removeListener("change", changeHandler);
          this.syncHandler?.removeListener("error", errorHandler);
          reject(err);
        }
      };

      this.syncHandler!.on("change", changeHandler);
      this.syncHandler!.on("error", errorHandler);
    });
  }

  /**
   * Retrieves all documents, optionally filtered by table.
   *
   * @param table - Optional table name to filter by
   * @returns Array of decrypted documents
   *
   * @example
   * ```typescript
   * const allExpenses = await store.getAll('expenses');
   * const allDocs = await store.getAll(); // All tables
   * ```
   */
  async getAll(table?: string): Promise<Doc[]> {
    const result = await this.db.allDocs({
      include_docs: true,
      conflicts: true,
    });

    const docs: Doc[] = [];
    const errors: DecryptionErrorEvent[] = [];

    for (const row of result.rows) {
      if (!row.doc || row.id.startsWith("_design/")) continue;

      const encryptedDoc = row.doc as EncryptedDoc;

      if (encryptedDoc.d) {
        try {
          const doc = await this.decryptDoc(encryptedDoc);
          const parsed = this.parseFullId(encryptedDoc._id);
          if (parsed && (!table || parsed.table === table)) {
            docs.push(doc);
          }
        } catch (error) {
          errors.push({
            kind: "decrypt",
            docId: encryptedDoc._id,
            error: error instanceof Error ? error : new Error(String(error)),
            rawDoc: encryptedDoc,
          });
        }
      }
    }

    if (errors.length > 0 && this.listener.onError) {
      this.listener.onError(errors);
    }

    return docs;
  }

  /**
   * Export every document (or a subset of tables) as a plaintext, re-loadable
   * {@link BackupDump} — decrypted, grouped by table, with `_rev` stripped. The
   * basis of a full backup; pair it with {@link loadFromJSONBackup} to restore.
   *
   * Tables are discovered from the stored documents themselves (their `table_id`
   * ids), so a dump is complete without the caller enumerating table names — the
   * key reason backup belongs in the library. Design documents are skipped.
   * Decryption failures surface via `onError` (like {@link getAll}) and the
   * offending document is omitted.
   *
   * @param opts.tables - Restrict the dump to these tables (default: all).
   */
  async export(opts?: { tables?: string[] }): Promise<BackupDump> {
    const only = opts?.tables ? new Set(opts.tables) : null;
    const result = await this.db.allDocs({ include_docs: true });
    const tables: Record<string, NewDoc[]> = {};
    const errors: DecryptionErrorEvent[] = [];

    // Decrypt in parallel — a backup runs over the whole database, and a
    // sequential `await` per row dominates cost at scale (the same reason
    // loadAll decrypts in parallel). Order within a table is not significant.
    const decrypted = await Promise.all(
      result.rows.map(async (row) => {
        if (!row.doc || row.id.startsWith("_design/")) return null;
        const enc = row.doc as EncryptedDoc;
        if (!enc.d) return null;
        const parsed = this.parseFullId(enc._id);
        if (!parsed || (only && !only.has(parsed.table))) return null;
        try {
          return { table: parsed.table, doc: await this.decryptDoc(enc) };
        } catch (error) {
          errors.push({
            kind: "decrypt",
            docId: enc._id,
            error: error instanceof Error ? error : new Error(String(error)),
            rawDoc: enc,
          });
          return null;
        }
      }),
    );

    for (const item of decrypted) {
      if (!item) continue;
      // Strip _rev — meaningless once the doc moves to another database.
      const { _rev: _drop, ...rest } = item.doc;
      (tables[item.table] ??= []).push(rest as NewDoc);
    }

    if (errors.length > 0 && this.listener.onError) {
      this.listener.onError(errors);
    }

    return { version: BACKUP_DUMP_VERSION, tables };
  }

  /**
   * Load a {@link BackupDump} into THIS store, which **must be empty** (a freshly
   * created database). Each table is written in one bulk `putAll`, then every
   * table's document count is re-read and compared against the dump — a mismatch
   * throws, so a per-document `putAll` failure can never silently lose data.
   *
   * Restore is deliberately "create a fresh database, then load", never "wipe an
   * existing database, then load": {@link deleteAllLocal} leaves tombstones, and
   * re-`put`ting a document with the same id but no `_rev` would 409 against the
   * tombstone. A pristine store makes that whole class of conflict impossible.
   *
   * On a thrown count check the store may be left **partially populated** — the
   * caller should {@link destroy} the fresh database rather than reuse it.
   *
   * @throws {Error} if `dump.version` is newer than this build understands, if
   *   the store is non-empty, or if any document fails to write.
   */
  async loadFromJSONBackup(dump: BackupDump): Promise<void> {
    if (dump.version > BACKUP_DUMP_VERSION) {
      throw new Error(
        `Unsupported backup version ${dump.version}; this build understands up to ${BACKUP_DUMP_VERSION}`,
      );
    }

    const existing = await this.db.allDocs();
    if (existing.rows.some((r) => !r.id.startsWith("_design/"))) {
      throw new Error(
        "loadFromJSONBackup requires an empty store; found existing documents",
      );
    }

    for (const [table, docs] of Object.entries(dump.tables)) {
      if (docs.length === 0) continue;
      // Fresh store ⇒ every write is an unambiguous create; drop any stray _rev.
      const toWrite = docs.map(({ _rev: _drop, ...rest }) => rest);
      await this.putAll(table, toWrite);
    }

    // putAll is best-effort per document (failures surface via onError, not by
    // throwing) — verify per-table counts so an incomplete restore fails loudly.
    // A key-range count over the `${table}_` id prefix avoids decrypting every
    // doc just to tally it (the `_` separator keeps tables from colliding).
    for (const [table, docs] of Object.entries(dump.tables)) {
      const range = await this.db.allDocs({
        startkey: `${table}_`,
        endkey: `${table}_` + "\ufff0",
      });
      if (range.rows.length !== docs.length) {
        throw new Error(
          `Restore incomplete for table "${table}": expected ${docs.length}, wrote ${range.rows.length}`,
        );
      }
    }
  }

  /**
   * Permanently delete the underlying database and stop change detection.
   *
   * Unlike {@link deleteAllLocal} (which tombstones every document, leaving
   * deleted leaves that could conflict with a later re-`put`), this removes the
   * database outright — no tombstones remain. Use it to discard a throwaway /
   * dry-run database, or to clean up the old database after restoring into a new
   * one. The instance is unusable afterward.
   */
  async destroy(): Promise<void> {
    this.disconnectRemote();
    if (this.changesHandler) {
      this.changesHandler.cancel();
      this.changesHandler = null;
    }
    await this.db.destroy();
  }

  /**
   * Check whether `password` can decrypt an existing database, without opening a
   * persistent store or attaching a change feed — it reads at most one stored
   * document and attempts to decrypt it.
   *
   * Returns `true` if a document decrypts, `false` if decryption fails (wrong
   * password). A database with no encrypted documents returns `true`: a
   * passphrase cannot be disproven against zero ciphertext. Intended as a
   * "confirm your passphrase before a destructive action" gate — the caller opens
   * a handle to the current database and passes it in.
   *
   * @param options.passphraseMode - Must match how the database was written
   *   (default `"derive"`).
   */
  static async verifyPassword(
    db: PouchDB.Database,
    password: string,
    options?: EncryptedPouchOptions,
  ): Promise<boolean> {
    const helper = new EncryptionHelper(
      password,
      undefined,
      options?.passphraseMode || "derive",
    );
    const listing = await db.allDocs();
    for (const row of listing.rows) {
      if (row.id.startsWith("_design/")) continue;
      const enc = (await db.get(row.id)) as EncryptedDoc;
      // Skip documents with no encrypted payload — they prove nothing about the
      // password, and stopping at one would let a leading plaintext doc accept
      // any passphrase. Keep scanning for the first real ciphertext.
      if (!enc.d) continue;
      try {
        await helper.decrypt(enc.d);
        return true;
      } catch {
        return false;
      }
    }
    return true; // No ciphertext to check against.
  }

  /**
   * Connects to a remote CouchDB server for bidirectional sync.
   *
   * @param options - Remote server configuration
   *
   * @example
   * ```typescript
   * // Continuous sync (live updates)
   * await store.connectRemote({
   *   url: 'http://localhost:5984/mydb',
   *   live: true,
   *   retry: true
   * });
   *
   * // One-time sync only (manual control)
   * await store.connectRemote({
   *   url: 'http://localhost:5984/mydb',
   *   live: false,
   *   retry: false
   * });
   * await store.syncNow(); // Manually trigger sync
   * ```
   */
  async connectRemote(options: RemoteOptions): Promise<void> {
    this.disconnectRemote();

    this.remoteUrl = options.url;

    const syncOptions: PouchDB.Replication.SyncOptions = {
      live: options.live ?? true,
      retry: options.retry ?? true,
    };

    this.syncHandler = this.db.sync(options.url, syncOptions);

    // Setup sync event listeners
    if (this.listener.onSync) {
      this.syncHandler
        .on("change", (info) => {
          if (this.listener.onSync) {
            this.listener.onSync({
              direction: info.direction as "push" | "pull",
              change: info.change,
            });
          }
        })
        .on("error", (err) => {
          console.error("[EncryptedPouch] sync error:", err);
        });
    }

    // Wait for initial sync to start
    return new Promise<void>((resolve, reject) => {
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      }, 5000);

      this.syncHandler!.on("active", () => {
        if (!resolved) {
          clearTimeout(timeout);
          resolved = true;
          resolve();
        }
      });

      this.syncHandler!.on("error", (err) => {
        if (!resolved) {
          clearTimeout(timeout);
          resolved = true;
          reject(err);
        }
      });
    });
  }

  /**
   * Disconnects from the remote sync server.
   *
   * Stops continuous sync if it was enabled.
   */
  disconnectRemote(): void {
    if (this.syncHandler) {
      this.syncHandler.cancel();
      this.syncHandler = null;
    }
    this.remoteUrl = null;
  }

  /**
   * Trigger an immediate one-time sync with the remote.
   * Requires that connectRemote() has been called first.
   * Returns a promise that resolves when the sync completes.
   */
  async syncNow(): Promise<void> {
    if (!this.remoteUrl) {
      throw new Error(
        "No remote connection configured. Call connectRemote() first.",
      );
    }

    return new Promise<void>((resolve, reject) => {
      const sync = this.db.sync(this.remoteUrl!, {
        live: false,
        retry: false,
      });

      sync
        .on("complete", (info) => {
          if (this.listener.onSync) {
            // Fire onSync for both push and pull if they occurred
            if (info.push && info.push.docs_written !== undefined) {
              this.listener.onSync({
                direction: "push",
                change: {
                  docs_read: info.push.docs_read,
                  docs_written: info.push.docs_written,
                  doc_write_failures: info.push.doc_write_failures,
                  errors: info.push.errors,
                },
              });
            }
            if (info.pull && info.pull.docs_written !== undefined) {
              this.listener.onSync({
                direction: "pull",
                change: {
                  docs_read: info.pull.docs_read,
                  docs_written: info.pull.docs_written,
                  doc_write_failures: info.pull.doc_write_failures,
                  errors: info.pull.errors,
                },
              });
            }
          }
          resolve();
        })
        .on("error", (err) => {
          console.error("[EncryptedPouch] syncNow error:", err);
          reject(err);
        });
    });
  }

  /** Resolve a conflict by choosing the winner */
  /**
   * Manually resolves a document conflict by choosing the winning version.
   *
   * @param table - Document table name
   * @param id - Document ID within the table
   * @param winningDoc - The document version to keep (must include `_rev`)
   *
   * @example
   * ```typescript
   * // In onConflict callback
   * onConflict: async (conflicts) => {
   *   for (const conflict of conflicts) {
   *     // Pick the version with the latest timestamp
   *     const latest = [conflict.winner, ...conflict.losers]
   *       .sort((a, b) => b.timestamp - a.timestamp)[0];
   *
   *     await store.resolveConflict(conflict.table, conflict.id, latest);
   *   }
   * }
   * ```
   */
  async resolveConflict(
    table: string,
    id: string,
    winningDoc: Doc,
  ): Promise<void> {
    const fullId = `${table}_${id}`;

    const doc = (await this.db.get(fullId, { conflicts: true })) as any;

    if (!doc._conflicts || doc._conflicts.length === 0) {
      throw new Error(`No conflicts found for ${fullId}`);
    }

    // Update with winning document
    await this.put(table, winningDoc);

    // Remove all conflicting revisions
    for (const rev of doc._conflicts) {
      try {
        await this.db.remove(fullId, rev);
      } catch (error) {
        console.warn(`Failed to remove conflict ${fullId}@${rev}:`, error);
      }
    }
  }

  /** Check if a document has conflicts without triggering the callback */
  /**
   * Retrieves conflict information for a document without triggering the callback.
   *
   * @param table - Document table name
   * @param id - Document ID within the table
   * @returns Conflict information if conflicts exist, null otherwise
   *
   * @example
   * ```typescript
   * const conflict = await store.getConflictInfo('expenses', 'lunch');
   * if (conflict) {
   *   console.log('Winner:', conflict.winner);
   *   console.log('Losers:', conflict.losers);
   *   // Manually resolve the conflict
   *   await store.resolveConflict('expenses', 'lunch', conflict.winner);
   * }
   * ```
   */
  async getConflictInfo(
    table: string,
    id: string,
  ): Promise<ConflictInfo | null> {
    try {
      const fullId = `${table}_${id}`;
      const encryptedDoc = (await this.db.get(fullId, {
        conflicts: true,
      })) as EncryptedDoc & { _conflicts?: string[] };

      if (!encryptedDoc._conflicts || encryptedDoc._conflicts.length === 0) {
        return null;
      }

      const doc = await this.decryptDoc(encryptedDoc);

      return await this.buildConflictInfo(
        encryptedDoc._id,
        encryptedDoc._rev!,
        encryptedDoc._conflicts,
        doc,
      );
    } catch {
      return null;
    }
  }

  /**
   * Re-subscribes to the PouchDB changes feed.
   *
   * Useful after disconnect/reconnect scenarios or if the change feed needs to be restarted.
   *
   * @example
   * ```typescript
   * store.reconnect(); // Restart change detection
   * ```
   */
  reconnect(): void {
    if (this.changesHandler) {
      this.changesHandler.cancel();
      this.changesHandler = null;
    }
    this.setupSubscription();
  }

  private setupSubscription(): void {
    this.changesHandler = this.db
      .changes({
        since: "now",
        live: true,
        include_docs: true,
        conflicts: true,
      })
      .on("change", (change) => {
        this.processingChain = this.processingChain
          .then(() => this.handleChange(change))
          .catch((err) =>
            console.error("[EncryptedPouch] handleChange error:", err),
          );
      })
      .on("error", (err) => {
        console.error("[EncryptedPouch] changes feed error:", err);
      });
  }

  private async handleChange(
    change: PouchDB.Core.ChangesResponseChange<any>,
  ): Promise<void> {
    if (change.id.startsWith("_design/")) return;

    const encryptedDoc = change.doc as
      | (EncryptedDoc & { _conflicts?: string[] })
      | undefined;

    // Deletion
    if (change.deleted || !encryptedDoc?.d) {
      const parsed = this.parseFullId(change.id);
      if (parsed) {
        this.listener.onDelete([
          { table: parsed.table, docs: [{ _id: parsed.id }] },
        ]);
      }
      return;
    }

    // Changed/added document
    const errors: DecryptionErrorEvent[] = [];
    const conflicts: ConflictInfo[] = [];

    try {
      const doc = await this.decryptDoc(encryptedDoc);

      // Check for conflicts
      if (encryptedDoc._conflicts && encryptedDoc._conflicts.length > 0) {
        const conflictInfo = await this.buildConflictInfo(
          encryptedDoc._id,
          encryptedDoc._rev!,
          encryptedDoc._conflicts,
          doc,
        );
        conflicts.push(conflictInfo);
      }

      const parsed = this.parseFullId(encryptedDoc._id);
      if (parsed) {
        this.listener.onChange([{ table: parsed.table, docs: [doc] }]);
      }
    } catch (error) {
      errors.push({
        kind: "decrypt",
        docId: encryptedDoc._id,
        error: error instanceof Error ? error : new Error(String(error)),
        rawDoc: encryptedDoc,
      });
    }

    if (errors.length > 0 && this.listener.onError) {
      this.listener.onError(errors);
    }
    if (conflicts.length > 0 && this.listener.onConflict) {
      this.listener.onConflict(conflicts);
    }
  }

  private async buildConflictInfo(
    fullId: string,
    currentRev: string,
    conflictRevs: string[],
    winnerDoc: Doc,
  ): Promise<ConflictInfo> {
    const parsed = this.parseFullId(fullId);
    if (!parsed) {
      throw new Error(`Invalid ID format: ${fullId}`);
    }

    const losers: Doc[] = [];
    const errors: DecryptionErrorEvent[] = [];

    for (const rev of conflictRevs) {
      try {
        const conflictDoc = (await this.db.get(fullId, {
          rev,
        })) as EncryptedDoc;
        const decrypted = await this.decryptDoc(conflictDoc);
        losers.push(decrypted);
      } catch (error) {
        errors.push({
          kind: "decrypt",
          docId: `${fullId}@${rev}`,
          error: error instanceof Error ? error : new Error(String(error)),
          rawDoc: { _id: fullId, _rev: rev },
        });
      }
    }

    if (errors.length > 0 && this.listener.onError) {
      this.listener.onError(errors);
    }

    return {
      docId: fullId,
      table: parsed.table,
      id: parsed.id,
      currentRev,
      conflictRevs,
      winner: winnerDoc,
      losers,
    };
  }

  private async decryptDoc(encryptedDoc: EncryptedDoc): Promise<Doc> {
    const parsed = this.parseFullId(encryptedDoc._id);
    if (!parsed) throw new Error(`Invalid ID format: ${encryptedDoc._id}`);

    const decrypted = JSON.parse(
      await this.encryptionHelper.decrypt(encryptedDoc.d),
    );
    return {
      _id: parsed.id,
      _rev: encryptedDoc._rev!,
      ...decrypted,
    };
  }

  private async encryptDoc(doc: any, fullId: string): Promise<EncryptedDoc> {
    // Separate fields: underscore fields go to root (PouchDB metadata), others get encrypted
    const data: Record<string, any> = {};
    const rootFields: Record<string, any> = {
      _id: fullId,
    };

    for (const [key, value] of Object.entries(doc)) {
      // Skip _id (we use fullId instead) and _rev (handled separately in put())
      if (key === "_id" || key === "_rev") {
        continue;
      }

      if (key.startsWith("_")) {
        // Pass through other underscore fields (like _attachments, _conflicts, etc.)
        // PouchDB will validate them - it will accept valid ones and reject invalid ones
        rootFields[key] = value;
      } else {
        // Normal fields get encrypted
        data[key] = value;
      }
    }

    // Encrypt normal fields
    rootFields.d = await this.encryptionHelper.encrypt(JSON.stringify(data));

    return rootFields as EncryptedDoc;
  }

  private parseFullId(fullId: string): { table: string; id: string } | null {
    const idx = fullId.indexOf("_");
    if (idx === -1) return null;
    return { table: fullId.slice(0, idx), id: fullId.slice(idx + 1) };
  }
}
