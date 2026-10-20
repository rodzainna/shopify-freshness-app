-- CreateTable
CREATE TABLE "FulfillmentPlan" (
    "shop" TEXT NOT NULL,
    "fulfillmentId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "plan" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" DATETIME,

    PRIMARY KEY ("shop", "fulfillmentId", "productId")
);

-- CreateTable
CREATE TABLE "FulfillmentDiscrepancy" (
    "shop" TEXT NOT NULL,
    "fulfillmentId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "shortfall" INTEGER,
    "expiredUnits" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("shop", "fulfillmentId", "productId")
);

-- CreateIndex
CREATE INDEX "FulfillmentPlan_shop_productId_appliedAt_idx" ON "FulfillmentPlan"("shop", "productId", "appliedAt");

-- CreateIndex
CREATE INDEX "FulfillmentDiscrepancy_shop_createdAt_idx" ON "FulfillmentDiscrepancy"("shop", "createdAt");
