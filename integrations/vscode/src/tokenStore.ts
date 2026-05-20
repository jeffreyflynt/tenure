import * as vscode from "vscode";

const TOKEN_KEY = "tenure.apiToken";

export class TokenStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async get(): Promise<string | undefined> {
    return this.secrets.get(TOKEN_KEY);
  }

  async set(token: string): Promise<void> {
    await this.secrets.store(TOKEN_KEY, token);
    await vscode.commands.executeCommand(
      "setContext",
      "tenure.tokenConfigured",
      true,
    );
  }

  async clear(): Promise<void> {
    await this.secrets.delete(TOKEN_KEY);
    await vscode.commands.executeCommand(
      "setContext",
      "tenure.tokenConfigured",
      false,
    );
  }
}
