-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AiUsage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "chapterId" TEXT,
    "mode" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputChars" INTEGER NOT NULL,
    "outputChars" INTEGER NOT NULL,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "durationMs" INTEGER,
    "errorCode" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_AiUsage" ("chapterId", "createdAt", "id", "inputChars", "mode", "model", "outputChars", "projectId", "userId") SELECT "chapterId", "createdAt", "id", "inputChars", "mode", "model", "outputChars", "projectId", "userId" FROM "AiUsage";
DROP TABLE "AiUsage";
ALTER TABLE "new_AiUsage" RENAME TO "AiUsage";
CREATE INDEX "AiUsage_userId_createdAt_idx" ON "AiUsage"("userId", "createdAt");
CREATE INDEX "AiUsage_createdAt_idx" ON "AiUsage"("createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
