-- AlterTable
ALTER TABLE "ContentProject" ADD COLUMN     "voiceRevision" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "TrackedLink" ADD COLUMN     "redirect" BOOLEAN NOT NULL DEFAULT true;
