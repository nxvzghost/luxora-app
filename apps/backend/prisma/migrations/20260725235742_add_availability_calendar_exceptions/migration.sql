-- AlterTable
ALTER TABLE "availability_calendar" ADD COLUMN     "exceptions" JSONB NOT NULL DEFAULT '[]';
