export default {
  transform: {},
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  testPathIgnorePatterns: ['/node_modules/', '/chrome-devtools-mcp/'],
  testTimeout: 300000,
};
