/**
 * Tests for EncryptionHelper
 */

import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import { EncryptionHelper, DecryptionError } from "../encryption.js";

describe("EncryptionHelper", () => {
  let helper: EncryptionHelper;

  beforeEach(() => {
    helper = new EncryptionHelper("test-password");
  });

  describe("Encryption and Decryption", () => {
    test("should encrypt and decrypt a simple string", async () => {
      const plaintext = "Hello, World!";
      const encrypted = await helper.encrypt(plaintext);
      const decrypted = await helper.decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    test("should encrypt and decrypt JSON data", async () => {
      const data = { name: "Alice", age: 30, active: true };
      const plaintext = JSON.stringify(data);
      const encrypted = await helper.encrypt(plaintext);
      const decrypted = await helper.decrypt(encrypted);

      expect(JSON.parse(decrypted)).toEqual(data);
    });

    test("should produce different ciphertext for same plaintext", async () => {
      const plaintext = "Hello, World!";
      const encrypted1 = await helper.encrypt(plaintext);
      const encrypted2 = await helper.encrypt(plaintext);

      // Different IVs should produce different ciphertext
      expect(encrypted1).not.toBe(encrypted2);

      // But both should decrypt to the same plaintext
      expect(await helper.decrypt(encrypted1)).toBe(plaintext);
      expect(await helper.decrypt(encrypted2)).toBe(plaintext);
    });

    test("should handle concurrent encryption operations", async () => {
      const plaintexts = Array.from({ length: 10 }, (_, i) => `test-${i}`);

      const encrypted = await Promise.all(
        plaintexts.map((pt) => helper.encrypt(pt)),
      );

      const decrypted = await Promise.all(
        encrypted.map((ct) => helper.decrypt(ct)),
      );

      expect(decrypted).toEqual(plaintexts);
    });
  });

  describe("Password Handling", () => {
    test("should fail with wrong password", async () => {
      const helper1 = new EncryptionHelper("password1");
      const helper2 = new EncryptionHelper("password2");

      const encrypted = await helper1.encrypt("secret data");

      await expect(helper2.decrypt(encrypted)).rejects.toThrow(DecryptionError);
    });
  });

  describe("Error Handling", () => {
    test("should throw DecryptionError with invalid input", async () => {
      await expect(helper.decrypt("invalid-format")).rejects.toThrow(
        DecryptionError,
      );
      await expect(helper.decrypt("")).rejects.toThrow(DecryptionError);
      await expect(helper.decrypt("invalid|data")).rejects.toThrow(
        DecryptionError,
      );
    });
  });

  describe("DecryptionError", () => {
    test("should be instanceof Error", async () => {
      const helper1 = new EncryptionHelper("password1");
      const helper2 = new EncryptionHelper("password2");

      const encrypted = await helper1.encrypt("test");

      try {
        await helper2.decrypt(encrypted);
        fail("Should have thrown DecryptionError");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect(error).toBeInstanceOf(DecryptionError);
        expect((error as Error).name).toBe("DecryptionError");
      }
    });

    test("should have descriptive error message", async () => {
      try {
        await helper.decrypt("invalid|data");
        fail("Should have thrown DecryptionError");
      } catch (error) {
        expect((error as Error).message).toContain("Could not decrypt");
      }
    });
  });
});
