// Import Tabler styles and JS
import '@tabler/core/dist/css/tabler.min.css';
import '@tabler/core/dist/js/tabler.min.js';

// Import Prism for syntax highlighting
import 'prismjs/themes/prism-tomorrow.css';
import Prism from 'prismjs';
import 'prismjs/components/prism-typescript';

import PouchDBModule from 'pouchdb-browser';
const PouchDB = (PouchDBModule as any).default || PouchDBModule;

// Import from local source for development
import { EncryptedPouch } from '../src/index.js';
import type { Doc } from '../src/index.js';

// In-memory state
const memoryDocs = new Map<string, Doc>();
let dynamicFieldCounter = 0;

// Generate UUID using WebCrypto
function generateUUID() {
  return crypto.randomUUID();
}

// Toast notification helper
function showToast(message: string, type: 'success' | 'danger' | 'info' | 'warning' = 'info') {
  const container = document.getElementById('toast-container')!;
  const toast = document.createElement('div');
  toast.className = `toast show align-items-center text-bg-${type} border-0`;
  toast.setAttribute('role', 'alert');
  toast.innerHTML = `
    <div class="d-flex">
      <div class="toast-body">${message}</div>
      <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
    </div>
  `;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// Render in-memory table with dynamic columns
function renderMemoryTable() {
  const tbody = document.getElementById('memory-table-body')!;
  const thead = tbody.closest('table')!.querySelector('thead tr')!;

  if (memoryDocs.size === 0) {
    thead.innerHTML = '<th>ID</th><th>Rev</th><th>Data</th><th class="w-1"></th>';
    tbody.innerHTML = '<tr><td colspan="4" class="text-muted">No documents yet...</td></tr>';
    return;
  }

  // Collect all unique keys from all documents (excluding _id and _rev)
  const allKeys = new Set<string>();
  memoryDocs.forEach(doc => {
    Object.keys(doc).forEach(key => {
      if (!key.startsWith('_')) {
        allKeys.add(key);
      }
    });
  });

  const keys = Array.from(allKeys).sort();

  // Render table header
  thead.innerHTML = `
    <th>ID</th>
    <th>Rev</th>
    ${keys.map(key => `<th>${key}</th>`).join('')}
    <th class="w-1"></th>
  `;

  // Render table body
  tbody.innerHTML = Array.from(memoryDocs.values())
    .map(doc => `
      <tr>
        <td><code>${doc._id}</code></td>
        <td><code class="text-muted">${doc._rev.substring(0, 8)}...</code></td>
        ${keys.map(key => `<td>${doc[key] !== undefined ? doc[key] : '-'}</td>`).join('')}
        <td>
          <a href="#" class="delete-doc-btn" data-id="${doc._id}">Delete</a>
        </td>
      </tr>
    `)
    .join('');

  // Add event listeners to delete buttons
  tbody.querySelectorAll('.delete-doc-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const id = (btn as HTMLElement).dataset.id!;
      await localStore.delete('demo', id);
      showToast(`Deleted document: ${id}`, 'success');
    });
  });
}

// Render raw PouchDB table
async function renderRawTable(db: any, tbodyId: string, storeName: string) {
  const tbody = document.getElementById(tbodyId)!;

  try {
    const result = await db.allDocs({ include_docs: true });

    if (result.rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="text-muted">No documents yet...</td></tr>';
      return;
    }

    tbody.innerHTML = result.rows
      .filter((row: any) => !row.id.startsWith('_design/'))
      .map((row: any) => {
        const doc = row.doc;
        const encryptedPreview = doc.d ? doc.d.substring(0, 50) + '...' : 'N/A';
        return `
          <tr>
            <td><code class="text-muted">${doc._id}</code></td>
            <td><code class="text-muted">${doc._rev}</code></td>
            <td><code class="text-muted">${encryptedPreview}</code></td>
            <td>
              <a href="#" class="delete-raw-btn" data-db="${storeName}" data-id="${doc._id}" data-rev="${doc._rev}">Delete</a>
            </td>
          </tr>
        `;
      })
      .join('');

    // Add event listeners to delete buttons
    tbody.querySelectorAll('.delete-raw-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        const id = (btn as HTMLElement).dataset.id!;
        const rev = (btn as HTMLElement).dataset.rev!;
        const dbName = (btn as HTMLElement).dataset.db!;
        const targetDb = dbName === 'local' ? localDb : remoteDb;

        try {
          await targetDb.remove(id, rev);
          showToast(`Deleted raw document: ${id}`, 'success');
          renderRawTable(targetDb, tbodyId, storeName);
        } catch (error) {
          showToast(`Error deleting: ${error}`, 'danger');
        }
      });
    });
  } catch (error) {
    tbody.innerHTML = `<tr><td colspan="4" class="text-danger">Error: ${error}</td></tr>`;
  }
}

// Create databases
const localDb = new PouchDB('demo-encrypted-pouch');
const remoteDb = new PouchDB('demo-encrypted-pouch-synced');

// Create encrypted stores
const localStore = new EncryptedPouch(localDb, 'demo-password', {
  onChange: (changes) => {
    changes.forEach(({ table, docs }) => {
      docs.forEach(doc => memoryDocs.set(doc._id, doc));
      showToast(`${docs.length} document(s) changed in ${table}`, 'info');
    });
    renderMemoryTable();
    renderRawTable(localDb, 'local-db-table-body', 'local');
  },

  onDelete: (deletions) => {
    deletions.forEach(({ table, docs }) => {
      docs.forEach(doc => memoryDocs.delete(doc._id));
      showToast(`${docs.length} document(s) deleted from ${table}`, 'warning');
    });
    renderMemoryTable();
    renderRawTable(localDb, 'local-db-table-body', 'local');
  },

  onConflict: (conflicts) => {
    showToast(`${conflicts.length} conflict(s) detected!`, 'warning');
    console.log('Conflicts:', conflicts);
  },

  onSync: (info) => {
    showToast(`Sync ${info.direction}: ${info.change.docs_written || info.change.docs_read || 0} docs`, 'success');
    renderRawTable(remoteDb, 'remote-db-table-body', 'remote');
  },

  onError: (errors) => {
    errors.forEach(err => {
      showToast(`Decryption error: ${err.docId}`, 'danger');
      console.error('Decryption error:', err);
    });
  }
});

// Initialize and setup sync
async function init() {
  try {
    // Initialize form
    resetForm();

    // Load existing documents
    await localStore.loadAll();
    showToast('Local store loaded', 'success');

    // Connect to remote for sync
    await localStore.connectRemote({
      url: remoteDb as any,
      live: true,
      retry: true
    });
    showToast('Sync connected', 'success');

    // Initial render
    renderMemoryTable();
    renderRawTable(localDb, 'local-db-table-body', 'local');
    renderRawTable(remoteDb, 'remote-db-table-body', 'remote');

    // Refresh remote table periodically (to show sync changes)
    setInterval(() => renderRawTable(remoteDb, 'remote-db-table-body', 'remote'), 2000);

  } catch (error) {
    showToast(`Initialization error: ${error}`, 'danger');
    console.error('Init error:', error);
  }
}

// Initialize form with UUID and random number
function resetForm() {
  const idField = document.getElementById('field-_id') as HTMLInputElement;
  const randomField = document.getElementById('field-random') as HTMLInputElement;

  idField.value = generateUUID();
  randomField.value = String(Math.floor(Math.random() * 1000) + 1);

  // Clear dynamic fields
  const dynamicFieldsContainer = document.getElementById('dynamic-fields')!;
  dynamicFieldsContainer.innerHTML = '';
  dynamicFieldCounter = 0;
}

// Add dynamic field
document.getElementById('add-field-btn')!.addEventListener('click', () => {
  const container = document.getElementById('dynamic-fields')!;
  const fieldId = dynamicFieldCounter++;

  const fieldHtml = `
    <div class="row mb-3" id="dynamic-field-${fieldId}">
      <div class="col-md-5">
        <label class="form-label">Field Name</label>
        <input type="text" class="form-control field-key" placeholder="key" />
      </div>
      <div class="col-md-5">
        <label class="form-label">Field Value</label>
        <input type="text" class="form-control field-value" placeholder="value" />
      </div>
      <div class="col-md-2">
        <label class="form-label">&nbsp;</label>
        <button type="button" class="btn btn-outline-danger w-100 remove-field-btn" data-field-id="${fieldId}">
          Remove
        </button>
      </div>
    </div>
  `;

  container.insertAdjacentHTML('beforeend', fieldHtml);

  // Add remove handler
  const removeBtn = container.querySelector(`[data-field-id="${fieldId}"]`) as HTMLElement;
  removeBtn.addEventListener('click', () => {
    document.getElementById(`dynamic-field-${fieldId}`)?.remove();
  });
});

// Handle form submission
document.getElementById('add-doc-form')!.addEventListener('submit', async (e) => {
  e.preventDefault();

  const form = e.target as HTMLFormElement;
  const formData = new FormData(form);

  // Build document object
  const doc: any = {
    _id: formData.get('_id') as string,
    random: parseInt(formData.get('random') as string, 10)
  };

  // Add dynamic fields
  const dynamicFields = document.getElementById('dynamic-fields')!;
  dynamicFields.querySelectorAll('.row').forEach(row => {
    const keyInput = row.querySelector('.field-key') as HTMLInputElement;
    const valueInput = row.querySelector('.field-value') as HTMLInputElement;

    if (keyInput && valueInput && keyInput.value.trim()) {
      // Try to parse as number, otherwise keep as string
      const value = valueInput.value;
      doc[keyInput.value.trim()] = isNaN(Number(value)) ? value : Number(value);
    }
  });

  try {
    await localStore.put('demo', doc);
    showToast(`Created document: ${doc._id}`, 'success');
    resetForm();
  } catch (error) {
    showToast(`Error creating document: ${error}`, 'danger');
  }
});

// Disconnect remote
document.getElementById('disconnect-remote-btn')!.addEventListener('click', () => {
  localStore.disconnectRemote();
  showToast('Disconnected from remote sync', 'warning');
});

// Delete all local
document.getElementById('delete-all-local-btn')!.addEventListener('click', async () => {
  if (!confirm('Delete all local documents? This will NOT sync deletions.')) return;

  await localStore.deleteAllLocal();
  showToast('All local documents deleted', 'warning');
  renderRawTable(localDb, 'local-db-table-body', 'local');
});

// Delete all remote
document.getElementById('delete-all-remote-btn')!.addEventListener('click', async () => {
  if (!confirm('Delete all documents and sync to remote? This WILL delete from remote too!')) return;

  try {
    await localStore.deleteAllAndSync();
    showToast('All documents deleted and synced', 'warning');
    renderRawTable(remoteDb, 'remote-db-table-body', 'remote');
  } catch (error) {
    showToast(`Error: ${error}`, 'danger');
  }
});

// Load and display source code
async function loadSourceCode() {
  try {
    const response = await fetch('/main.ts');
    const source = await response.text();
    const codeElement = document.getElementById('source-code')!;
    codeElement.textContent = source;
    codeElement.className = 'language-typescript';
    Prism.highlightElement(codeElement);
  } catch (error) {
    document.getElementById('source-code')!.textContent = 'Error loading source code';
  }
}

// Start the app
init();
loadSourceCode();
