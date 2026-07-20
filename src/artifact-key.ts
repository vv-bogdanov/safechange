const STATIC_ARTIFACT_PATHS = {
  evidence: "evidence.json",
  contract: "contract.json",
  eligibility: "eligibility.json",
  decision: "decision.json",
  characterization: "characterization.json",
  characterizationCommands: "characterization-commands.json",
  harness: "harness.json",
  commands: "commands.json",
  implementation: "implementation.json",
  verificationCommands: "verification-commands.json",
  verificationAttempt1: "verification-attempt-1.json",
  repair: "repair.json",
  verificationCommandsRepair: "verification-commands-repair.json",
  verification: "verification.json",
} as const;

export type StaticArtifactKey = keyof typeof STATIC_ARTIFACT_PATHS;
export type PlanArtifactKey = `plan-${1 | 2 | 3 | 4 | 5}`;
export type ArtifactKey = StaticArtifactKey | PlanArtifactKey;

export const ARTIFACT_KEY_PATTERN =
  "^(?:evidence|contract|eligibility|decision|characterization|characterizationCommands|harness|commands|implementation|verificationCommands|verificationAttempt1|repair|verificationCommandsRepair|verification|plan-[1-5])$";

export function isPlanArtifactKey(key: string): key is PlanArtifactKey {
  return /^plan-[1-5]$/.test(key);
}

export function isArtifactKey(key: string): key is ArtifactKey {
  return isPlanArtifactKey(key) || Object.hasOwn(STATIC_ARTIFACT_PATHS, key);
}

export function artifactPath(key: ArtifactKey): string {
  if (isPlanArtifactKey(key)) return `plans/${key}.json`;
  return STATIC_ARTIFACT_PATHS[key];
}

export function planArtifactKey(index: number): PlanArtifactKey {
  const key = `plan-${index}`;
  if (!isPlanArtifactKey(key)) throw new Error(`Invalid planner index: ${index}`);
  return key;
}

export function parsePlanArtifactKey(key: string): PlanArtifactKey {
  if (!isPlanArtifactKey(key)) throw new Error(`Invalid persisted plan key: ${key}`);
  return key;
}
