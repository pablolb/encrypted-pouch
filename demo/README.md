# Encrypted Pouch Demo

Interactive demo showing encrypted PouchDB storage with sync.

## Features

- Two PouchDB databases syncing in real-time
- View decrypted data in memory
- View encrypted data on disk (both local and synced)
- Add and delete documents
- Toast notifications for all events
- Source code displayed at bottom

## Development

```bash
# Install dependencies
npm install

# Run dev server
npm run dev

# Open http://localhost:3000
```

## Build for Production

```bash
# Build demo (outputs to ../docs/demo/)
npm run build

# Preview production build
npm run preview
```

## How It Works

1. **Local Store**: `demo-encrypted-pouch` - your main database
2. **Remote Store**: `demo-encrypted-pouch-synced` - simulates a remote server
3. **Password**: `demo-password` - used for AES-256-GCM encryption
4. **Sync**: Live bidirectional sync between local and "remote"

All data is encrypted before storage. The tables show:
- **In-Memory**: Decrypted documents (what your app works with)
- **Local PouchDB**: Raw encrypted data on disk
- **Remote PouchDB**: Raw encrypted data that would be synced

Try adding documents, deleting them, and watch the sync happen in real-time!
