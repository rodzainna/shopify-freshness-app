-- CreateTable
CREATE TABLE "FulfillmentJob" (
    "shop" TEXT NOT NULL,
    "fulfillmentId" TEXT NOT NULL,
    "products" JSONB NOT NULL,
    "receivedAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextRunAt" DATETIME NOT NULL,
    "claimedAt" DATETIME,
    "lastError" TEXT,

    PRIMARY KEY ("shop", "fulfillmentId")
);

-- CreateIndex
CREATE INDEX "FulfillmentJob_status_nextRunAt_idx" ON "FulfillmentJob"("status", "nextRunAt");
