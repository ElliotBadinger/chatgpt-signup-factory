export default {
  transform: {},
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  testPathIgnorePatterns: ['/node_modules/', '/chrome-devtools-mcp/', '/.worktrees/'],
  testTimeout: 300000,
};
