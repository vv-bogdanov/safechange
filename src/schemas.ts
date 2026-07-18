import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";

export interface SmokeArtifact {
  kind: "smoke";
  message: string;
}

export const smokeArtifactSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "message"],
  properties: {
    kind: { type: "string", const: "smoke" },
    message: { type: "string", minLength: 1 },
  },
} as const;

const ajv = new Ajv({ allErrors: true, strict: true });

export class ArtifactValidationError extends Error {
  constructor(
    public readonly artifactName: string,
    public readonly validationErrors: ErrorObject[],
  ) {
    super(
      `Invalid ${artifactName}: ${validationErrors
        .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
        .join("; ")}`,
    );
    this.name = "ArtifactValidationError";
  }
}

export function compileArtifactValidator<T>(
  artifactName: string,
  schema: object,
): (value: unknown) => T {
  const validate = ajv.compile(schema) as ValidateFunction<T>;

  return (value: unknown): T => {
    if (!validate(value)) {
      throw new ArtifactValidationError(artifactName, validate.errors ?? []);
    }
    return value;
  };
}

export const validateSmokeArtifact = compileArtifactValidator<SmokeArtifact>(
  "smoke artifact",
  smokeArtifactSchema,
);
