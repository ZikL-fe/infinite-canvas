/** PostgreSQL 连接池与 Drizzle ORM 实例入口。 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { env } from "../env.ts";
import * as schema from "./schema.ts";

export const sqlClient = postgres(env.DATABASE_URL);
export const db = drizzle(sqlClient, { schema });
export * from "./schema.ts";
