/**
 * AES-256-GCM encryption using WebCrypto API
 *
 * This module provides client-side encryption for documents before storing in PouchDB.
 * All encryption happens in the browser/Node.js - data is encrypted before leaving the device.
 *
 * @module encryption
 */

/**
 * WebCrypto API interface for encryption operations.
 * Compatible with both browser (window.crypto) and Node.js (global.crypto).
 */
interface CryptoInterface {
  subtle: {
    digest(algorithm: string, data: BufferSource): Promise<ArrayBuffer>;
    importKey(
      format: string,
      keyData: BufferSource,
      algorithm: string | object,
      extractable: boolean,
      keyUsages: string[],
    ): Promise<CryptoKey>;
    encrypt(
      algorithm: string | object,
      key: CryptoKey,
      data: BufferSource,
    ): Promise<ArrayBuffer>;
    decrypt(
      algorithm: string | object,
      key: CryptoKey,
      data: BufferSource,
    ): Promise<ArrayBuffer>;
    deriveBits(
      algorithm: object,
      baseKey: CryptoKey,
      length: number,
    ): Promise<ArrayBuffer>;
  };
  getRandomValues<T extends ArrayBufferView>(array: T): T;
}

/**
 * Error thrown when decryption fails.
 *
 * This can occur due to:
 * - Wrong password/passphrase
 * - Corrupted encrypted data
 * - Invalid data format
 * - Tampering with encrypted data
 *
 * @example
 * ```typescript
 * try {
 *   const decrypted = await helper.decrypt(encrypted);
 * } catch (error) {
 *   if (error instanceof DecryptionError) {
 *     console.error('Decryption failed:', error.message);
 *   }
 * }
 * ```
 */
class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecryptionError";
    Object.setPrototypeOf(this, DecryptionError.prototype);
  }
}

/**
 * Helper class for encrypting and decrypting data using AES-256-GCM.
 *
 * Features:
 * - AES-256-GCM authenticated encryption
 * - Random IV for each encryption (prevents pattern analysis)
 * - PBKDF2 key derivation (100k iterations by default)
 * - Key caching for performance
 *
 * @example
 * ```typescript
 * const helper = new EncryptionHelper('my-password');
 * const encrypted = await helper.encrypt('secret data');
 * const decrypted = await helper.decrypt(encrypted);
 * ```
 */
class EncryptionHelper {
  private keyPromise: Promise<CryptoKey> | null = null;
  private readonly passphrase: string;
  private readonly crypto: CryptoInterface;
  private readonly passphraseMode: "derive" | "raw";

  /**
   * Creates a new EncryptionHelper instance.
   *
   * @param passphrase - Password or key material for encryption
   * @param crypto - Optional custom crypto implementation (defaults to WebCrypto API)
   * @param passphraseMode - Key derivation mode:
   *   - "derive" (default): Use PBKDF2 with 100k iterations for user passphrases
   *   - "raw": Use SHA-256 only, for pre-derived keys or advanced use cases
   */
  constructor(
    passphrase: string,
    crypto?: CryptoInterface,
    passphraseMode: "derive" | "raw" = "derive",
  ) {
    this.passphrase = passphrase;
    this.crypto =
      crypto ||
      (typeof window !== "undefined" ? window.crypto : (global as any).crypto);
    this.passphraseMode = passphraseMode;
  }

  private async getKey(): Promise<CryptoKey> {
    if (this.keyPromise) {
      return this.keyPromise;
    }

    this.keyPromise = (async () => {
      const enc = new TextEncoder();
      const pwUtf8 = enc.encode(this.passphrase);

      let keyMaterial: ArrayBuffer;

      if (this.passphraseMode === "derive") {
        // User passphrase - use PBKDF2 to derive strong key
        // No salt for deterministic behavior (same passphrase = same key everywhere)
        // Use passphrase itself as "salt" for PBKDF2
        const iterations = 100000; // 100k iterations - good security/performance balance

        // Import passphrase as key material for PBKDF2
        const baseKey = await this.crypto.subtle.importKey(
          "raw",
          pwUtf8,
          "PBKDF2",
          false,
          ["deriveBits"],
        );

        // Derive 256 bits using PBKDF2
        keyMaterial = await this.crypto.subtle.deriveBits(
          {
            name: "PBKDF2",
            salt: pwUtf8, // Use passphrase as salt for determinism
            iterations: iterations,
            hash: "SHA-256",
          },
          baseKey,
          256, // bits
        );
      } else {
        // Raw mode - passphrase is already strong (e.g., random bytes)
        // Just hash to normalize to 256 bits
        keyMaterial = await this.crypto.subtle.digest("SHA-256", pwUtf8);
      }

      // Import the derived/hashed material as AES-GCM key
      return await this.crypto.subtle.importKey(
        "raw",
        keyMaterial,
        "AES-GCM",
        true,
        ["encrypt", "decrypt"],
      );
    })();

    return this.keyPromise;
  }

  private static fromHexString(hexString: string): Uint8Array {
    return new Uint8Array(
      hexString.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16)),
    );
  }

  private static toHexString(bytes: Uint8Array): string {
    return bytes.reduce(
      (str, byte) => str + byte.toString(16).padStart(2, "0"),
      "",
    );
  }

  /**
   * Encrypts a string using AES-256-GCM.
   *
   * Each encryption uses a unique random IV (Initialization Vector),
   * so encrypting the same data twice produces different ciphertext.
   *
   * @param data - Plaintext string to encrypt
   * @returns Encrypted data as hex string in format: "iv|ciphertext"
   *
   * @example
   * ```typescript
   * const helper = new EncryptionHelper('password');
   * const encrypted = await helper.encrypt('secret data');
   * // Returns something like: "a1b2c3d4e5f6g7h8i9j0k1l2|m3n4o5p6q7r8s9t0..."
   * ```
   */
  async encrypt(data: string): Promise<string> {
    const enc = new TextEncoder();
    const key = await this.getKey();
    const encoded = enc.encode(data);
    const iv = this.crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await this.crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: iv,
      },
      key,
      encoded,
    );
    return `${EncryptionHelper.toHexString(iv)}|${EncryptionHelper.toHexString(new Uint8Array(ciphertext))}`;
  }

  /**
   * Decrypts a string that was encrypted with the encrypt() method.
   *
   * @param data - Encrypted data in "iv|ciphertext" hex format
   * @returns Decrypted plaintext string
   * @throws {DecryptionError} If decryption fails (wrong password, corrupted data, etc.)
   *
   * @example
   * ```typescript
   * const helper = new EncryptionHelper('password');
   * try {
   *   const decrypted = await helper.decrypt(encrypted);
   *   console.log('Decrypted:', decrypted);
   * } catch (error) {
   *   if (error instanceof DecryptionError) {
   *     console.error('Wrong password or corrupted data');
   *   }
   * }
   * ```
   */
  async decrypt(data: string): Promise<string> {
    try {
      const key = await this.getKey();
      const [iv, ciphertext] = data
        .split("|")
        .map((s) => EncryptionHelper.fromHexString(s));
      const decrypted = await this.crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: iv,
        },
        key,
        ciphertext as BufferSource,
      );
      return new TextDecoder().decode(decrypted);
    } catch (e) {
      throw new DecryptionError(
        `Could not decrypt: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

export { EncryptionHelper, DecryptionError };
export type { CryptoInterface };
