-- Reserve the candidate-build state and the explicit user reconciliation
-- vocabulary before the candidate tables/constraints are added.
ALTER TYPE "MemoryIndexStatus" ADD VALUE IF NOT EXISTS 'building';
ALTER TYPE "MemoryIndexStatus" ADD VALUE IF NOT EXISTS 'unknown';

CREATE TYPE "MemoryIndexBuildMode" AS ENUM (
    'full',
    'incremental'
);

CREATE TYPE "MemoryIndexReconciliationResolution" AS ENUM (
    'explicit_abandon',
    'published_locally'
);
