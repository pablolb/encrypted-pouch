/**
 * Encrypted storage with change detection using PouchDB
 * Simple API with AES-256-GCM encryption
 * @packageDocumentation
 */

export { EncryptedPouch } from "./encryptedPouch.js";
export type {
  Doc,
  PouchListener,
  DecryptionErrorEvent,
  ConflictInfo,
  SyncInfo,
  RemoteOptions,
  EncryptedPouchOptions,
} from "./encryptedPouch.js";

export { EncryptionHelper, DecryptionError } from "./encryption.js";
export type { CryptoInterface } from "./encryption.js";

export const VERSION = "2.1.0";

// Re-export PouchDB for convenience
// Use pouchdb-browser for Vite/browser compatibility
import PouchDB from "pouchdb-browser";
export { PouchDB };
