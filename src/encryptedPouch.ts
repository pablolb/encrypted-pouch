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
  /** Full PouchDB document ID (table_id format) */
  docId: string;
  /** The error that occurred during decryption */
  error: Error;
  /** The raw encrypted document from PouchDB */
  rawDoc: any;
}

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
   * Optional callback for decryption errors.
   * Called when a document fails to decrypt (e.g., wrong password, corrupted data).
   *
   * @param errors - Array of decryption errors
   */
  onError?: (errors: DecryptionErrorEvent[]) => void;
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

      const docsByTable = new Map<string, Doc[]>();
      const errors: DecryptionErrorEvent[] = [];
      const conflicts: ConflictInfo[] = [];

      for (const row of result.rows) {
        if (!row.doc || row.id.startsWith("_design/")) continue;

        const encryptedDoc = row.doc as EncryptedDoc & {
          _conflicts?: string[];
        };

        if (encryptedDoc.d) {
          try {
            const doc = await this.decryptDoc(encryptedDoc);
            const parsed = this.parseFullId(encryptedDoc._id);
            if (parsed) {
              if (!docsByTable.has(parsed.table)) {
                docsByTable.set(parsed.table, []);
              }
              docsByTable.get(parsed.table)!.push(doc);
            }

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
          } catch (error) {
            errors.push({
              docId: encryptedDoc._id,
              error: error instanceof Error ? error : new Error(String(error)),
              rawDoc: encryptedDoc,
            });
          }
        }
      }

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
