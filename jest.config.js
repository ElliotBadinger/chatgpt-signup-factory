export default {
  transform: {},
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  modulePathIgnorePatterns: ['<rootDir>/docs/recovery/snapshots/'],
  testPathIgnorePatterns: ['/node_modules/', '/chrome-devtools-mcp/', '/.worktrees/'],
  testTimeout: 300000,
};
