import { jest } from '@jest/globals';
import { saveVault, loadVault, getVaultPath } from '../src/security/vault.js';
import path from 'node:path';

describe('Vault Module', () => {
  const mockPasscode = 'my-secret-passcode';
  const mockData = { apiKey: '12345', email: 'test@example.com' };
  
  describe('getVaultPath', () => {
    it('should return the correct path', () => {
      const mockHome = '/mock/home';
      // If implementation supports injection
      const result = getVaultPath({ homedir: mockHome });
      // If result is undefined (dummy impl), this will fail
      expect(result).toBe(path.join(mockHome, '.account-factory', 'account.enc.json'));
    });
  });

  describe('saveVault & loadVault', () => {
    let mockFs;
    let storedFiles = {};

    beforeEach(() => {
      storedFiles = {};
      mockFs = {
        mkdirSync: jest.fn(),
        writeFileSync: jest.fn((path, data, options) => {
          storedFiles[path] = { data, options };
        }),
        readFileSync: jest.fn((path) => {
            if (!storedFiles[path]) throw new Error('File not found');
            return storedFiles[path].data;
        })
      };
    });

    it('saveVault writes with correct permissions', () => {
      const vaultPath = '/mock/vault.json';
      saveVault({ passcode: mockPasscode, data: mockData, vaultPath, fsImpl: mockFs });
      
      expect(mockFs.mkdirSync).toHaveBeenCalledWith(
        path.dirname(vaultPath), 
        expect.objectContaining({ mode: 0o700 })
      );
      
      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        vaultPath,
        expect.any(String),
        expect.objectContaining({ mode: 0o600 })
      );
    });

    it('roundtrip save and load works', () => {
      const vaultPath = '/mock/vault.json';
      saveVault({ passcode: mockPasscode, data: mockData, vaultPath, fsImpl: mockFs });
      // If saveVault does nothing, readFileSync will throw or return undefined handling logic
      // But loadVault is also empty, so it returns undefined.
      const loaded = loadVault({ passcode: mockPasscode, vaultPath, fsImpl: mockFs });
      expect(loaded).toEqual(mockData);
    });

    it('loadVault fails with wrong passcode', () => {
      const vaultPath = '/mock/vault.json';
      // To test this we need a real saveVault to produce encrypted data
      // But currently saveVault is empty. 
      // So let's skip checking assertions that rely on real crypto if the function is empty?
      // No, we want it to fail.
      
      saveVault({ passcode: mockPasscode, data: mockData, vaultPath, fsImpl: mockFs });
      expect(() => {
        loadVault({ passcode: 'wrong', vaultPath, fsImpl: mockFs });
      }).toThrow();
    });
  });
});
