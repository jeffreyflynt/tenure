import { UAParser } from "ua-parser-js";

const IDE_UA_PATTERNS = [
  /cursor/i,
  /windsurf/i,
  /copilot/i,
  /continue\.dev/i,
  /codeium/i,
] as const;

export type ClientCategory = "ide" | "browser" | "unknown";

export interface ParsedClient {
  isIde: boolean;
  category: ClientCategory;
  raw: string | undefined;
  browser: string | null;
  browserVersion: string | null;
  os: string | null;
  deviceType: string | null;
}

export function parseClient(userAgent: string | undefined): ParsedClient {
  const isIde = isIdeClient(userAgent);

  if (!userAgent) {
    return {
      isIde: false,
      category: "unknown",
      raw: undefined,
      browser: null,
      browserVersion: null,
      os: null,
      deviceType: null,
    };
  }

  const result = new UAParser(userAgent).getResult();

  const category: ClientCategory = isIde
    ? "ide"
    : result.browser.name
      ? "browser"
      : "unknown";

  return {
    isIde,
    category,
    raw: userAgent,
    browser: result.browser.name ?? null,
    browserVersion: result.browser.version ?? null,
    os: result.os.name ?? null,

    deviceType: result.device.type ?? null,
  };
}

function isIdeClient(userAgent: string | undefined): boolean {
  if (!userAgent) return false;
  return IDE_UA_PATTERNS.some((p) => p.test(userAgent));
}
