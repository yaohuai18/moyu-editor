-- CreateIndex
CREATE INDEX "Chapter_projectId_updatedAt_idx" ON "Chapter"("projectId", "updatedAt");

-- CreateIndex
CREATE INDEX "Project_userId_updatedAt_idx" ON "Project"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "Revision_chapterId_createdAt_idx" ON "Revision"("chapterId", "createdAt");
