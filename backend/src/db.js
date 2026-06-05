import { PrismaClient } from "@prisma/client";

// Singleton de PrismaClient para reutilizar el pool de conexiones.
export const prisma = new PrismaClient();
