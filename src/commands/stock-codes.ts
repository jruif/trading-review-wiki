import { invoke } from "@tauri-apps/api/core"
import type { PgConfig } from "@/stores/wiki-store"

export interface SyncResult {
  count: number
  synced_at: string
  skipped: boolean
}

interface RustPgConfig {
  host: string | null
  port: number | null
  user: string | null
  password: string | null
  database: string | null
  use_tls: boolean | null
}

function toRustPgConfig(cfg: PgConfig): RustPgConfig {
  return {
    host: cfg.host || null,
    port: cfg.port,
    user: cfg.user || null,
    password: cfg.password || null,
    database: cfg.database || null,
    use_tls: cfg.useTls,
  }
}

export async function syncStockCodes(
  projectPath: string,
  pgConfig: PgConfig,
  force: boolean = false,
): Promise<SyncResult> {
  return invoke<SyncResult>("sync_stock_codes", {
    projectPath,
    pgConfig: toRustPgConfig(pgConfig),
    force,
  })
}

export async function lookupStockCode(
  projectPath: string,
  name: string,
): Promise<string | null> {
  return invoke<string | null>("lookup_stock_code", { projectPath, name })
}

export async function getStockCodesStatus(
  projectPath: string,
): Promise<SyncResult | null> {
  return invoke<SyncResult | null>("get_stock_codes_status", { projectPath })
}
