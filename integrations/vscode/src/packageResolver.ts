import * as vscode from "vscode";
import { createHash } from "node:crypto";
import { basename } from "node:path";

/**
 * Ordered list of manifest resolvers. The upward walk tries each resolver
 * at every directory level before moving to the parent.
 */
const MANIFEST_RESOLVERS: Array<{
  filename: string;
  extract: (content: string) => string | null;
}> = [
  // JavaScript / TypeScript
  {
    filename: "package.json",
    extract: (content) => {
      try {
        const parsed = JSON.parse(content) as { name?: string };
        if (parsed.name && typeof parsed.name === "string") {
          // Strip npm org prefix: @orgname/my-project -> my-project
          return parsed.name.replace(/^@[^/]+\//, "");
        }
        return null;
      } catch {
        return null;
      }
    },
  },

  // Rust
  {
    filename: "Cargo.toml",
    extract: (content) => {
      const match = content.match(/^\s*name\s*=\s*"([^"]+)"/m);
      return match?.[1] ?? null;
    },
  },

  // Go
  {
    filename: "go.mod",
    extract: (content) => {
      // "module github.com/user/repo" -> "repo"
      const match = content.match(/^module\s+(\S+)/m);
      if (!match) return null;
      const parts = match[1].split("/");
      return parts[parts.length - 1] ?? null;
    },
  },

  // Python (modern)
  {
    filename: "pyproject.toml",
    extract: (content) => {
      const match = content.match(/^\s*name\s*=\s*"([^"]+)"/m);
      return match?.[1] ?? null;
    },
  },

  // Python (legacy)
  {
    filename: "setup.py",
    extract: (content) => {
      const match = content.match(/name\s*=\s*["']([^"']+)["']/);
      return match?.[1] ?? null;
    },
  },

  // Java / Kotlin - Maven
  {
    filename: "pom.xml",
    extract: (content) => {
      // Match <artifactId> that is a direct child of <project>, not nested
      const match = content.match(
        /<project[^>]*>[\s\S]*?<artifactId>([^<]+)<\/artifactId>/,
      );
      return match?.[1]?.trim() ?? null;
    },
  },
];

/**
 * Gradle resolution is file-based (settings.gradle or settings.gradle.kts)
 * rather than a fixed filename, so it gets its own handler.
 */
async function tryGradle(dirUri: vscode.Uri): Promise<string | null> {
  for (const filename of ["settings.gradle", "settings.gradle.kts"]) {
    const candidate = vscode.Uri.joinPath(dirUri, filename);
    try {
      const raw = await vscode.workspace.fs.readFile(candidate);
      const content = new TextDecoder().decode(raw);
      const match = content.match(/rootProject\.name\s*=\s*["']([^"']+)["']/);
      if (match?.[1]) return match[1];
    } catch {
      // file missing, keep trying
    }
  }
  return null;
}

/**
 * .NET resolution reads the base filename of the first .sln or .csproj found
 * in the directory, since the file itself IS the identifier.
 */
async function tryDotNet(dirUri: vscode.Uri): Promise<string | null> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(dirUri);
    for (const [name] of entries) {
      if (name.endsWith(".sln") || name.endsWith(".csproj")) {
        return name.replace(/\.(sln|csproj)$/, "");
      }
    }
  } catch {
    // directory unreadable
  }
  return null;
}

export async function resolveNearestPackageName(
  activeFileUri: vscode.Uri | undefined,
  workspaceRootUri: vscode.Uri,
): Promise<string | null> {
  if (!activeFileUri) return null;

  let currentUri = vscode.Uri.joinPath(activeFileUri, "..");

  while (currentUri.path.startsWith(workspaceRootUri.path)) {
    for (const resolver of MANIFEST_RESOLVERS) {
      const candidateUri = vscode.Uri.joinPath(currentUri, resolver.filename);
      try {
        const raw = await vscode.workspace.fs.readFile(candidateUri);
        const content = new TextDecoder().decode(raw);
        const name = resolver.extract(content);
        if (name) return name;
      } catch {
        // file missing at this level, try next resolver
      }
    }

    const gradle = await tryGradle(currentUri);
    if (gradle) return gradle;

    const dotnet = await tryDotNet(currentUri);
    if (dotnet) return dotnet;

    const parentUri = vscode.Uri.joinPath(currentUri, "..");
    if (parentUri.path === currentUri.path) break;
    currentUri = parentUri;
  }

  return null;
}

export function getLocalFallbackSlug(workspaceRoot: string): string {
  const folderName = basename(workspaceRoot);
  const hash = createHash("md5")
    .update(workspaceRoot)
    .digest("hex")
    .slice(0, 8);
  return `${folderName}-${hash}`;
}
