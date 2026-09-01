import { z } from "zod";

export const DEFAULT_UPLOAD_POLICY = Object.freeze({
  maxFiles: 10,
  maxFileBytes: 25 * 1024 * 1024,
  maxImageBytes: 10 * 1024 * 1024,
  maxRequestBytes: 30 * 1024 * 1024,
  maxProjectBytes: 1 * 1024 * 1024 * 1024,
  maxWorkspaceBytes: 5 * 1024 * 1024 * 1024,
  maxDeploymentBytes: 20 * 1024 * 1024 * 1024,
  maxProjectAssets: 100,
  maxProjectRetainedObjects: 1_000,
  maxWorkspaceRetainedObjects: 5_000,
  maxDeploymentRetainedObjects: 20_000,
  maxUploadsPerMinute: 20,
  maxConcurrentUploads: 2,
  maxGlobalConcurrentUploads: 2,
  admissionLeaseMs: 15 * 60 * 1000,
  parseLeaseMs: 30 * 60 * 1000,
  bodyReadTimeoutMs: 2 * 60 * 1000,
} as const);

export type UploadPolicy = Readonly<{
  maxFiles: number;
  maxFileBytes: number;
  maxImageBytes: number;
  maxRequestBytes: number;
  maxProjectBytes: number;
  maxWorkspaceBytes: number;
  maxDeploymentBytes: number;
  maxProjectAssets: number;
  maxProjectRetainedObjects: number;
  maxWorkspaceRetainedObjects: number;
  maxDeploymentRetainedObjects: number;
  maxUploadsPerMinute: number;
  maxConcurrentUploads: number;
  maxGlobalConcurrentUploads: number;
  admissionLeaseMs: number;
  parseLeaseMs: number;
  bodyReadTimeoutMs: number;
}>;

export class UploadPolicyConfigurationError extends Error {
  constructor(readonly variable: string) {
    super(`Invalid upload policy configuration: ${variable}`);
    this.name = "UploadPolicyConfigurationError";
  }
}

const positiveInteger = z.string().regex(/^[1-9][0-9]*$/u);

function readPositiveInteger(variable: string, fallback: number): number {
  const raw = process.env[variable];
  if (raw === undefined) return fallback;
  const parsed = positiveInteger.safeParse(raw);
  if (!parsed.success) throw new UploadPolicyConfigurationError(variable);
  try {
    const value = Number(BigInt(parsed.data));
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("out of range");
    return value;
  } catch {
    throw new UploadPolicyConfigurationError(variable);
  }
}

export function getUploadPolicy(): UploadPolicy {
  const policy = {
    maxFiles: readPositiveInteger("AI_PROJECT_OS_UPLOAD_MAX_FILES", DEFAULT_UPLOAD_POLICY.maxFiles),
    maxFileBytes: readPositiveInteger("AI_PROJECT_OS_UPLOAD_MAX_FILE_BYTES", DEFAULT_UPLOAD_POLICY.maxFileBytes),
    maxImageBytes: readPositiveInteger("AI_PROJECT_OS_UPLOAD_MAX_IMAGE_BYTES", DEFAULT_UPLOAD_POLICY.maxImageBytes),
    maxRequestBytes: readPositiveInteger("AI_PROJECT_OS_UPLOAD_MAX_REQUEST_BYTES", DEFAULT_UPLOAD_POLICY.maxRequestBytes),
    maxProjectBytes: readPositiveInteger("AI_PROJECT_OS_UPLOAD_MAX_PROJECT_BYTES", DEFAULT_UPLOAD_POLICY.maxProjectBytes),
    maxWorkspaceBytes: readPositiveInteger("AI_PROJECT_OS_UPLOAD_MAX_WORKSPACE_BYTES", DEFAULT_UPLOAD_POLICY.maxWorkspaceBytes),
    maxDeploymentBytes: readPositiveInteger("AI_PROJECT_OS_UPLOAD_MAX_DEPLOYMENT_BYTES", DEFAULT_UPLOAD_POLICY.maxDeploymentBytes),
    maxProjectAssets: readPositiveInteger("AI_PROJECT_OS_UPLOAD_MAX_PROJECT_ASSETS", DEFAULT_UPLOAD_POLICY.maxProjectAssets),
    maxProjectRetainedObjects: readPositiveInteger("AI_PROJECT_OS_UPLOAD_MAX_PROJECT_RETAINED_OBJECTS", DEFAULT_UPLOAD_POLICY.maxProjectRetainedObjects),
    maxWorkspaceRetainedObjects: readPositiveInteger("AI_PROJECT_OS_UPLOAD_MAX_WORKSPACE_RETAINED_OBJECTS", DEFAULT_UPLOAD_POLICY.maxWorkspaceRetainedObjects),
    maxDeploymentRetainedObjects: readPositiveInteger("AI_PROJECT_OS_UPLOAD_MAX_DEPLOYMENT_RETAINED_OBJECTS", DEFAULT_UPLOAD_POLICY.maxDeploymentRetainedObjects),
    maxUploadsPerMinute: readPositiveInteger("AI_PROJECT_OS_UPLOAD_MAX_UPLOADS_PER_MINUTE", DEFAULT_UPLOAD_POLICY.maxUploadsPerMinute),
    maxConcurrentUploads: readPositiveInteger("AI_PROJECT_OS_UPLOAD_MAX_CONCURRENT", DEFAULT_UPLOAD_POLICY.maxConcurrentUploads),
    maxGlobalConcurrentUploads: readPositiveInteger("AI_PROJECT_OS_UPLOAD_MAX_GLOBAL_CONCURRENT", DEFAULT_UPLOAD_POLICY.maxGlobalConcurrentUploads),
    admissionLeaseMs: readPositiveInteger("AI_PROJECT_OS_UPLOAD_ADMISSION_LEASE_MS", DEFAULT_UPLOAD_POLICY.admissionLeaseMs),
    parseLeaseMs: readPositiveInteger("AI_PROJECT_OS_UPLOAD_PARSE_LEASE_MS", DEFAULT_UPLOAD_POLICY.parseLeaseMs),
    bodyReadTimeoutMs: readPositiveInteger("AI_PROJECT_OS_UPLOAD_BODY_TIMEOUT_MS", DEFAULT_UPLOAD_POLICY.bodyReadTimeoutMs),
  } as const;

  if (
    policy.maxImageBytes > policy.maxFileBytes
    || policy.maxRequestBytes <= policy.maxFileBytes
    || policy.maxProjectBytes < policy.maxFileBytes
    || policy.maxWorkspaceBytes < policy.maxProjectBytes
    || policy.maxDeploymentBytes < policy.maxWorkspaceBytes
    || policy.maxProjectRetainedObjects < policy.maxProjectAssets
    || policy.maxWorkspaceRetainedObjects < policy.maxProjectRetainedObjects
    || policy.maxDeploymentRetainedObjects < policy.maxWorkspaceRetainedObjects
    || policy.maxGlobalConcurrentUploads < policy.maxConcurrentUploads
    || policy.admissionLeaseMs < policy.bodyReadTimeoutMs
  ) {
    throw new UploadPolicyConfigurationError("AI_PROJECT_OS_UPLOAD_POLICY_RELATION");
  }
  return Object.freeze(policy);
}

export type PublicUploadPolicy = Readonly<{
  maxFiles: number;
  maxFileBytes: number;
  maxImageBytes: number;
  maxRequestBytes: number;
  maxProjectBytes: number;
  maxWorkspaceBytes: number;
  maxDeploymentBytes: number;
  maxProjectAssets: number;
  maxProjectRetainedObjects: number;
  maxWorkspaceRetainedObjects: number;
  maxDeploymentRetainedObjects: number;
  maxUploadsPerMinute: number;
  maxConcurrentUploads: number;
  maxGlobalConcurrentUploads: number;
}>;

export function publicUploadPolicy(policy: UploadPolicy): PublicUploadPolicy {
  return {
    maxFiles: policy.maxFiles,
    maxFileBytes: policy.maxFileBytes,
    maxImageBytes: policy.maxImageBytes,
    maxRequestBytes: policy.maxRequestBytes,
    maxProjectBytes: policy.maxProjectBytes,
    maxWorkspaceBytes: policy.maxWorkspaceBytes,
    maxDeploymentBytes: policy.maxDeploymentBytes,
    maxProjectAssets: policy.maxProjectAssets,
    maxProjectRetainedObjects: policy.maxProjectRetainedObjects,
    maxWorkspaceRetainedObjects: policy.maxWorkspaceRetainedObjects,
    maxDeploymentRetainedObjects: policy.maxDeploymentRetainedObjects,
    maxUploadsPerMinute: policy.maxUploadsPerMinute,
    maxConcurrentUploads: policy.maxConcurrentUploads,
    maxGlobalConcurrentUploads: policy.maxGlobalConcurrentUploads,
  };
}
