# Encrypted Pouch

Client-side encrypted document storage with events using PouchDB and AES-256-GCM encryption.

## Why This Exists

This library is the core of a PWA I've been using in production for years. It solves a simple problem: keep your data encrypted at rest and in transit, but work with plain objects in memory.

## Use Case

**Small to medium databases that fit comfortably in memory.**

- Plain text objects in memory for fast access
- Browser persists only encrypted data (IndexedDB)
- Only encrypted data is synced to remote servers
- Your data stays private - servers only see encrypted blobs

Perfect for personal productivity apps, expense trackers, note-taking apps, etc.

## Features

- 🔐 AES-256-GCM encryption with WebCrypto API
- 📦 Simple document API: `put`, `get`, `delete`, `getAll`
- 🔄 Real-time events (`onChange`, `onDelete`, `onConflict`, `onSync`, `onError`)
- 🌐 Sync to CouchDB or Cloudant
- 🔌 Offline-first with automatic retry
- 📱 Works in browser and Node.js

## Installation

### Browser (Vite/Webpack)

```bash
npm install @mrbelloc/encrypted-pouch pouchdb-browser@^8.0.1 events
```

**Note:** PouchDB v8 is required. The `events` package fixes compatibility issues with Vite.

### Node.js

```bash
npm install @mrbelloc/encrypted-pouch pouchdb
```

## Quick Start

```typescript
import PouchDBModule from 'pouchdb-browser';
const PouchDB = PouchDBModule.default || PouchDBModule;
import { EncryptedPouch } from '@mrbelloc/encrypted-pouch';

// Create database and encrypted store
const db = new PouchDB('myapp');
const store = new EncryptedPouch(db, 'my-password', {
  onChange: (changes) => {
    changes.forEach(({ table, docs }) => {
      console.log(`${docs.length} documents changed in ${table}`);
      // Update your UI state here
    });
  },
  onDelete: (deletions) => {
    deletions.forEach(({ table, docs }) => {
      console.log(`${docs.length} documents deleted from ${table}`);
    });
  }
});

// Load existing data and start listening for events
await store.loadAll();

// Create/update documents
await store.put('expenses', {
  _id: 'lunch',
  amount: 15.50,
  date: '2024-01-15'
});

// Get a document
const expense = await store.get('expenses', 'lunch');

// Get all documents (optionally filtered by table)
const allExpenses = await store.getAll('expenses');

// Delete a document
await store.delete('expenses', 'lunch');

// Sync to CouchDB/Cloudant
await store.connectRemote({
  url: 'https://username:password@username.cloudant.com/mydb',
  live: true,
  retry: true
});
```

## Important Security Notes

### Encryption

- Uses native WebCrypto API (good performance, browser-native)
- Encryption happens client-side before any data leaves the device
- Remote servers only see encrypted blobs
- Password is never transmitted or stored
- **The encryption is only as strong as your passphrase** - use a strong password
- Default: PBKDF2 with 100k iterations for password derivation
- Advanced: You can pass a pre-derived key using `passphraseMode: "raw"` for more control (custom KDF, iterations, progress UI, etc.)

**⚠️ Disclaimer:** I am not a security expert. This library works for my personal use case, but use at your own risk. If you need high-security guarantees, please have the code audited by a professional.

### ⚠️ Critical: Underscore-Prefixed Fields

**Fields starting with `_` are passed through to PouchDB and are NOT encrypted.**

PouchDB uses `_` prefix for metadata fields like `_id`, `_rev`, `_attachments`, `_deleted`, etc. These fields are stored in plaintext at the document root.

```typescript
// ✅ SAFE - Normal fields are encrypted
await store.put('users', {
  _id: 'user1',
  name: 'Alice',
  secret: 'password123'  // This is encrypted
});

// ✅ ALLOWED - Valid PouchDB field (stored in plaintext, not encrypted)
await store.put('users', {
  _id: 'user1',
  name: 'Alice',
  _deleted: false  // Valid PouchDB metadata, NOT encrypted
});

// ❌ REJECTED - PouchDB doesn't allow custom _ fields
await store.put('users', {
  _id: 'user1',
  _custom: 'data'  // Error: "Bad special document member"
});
```

**Best Practice:** Use normal field names (no `_` prefix) for all your data. PouchDB will reject unknown `_` fields anyway.

## Sync to Cloudant (Free Tier)

IBM Cloudant offers a free tier: 1GB storage, 20 req/sec.

```typescript
// Option 1: Continuous sync (recommended for most apps)
await store.connectRemote({
  url: 'https://username:password@username.cloudant.com/mydb',
  live: true,
  retry: true
});

// Option 2: Manual sync control (useful for rate limiting)
await store.connectRemote({
  url: 'https://username:password@username.cloudant.com/mydb',
  live: false,
  retry: false
});
await store.syncNow(); // Trigger sync manually
```

## API Documentation

Full API documentation is available at: [https://pablolb.github.io/encrypted-pouch/](https://pablolb.github.io/encrypted-pouch/)

## Development

Run tests:
```bash
npm test              # Run tests once
npm run test:watch    # Run tests in watch mode
```

## How It Works

1. **In Memory**: Work with plain JavaScript objects
2. **On Disk**: PouchDB stores encrypted data in IndexedDB (browser) or LevelDB (Node)
3. **Sync**: Only encrypted data is synced to remote CouchDB/Cloudant
4. **Events**: PouchDB's changes feed triggers your callbacks

## License

MIT

## Why PouchDB?

- **Mature**: 10+ years of production use
- **Reliable**: Battle-tested conflict resolution
- **Compatible**: Works with any CouchDB server
- **Offline-first**: Built for unreliable networks
- **Simple**: Easy to understand replication model
- **Free**: No vendor lock-in, self-hostable
