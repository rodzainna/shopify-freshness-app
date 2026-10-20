-- CreateTable
CREATE TABLE "ProductLock" (
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,

    PRIMARY KEY ("shop", "productId")
);
