export interface Competition {
  id: number
  slug: string
  name: string
  password_salt: string
  password_hash: string
  webhook_url: string
  profile_json: string
}

export interface Participant {
  id: string
  competition_id: number
  token_hash: string
  rsn: string
  normalized_rsn: string
}

export type Bindings = {
  DB: D1Database
  ADMIN_TOKEN?: string
}
