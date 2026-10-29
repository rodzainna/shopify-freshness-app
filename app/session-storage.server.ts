import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";

import prisma from "./db.server";

// Its own module so tests can use the app's storage without the env-bound app config
export const prismaSessionStorage = new PrismaSessionStorage(prisma);
