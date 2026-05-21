const { defineConfig } = require("@vscode/test-cli");

module.exports = defineConfig({
  files: "out/test/**/*.test.js",
  version: "1.121.0",
  workspaceFolder: "./src/test/fixtures",
  mocha: {
    timeout: 10000,
  },
});
