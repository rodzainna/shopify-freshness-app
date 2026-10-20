/*
  Warnings:

  - The primary key for the `FulfillmentDiscrepancy` table will be changed. If it partially fails, the table could be left without primary key constraint.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_FulfillmentDiscrepancy" (
    "shop" TEXT NOT NULL,
    "fulfillmentId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "shortfall" INTEGER,
    "expiredUnits" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("shop", "fulfillmentId", "productId", "reason")
);
INSERT INTO "new_FulfillmentDiscrepancy" ("createdAt", "expiredUnits", "fulfillmentId", "productId", "reason", "shop", "shortfall") SELECT "createdAt", "expiredUnits", "fulfillmentId", "productId", "reason", "shop", "shortfall" FROM "FulfillmentDiscrepancy";
DROP TABLE "FulfillmentDiscrepancy";
ALTER TABLE "new_FulfillmentDiscrepancy" RENAME TO "FulfillmentDiscrepancy";
CREATE INDEX "FulfillmentDiscrepancy_shop_createdAt_idx" ON "FulfillmentDiscrepancy"("shop", "createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
