import { resolve } from "node:path";
import { homedir } from "node:os";

/**
 * Returns the path for the CSFLE master key.
 * Separate from the credential vault master key to avoid coupling.
 */
export function getBeliefMasterKeyPath(tenureHome?: string): string {
  const base = tenureHome ?? resolve(homedir(), ".tenure");
  return resolve(base, "belief.key");
}
