const { defineConfig } = require("@vscode/test-cli");

module.exports = defineConfig({
  files: "out/test/**/*.test.js",
  workspaceFolder: "./src/test/fixtures",
  mocha: {
    timeout: 10000,
  },
});
