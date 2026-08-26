/*
  Warnings:

  - A unique constraint covering the columns `[projectId,id]` on the table `ProjectItem` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[projectId,id]` on the table `ProjectScan` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[projectId,id]` on the table `ProjectSource` will be added. If there are existing duplicate values, this will fail.
  - Made the column `sourceId` on table `ProjectItem` required. This step will fail if there are existing NULL values in that column.

*/
-- DropForeignKey
ALTER TABLE "ProjectItem" DROP CONSTRAINT "ProjectItem_sourceId_fkey";

-- DropForeignKey
ALTER TABLE "ProjectItem" DROP CONSTRAINT "ProjectItem_supersedesItemId_fkey";

-- DropForeignKey
ALTER TABLE "ProjectSnapshot" DROP CONSTRAINT "ProjectSnapshot_scanId_fkey";

-- AlterTable
ALTER TABLE "ProjectItem" ALTER COLUMN "sourceId" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "ProjectItem_projectId_id_key" ON "ProjectItem"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectScan_projectId_id_key" ON "ProjectScan"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectSource_projectId_id_key" ON "ProjectSource"("projectId", "id");

-- AddForeignKey
ALTER TABLE "ProjectItem" ADD CONSTRAINT "ProjectItem_projectId_sourceId_fkey" FOREIGN KEY ("projectId", "sourceId") REFERENCES "ProjectSource"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "ProjectItem" ADD CONSTRAINT "ProjectItem_projectId_supersedesItemId_fkey" FOREIGN KEY ("projectId", "supersedesItemId") REFERENCES "ProjectItem"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "ProjectSnapshot" ADD CONSTRAINT "ProjectSnapshot_projectId_scanId_fkey" FOREIGN KEY ("projectId", "scanId") REFERENCES "ProjectScan"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
