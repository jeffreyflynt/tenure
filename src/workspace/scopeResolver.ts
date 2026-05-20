import type { WorkspaceStateCache } from "./stateCache.js";

const SYSTEM_PROMPT_PROJECT_RE =
  /(?:^|\s)project[:\s]+['"]?([a-zA-Z0-9_-]+)['"]?/im;

const SYSTEM_PROMPT_FILE_RE =
  /(?:active file|current file)[:\s]+['"]?([^\s'"]+)['"]?/i;

export interface ResolvedScope {
  projectScope: string | null;
  languageScope: string | null;
  source: "extension" | "payload" | "header" | "fallback";
}

export function resolveIdeScope(
  userId: string,
  workspaceState: WorkspaceStateCache,
  headers: Record<string, string | undefined>,
  systemPromptContent?: string,
): ResolvedScope {
  // Priority 1: Extension state cache
  const projectFromExtension = workspaceState.resolveProjectScope(userId);
  if (projectFromExtension) {
    return {
      projectScope: projectFromExtension,
      languageScope: workspaceState.resolveLanguageScope(userId),
      source: "extension",
    };
  }

  // Priority 2: Header overrides
  const headerProject = headers["x-tenure-project"];
  const headerDomain = headers["x-tenure-domain"];
  if (headerProject) {
    const slug = headerProject
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    return {
      projectScope: `project:${slug}`,
      languageScope: headerDomain ? `domain:${headerDomain}` : null,
      source: "header",
    };
  }

  // Priority 3: First-turn payload parsing
  if (systemPromptContent) {
    const projectMatch = systemPromptContent.match(SYSTEM_PROMPT_PROJECT_RE);
    const fileMatch = systemPromptContent.match(SYSTEM_PROMPT_FILE_RE);

    const projectScope = projectMatch
      ? `project:${projectMatch[1].toLowerCase()}`
      : null;

    let languageScope: string | null = null;
    if (fileMatch) {
      const ext = fileMatch[1].split(".").pop()?.toLowerCase();
      languageScope = extToScope(ext) ?? null;
    }

    if (projectScope || languageScope) {
      return { projectScope, languageScope, source: "payload" };
    }
  }

  // Priority 4: Fallback
  return { projectScope: null, languageScope: null, source: "fallback" };
}

function extToScope(ext: string | undefined): string | null {
  if (!ext) return null;
  const map: Record<string, string> = {
    ts: "domain:code/typescript",
    tsx: "domain:code/typescript",
    js: "domain:code/javascript",
    jsx: "domain:code/javascript",
    py: "domain:code/python",
    rs: "domain:code/rust",
    go: "domain:code/go",
    java: "domain:code/java",
    rb: "domain:code/ruby",
    swift: "domain:code/swift",
    kt: "domain:code/kotlin",
    cpp: "domain:code/cpp",
    c: "domain:code/c",
    cs: "domain:code/csharp",
    php: "domain:code/php",
    sh: "domain:code/shell",
  };
  return map[ext] ?? "domain:code";
}
