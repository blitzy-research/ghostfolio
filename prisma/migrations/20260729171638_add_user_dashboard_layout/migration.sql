-- CreateTable
CREATE TABLE "UserDashboardLayout" (
    "layoutData" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "UserDashboardLayout_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "UserDashboardLayout" ADD CONSTRAINT "UserDashboardLayout_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
