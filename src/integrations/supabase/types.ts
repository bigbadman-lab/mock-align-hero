export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      mcp_creations: {
        Row: {
          child_mint: string
          created_at: string
          creator_wallet: string
          description: string
          display_name: string
          fee_config_evidence_id: string | null
          id: string
          network: string
          quote_mint: string
          slug: string
          template_id: string
          template_version: number
          ticker: string
          updated_at: string
          verified_at: string
          verified_slot: number
          verified_tx_signature: string
        }
        Insert: {
          child_mint: string
          created_at?: string
          creator_wallet: string
          description?: string
          display_name: string
          fee_config_evidence_id?: string | null
          id?: string
          network: string
          quote_mint: string
          slug: string
          template_id: string
          template_version: number
          ticker: string
          updated_at?: string
          verified_at: string
          verified_slot: number
          verified_tx_signature: string
        }
        Update: {
          child_mint?: string
          created_at?: string
          creator_wallet?: string
          description?: string
          display_name?: string
          fee_config_evidence_id?: string | null
          id?: string
          network?: string
          quote_mint?: string
          slug?: string
          template_id?: string
          template_version?: number
          ticker?: string
          updated_at?: string
          verified_at?: string
          verified_slot?: number
          verified_tx_signature?: string
        }
        Relationships: []
      }
      mcp_product_access_keys: {
        Row: {
          actor_kind: string
          actor_ref: string
          created_at: string
          creation_id: string
          display_prefix: string
          expires_at: string | null
          idempotency_key: string
          key_id: string
          label: string | null
          last_used_at: string | null
          revoked_at: string | null
          rotated_from: string | null
          scope: string
          status: string
          verifier: string
        }
        Insert: {
          actor_kind: string
          actor_ref: string
          created_at?: string
          creation_id: string
          display_prefix: string
          expires_at?: string | null
          idempotency_key: string
          key_id?: string
          label?: string | null
          last_used_at?: string | null
          revoked_at?: string | null
          rotated_from?: string | null
          scope?: string
          status?: string
          verifier: string
        }
        Update: {
          actor_kind?: string
          actor_ref?: string
          created_at?: string
          creation_id?: string
          display_prefix?: string
          expires_at?: string | null
          idempotency_key?: string
          key_id?: string
          label?: string | null
          last_used_at?: string | null
          revoked_at?: string | null
          rotated_from?: string | null
          scope?: string
          status?: string
          verifier?: string
        }
        Relationships: [
          {
            foreignKeyName: "mcp_product_access_keys_creation_id_fkey"
            columns: ["creation_id"]
            isOneToOne: false
            referencedRelation: "mcp_product_configs"
            referencedColumns: ["creation_id"]
          },
          {
            foreignKeyName: "mcp_product_access_keys_rotated_from_fkey"
            columns: ["rotated_from"]
            isOneToOne: false
            referencedRelation: "mcp_product_access_keys"
            referencedColumns: ["key_id"]
          },
        ]
      }
      mcp_product_configs: {
        Row: {
          access_mode: string
          activated_at: string | null
          config_version: number
          created_at: string
          creation_id: string
          lifecycle_state: string
          template_id: string
          template_version: string
          tool_config: Json
          updated_at: string
        }
        Insert: {
          access_mode?: string
          activated_at?: string | null
          config_version?: number
          created_at?: string
          creation_id: string
          lifecycle_state?: string
          template_id: string
          template_version: string
          tool_config?: Json
          updated_at?: string
        }
        Update: {
          access_mode?: string
          activated_at?: string | null
          config_version?: number
          created_at?: string
          creation_id?: string
          lifecycle_state?: string
          template_id?: string
          template_version?: string
          tool_config?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "mcp_product_configs_creation_id_template_id_fkey"
            columns: ["creation_id", "template_id"]
            isOneToOne: false
            referencedRelation: "mcp_creations"
            referencedColumns: ["id", "template_id"]
          },
        ]
      }
      mcp_product_key_events: {
        Row: {
          actor_kind: string
          actor_ref: string
          creation_id: string
          event_type: string
          id: string
          key_id: string
          occurred_at: string
          reason: string | null
        }
        Insert: {
          actor_kind: string
          actor_ref: string
          creation_id: string
          event_type: string
          id?: string
          key_id: string
          occurred_at?: string
          reason?: string | null
        }
        Update: {
          actor_kind?: string
          actor_ref?: string
          creation_id?: string
          event_type?: string
          id?: string
          key_id?: string
          occurred_at?: string
          reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "mcp_product_key_events_key_id_fkey"
            columns: ["key_id"]
            isOneToOne: false
            referencedRelation: "mcp_product_access_keys"
            referencedColumns: ["key_id"]
          },
        ]
      }
      mcpx_ai_audit: {
        Row: {
          action: string
          actor_ref: string
          at: string
          id: number
          integration_id: string
          revision: number
        }
        Insert: {
          action: string
          actor_ref: string
          at?: string
          id?: never
          integration_id: string
          revision: number
        }
        Update: {
          action?: string
          actor_ref?: string
          at?: string
          id?: never
          integration_id?: string
          revision?: number
        }
        Relationships: [
          {
            foreignKeyName: "mcpx_ai_audit_integration_id_fkey"
            columns: ["integration_id"]
            isOneToOne: false
            referencedRelation: "mcpx_ai_integrations"
            referencedColumns: ["id"]
          },
        ]
      }
      mcpx_ai_credentials: {
        Row: {
          alg: string
          ciphertext: string | null
          created_at: string
          id: string
          idempotency_key: string
          integration_id: string
          iv: string | null
          kek_version: string
          key_hint: string
          retired_at: string | null
          status: string
          version: number
        }
        Insert: {
          alg: string
          ciphertext?: string | null
          created_at?: string
          id?: string
          idempotency_key: string
          integration_id: string
          iv?: string | null
          kek_version: string
          key_hint: string
          retired_at?: string | null
          status?: string
          version: number
        }
        Update: {
          alg?: string
          ciphertext?: string | null
          created_at?: string
          id?: string
          idempotency_key?: string
          integration_id?: string
          iv?: string | null
          kek_version?: string
          key_hint?: string
          retired_at?: string | null
          status?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "mcpx_ai_credentials_integration_id_fkey"
            columns: ["integration_id"]
            isOneToOne: false
            referencedRelation: "mcpx_ai_integrations"
            referencedColumns: ["id"]
          },
        ]
      }
      mcpx_ai_integrations: {
        Row: {
          created_at: string
          creation_id: string
          creator_wallet: string
          enabled: boolean
          health: string
          health_checked_at: string | null
          health_credential_version: number | null
          id: string
          max_concurrency: number
          max_input_tokens: number
          max_output_tokens: number
          max_per_day: number
          max_per_minute: number
          model: string
          provider: string
          revision: number
          revoked_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          creation_id: string
          creator_wallet: string
          enabled?: boolean
          health?: string
          health_checked_at?: string | null
          health_credential_version?: number | null
          id?: string
          max_concurrency?: number
          max_input_tokens?: number
          max_output_tokens?: number
          max_per_day?: number
          max_per_minute?: number
          model: string
          provider: string
          revision?: number
          revoked_at?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          creation_id?: string
          creator_wallet?: string
          enabled?: boolean
          health?: string
          health_checked_at?: string | null
          health_credential_version?: number | null
          id?: string
          max_concurrency?: number
          max_input_tokens?: number
          max_output_tokens?: number
          max_per_day?: number
          max_per_minute?: number
          model?: string
          provider?: string
          revision?: number
          revoked_at?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "mcpx_ai_integrations_creation_id_fkey"
            columns: ["creation_id"]
            isOneToOne: true
            referencedRelation: "mcp_creations"
            referencedColumns: ["id"]
          },
        ]
      }
      mcpx_ai_usage: {
        Row: {
          created_at: string
          credential_id: string
          est_cost_micros: number | null
          id: string
          integration_id: string
          lease_until: string
          model: string
          request_ref: string
          reserved_input: number
          reserved_output: number
          settled_at: string | null
          status: string
          used_input: number | null
          used_output: number | null
        }
        Insert: {
          created_at?: string
          credential_id: string
          est_cost_micros?: number | null
          id?: string
          integration_id: string
          lease_until: string
          model: string
          request_ref: string
          reserved_input: number
          reserved_output: number
          settled_at?: string | null
          status?: string
          used_input?: number | null
          used_output?: number | null
        }
        Update: {
          created_at?: string
          credential_id?: string
          est_cost_micros?: number | null
          id?: string
          integration_id?: string
          lease_until?: string
          model?: string
          request_ref?: string
          reserved_input?: number
          reserved_output?: number
          settled_at?: string | null
          status?: string
          used_input?: number | null
          used_output?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "mcpx_ai_usage_credential_id_fkey"
            columns: ["credential_id"]
            isOneToOne: false
            referencedRelation: "mcpx_ai_credentials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mcpx_ai_usage_integration_id_fkey"
            columns: ["integration_id"]
            isOneToOne: false
            referencedRelation: "mcpx_ai_integrations"
            referencedColumns: ["id"]
          },
        ]
      }
      mcpx_auth_challenges: {
        Row: {
          consumed_at: string | null
          created_at: string
          domain: string
          expires_at: string
          message: string
          nonce_hash: string
          wallet: string
        }
        Insert: {
          consumed_at?: string | null
          created_at?: string
          domain: string
          expires_at: string
          message: string
          nonce_hash: string
          wallet: string
        }
        Update: {
          consumed_at?: string | null
          created_at?: string
          domain?: string
          expires_at?: string
          message?: string
          nonce_hash?: string
          wallet?: string
        }
        Relationships: []
      }
      mcpx_creator_sessions: {
        Row: {
          created_at: string
          expires_at: string
          network: string
          revoked_at: string | null
          token_hash: string
          wallet: string
        }
        Insert: {
          created_at?: string
          expires_at: string
          network: string
          revoked_at?: string | null
          token_hash: string
          wallet: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          network?: string
          revoked_at?: string | null
          token_hash?: string
          wallet?: string
        }
        Relationships: []
      }
      mcpx_free_test_counts: {
        Row: {
          bucket: string
          day: string
          hits: number
        }
        Insert: {
          bucket: string
          day: string
          hits?: number
        }
        Update: {
          bucket?: string
          day?: string
          hits?: number
        }
        Relationships: []
      }
      mcpx_launch_artifacts: {
        Row: {
          bytes: number
          content_type: string
          created_at: string
          creator_wallet: string
          draft_id: string
          draft_revision: number
          height: number | null
          id: string
          kind: string
          object_path: string
          public_url: string
          sha256: string
          width: number | null
        }
        Insert: {
          bytes: number
          content_type: string
          created_at?: string
          creator_wallet: string
          draft_id: string
          draft_revision: number
          height?: number | null
          id?: string
          kind: string
          object_path: string
          public_url: string
          sha256: string
          width?: number | null
        }
        Update: {
          bytes?: number
          content_type?: string
          created_at?: string
          creator_wallet?: string
          draft_id?: string
          draft_revision?: number
          height?: number | null
          id?: string
          kind?: string
          object_path?: string
          public_url?: string
          sha256?: string
          width?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "mcpx_launch_artifacts_draft_id_fkey"
            columns: ["draft_id"]
            isOneToOne: false
            referencedRelation: "mcpx_launch_drafts"
            referencedColumns: ["id"]
          },
        ]
      }
      mcpx_launch_attempts: {
        Row: {
          artwork_sha256: string | null
          blockhash: string | null
          blockhash_expires_at: string | null
          config_versions: Json
          created_at: string
          creator_wallet: string
          draft_id: string
          draft_revision: number
          evidence: Json | null
          id: string
          idempotency_key: string
          metadata_sha256: string | null
          mint_pubkey: string | null
          signature: string | null
          state: string
          updated_at: string
        }
        Insert: {
          artwork_sha256?: string | null
          blockhash?: string | null
          blockhash_expires_at?: string | null
          config_versions?: Json
          created_at?: string
          creator_wallet: string
          draft_id: string
          draft_revision: number
          evidence?: Json | null
          id?: string
          idempotency_key: string
          metadata_sha256?: string | null
          mint_pubkey?: string | null
          signature?: string | null
          state?: string
          updated_at?: string
        }
        Update: {
          artwork_sha256?: string | null
          blockhash?: string | null
          blockhash_expires_at?: string | null
          config_versions?: Json
          created_at?: string
          creator_wallet?: string
          draft_id?: string
          draft_revision?: number
          evidence?: Json | null
          id?: string
          idempotency_key?: string
          metadata_sha256?: string | null
          mint_pubkey?: string | null
          signature?: string | null
          state?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "mcpx_launch_attempts_draft_id_fkey"
            columns: ["draft_id"]
            isOneToOne: false
            referencedRelation: "mcpx_launch_drafts"
            referencedColumns: ["id"]
          },
        ]
      }
      mcpx_launch_drafts: {
        Row: {
          abandoned_at: string | null
          artwork_id: string | null
          buy_preference: Json | null
          chain_status: string
          create_key: string
          created_at: string
          creator_wallet: string
          description: string
          id: string
          link: string | null
          metadata_id: string | null
          product_name: string
          revision: number
          settings: Json
          status: string
          symbol: string
          template_id: string
          template_version: number
          token_name: string
          tool_description: string
          updated_at: string
        }
        Insert: {
          abandoned_at?: string | null
          artwork_id?: string | null
          buy_preference?: Json | null
          chain_status?: string
          create_key: string
          created_at?: string
          creator_wallet: string
          description: string
          id?: string
          link?: string | null
          metadata_id?: string | null
          product_name: string
          revision?: number
          settings?: Json
          status?: string
          symbol: string
          template_id: string
          template_version?: number
          token_name: string
          tool_description?: string
          updated_at?: string
        }
        Update: {
          abandoned_at?: string | null
          artwork_id?: string | null
          buy_preference?: Json | null
          chain_status?: string
          create_key?: string
          created_at?: string
          creator_wallet?: string
          description?: string
          id?: string
          link?: string | null
          metadata_id?: string | null
          product_name?: string
          revision?: number
          settings?: Json
          status?: string
          symbol?: string
          template_id?: string
          template_version?: number
          token_name?: string
          tool_description?: string
          updated_at?: string
        }
        Relationships: []
      }
      mcpx_rate_limits: {
        Row: {
          bucket: string
          hits: number
          window_start: string
        }
        Insert: {
          bucket: string
          hits?: number
          window_start: string
        }
        Update: {
          bucket?: string
          hits?: number
          window_start?: string
        }
        Relationships: []
      }
      mcpx_rw_allocations: {
        Row: {
          buyback: number
          carried_in: number
          created_at: string
          epoch_start: string
          event_key: string
          holder_sol: number
          operations: number
          receipt_amount: number
          residual_out: number
          seq: number
        }
        Insert: {
          buyback: number
          carried_in: number
          created_at?: string
          epoch_start: string
          event_key: string
          holder_sol: number
          operations: number
          receipt_amount: number
          residual_out: number
          seq?: number
        }
        Update: {
          buyback?: number
          carried_in?: number
          created_at?: string
          epoch_start?: string
          event_key?: string
          holder_sol?: number
          operations?: number
          receipt_amount?: number
          residual_out?: number
          seq?: number
        }
        Relationships: [
          {
            foreignKeyName: "mcpx_rw_allocations_event_key_fkey"
            columns: ["event_key"]
            isOneToOne: true
            referencedRelation: "mcpx_rw_fee_events"
            referencedColumns: ["event_key"]
          },
        ]
      }
      mcpx_rw_buyback_fills: {
        Row: {
          created_at: string
          decimals: number
          epoch_start: string
          evidence: Json
          finalized_slot: number
          intent_key: string
          mint: string
          signature: string
          sol_spent: number
          token_amount: number
        }
        Insert: {
          created_at?: string
          decimals: number
          epoch_start: string
          evidence: Json
          finalized_slot: number
          intent_key: string
          mint: string
          signature: string
          sol_spent: number
          token_amount: number
        }
        Update: {
          created_at?: string
          decimals?: number
          epoch_start?: string
          evidence?: Json
          finalized_slot?: number
          intent_key?: string
          mint?: string
          signature?: string
          sol_spent?: number
          token_amount?: number
        }
        Relationships: [
          {
            foreignKeyName: "mcpx_rw_buyback_fills_intent_key_fkey"
            columns: ["intent_key"]
            isOneToOne: false
            referencedRelation: "mcpx_rw_intents"
            referencedColumns: ["idempotency_key"]
          },
        ]
      }
      mcpx_rw_config: {
        Row: {
          anchor_slot: number | null
          deployer_wallet: string | null
          emergency_stop: boolean
          genesis_window: number | null
          id: number
          mint: string | null
          updated_at: string
        }
        Insert: {
          anchor_slot?: number | null
          deployer_wallet?: string | null
          emergency_stop?: boolean
          genesis_window?: number | null
          id?: number
          mint?: string | null
          updated_at?: string
        }
        Update: {
          anchor_slot?: number | null
          deployer_wallet?: string | null
          emergency_stop?: boolean
          genesis_window?: number | null
          id?: number
          mint?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      mcpx_rw_cursors: {
        Row: {
          last_signature: string | null
          last_slot: number | null
          source: string
          updated_at: string
        }
        Insert: {
          last_signature?: string | null
          last_slot?: number | null
          source: string
          updated_at?: string
        }
        Update: {
          last_signature?: string | null
          last_slot?: number | null
          source?: string
          updated_at?: string
        }
        Relationships: []
      }
      mcpx_rw_eligibility_policies: {
        Row: {
          approved_by: string | null
          body: Json
          created_at: string
          effective_from_window: string
          status: string
          version: string
        }
        Insert: {
          approved_by?: string | null
          body: Json
          created_at?: string
          effective_from_window: string
          status: string
          version: string
        }
        Update: {
          approved_by?: string | null
          body?: Json
          created_at?: string
          effective_from_window?: string
          status?: string
          version?: string
        }
        Relationships: []
      }
      mcpx_rw_entitlements: {
        Row: {
          amount: number
          branch: string
          created_at: string
          epoch_start: string
          owner: string
        }
        Insert: {
          amount: number
          branch: string
          created_at?: string
          epoch_start: string
          owner: string
        }
        Update: {
          amount?: number
          branch?: string
          created_at?: string
          epoch_start?: string
          owner?: string
        }
        Relationships: [
          {
            foreignKeyName: "mcpx_rw_entitlements_epoch_start_fkey"
            columns: ["epoch_start"]
            isOneToOne: false
            referencedRelation: "mcpx_rw_epochs"
            referencedColumns: ["epoch_start"]
          },
        ]
      }
      mcpx_rw_epochs: {
        Row: {
          buyback_total: number
          created_at: string
          epoch_start: string
          holder_sol_total: number
          lease_owner: string | null
          lease_until: string | null
          settled_at: string | null
          snapshot_id: string | null
          state: string
          updated_at: string
        }
        Insert: {
          buyback_total?: number
          created_at?: string
          epoch_start: string
          holder_sol_total?: number
          lease_owner?: string | null
          lease_until?: string | null
          settled_at?: string | null
          snapshot_id?: string | null
          state?: string
          updated_at?: string
        }
        Update: {
          buyback_total?: number
          created_at?: string
          epoch_start?: string
          holder_sol_total?: number
          lease_owner?: string | null
          lease_until?: string | null
          settled_at?: string | null
          snapshot_id?: string | null
          state?: string
          updated_at?: string
        }
        Relationships: []
      }
      mcpx_rw_fee_events: {
        Row: {
          amount: number
          asset: string
          block_time: string
          commitment: string
          event_index: number
          event_key: string
          ingested_at: string
          ix_index: number
          mint: string
          program_id: string
          quarantine_reason: string | null
          recipient: string
          signature: string
          slot: number
          source: string
          status: string
        }
        Insert: {
          amount: number
          asset: string
          block_time: string
          commitment: string
          event_index: number
          event_key: string
          ingested_at?: string
          ix_index: number
          mint: string
          program_id: string
          quarantine_reason?: string | null
          recipient: string
          signature: string
          slot: number
          source: string
          status: string
        }
        Update: {
          amount?: number
          asset?: string
          block_time?: string
          commitment?: string
          event_index?: number
          event_key?: string
          ingested_at?: string
          ix_index?: number
          mint?: string
          program_id?: string
          quarantine_reason?: string | null
          recipient?: string
          signature?: string
          slot?: number
          source?: string
          status?: string
        }
        Relationships: []
      }
      mcpx_rw_hix_applied_txs: {
        Row: {
          applied_at: string
          block_time: string | null
          failed: boolean
          mint: string
          signature: string
          slot: number
        }
        Insert: {
          applied_at?: string
          block_time?: string | null
          failed: boolean
          mint: string
          signature: string
          slot: number
        }
        Update: {
          applied_at?: string
          block_time?: string | null
          failed?: boolean
          mint?: string
          signature?: string
          slot?: number
        }
        Relationships: []
      }
      mcpx_rw_hix_balances: {
        Row: {
          amount: number
          last_signature: string
          last_slot: number
          mint: string
          owner: string | null
          token_account: string
        }
        Insert: {
          amount: number
          last_signature: string
          last_slot: number
          mint: string
          owner?: string | null
          token_account: string
        }
        Update: {
          amount?: number
          last_signature?: string
          last_slot?: number
          mint?: string
          owner?: string | null
          token_account?: string
        }
        Relationships: []
      }
      mcpx_rw_hix_checkpoints: {
        Row: {
          anchor_slot: number
          covered_to_slot: number
          mint: string
          source: string
          updated_at: string
        }
        Insert: {
          anchor_slot: number
          covered_to_slot: number
          mint: string
          source: string
          updated_at?: string
        }
        Update: {
          anchor_slot?: number
          covered_to_slot?: number
          mint?: string
          source?: string
          updated_at?: string
        }
        Relationships: []
      }
      mcpx_rw_hix_frozen_owners: {
        Row: {
          amount: number
          class: string
          mint: string
          owner: string
          reason: string | null
          window_start: string
        }
        Insert: {
          amount: number
          class: string
          mint: string
          owner: string
          reason?: string | null
          window_start: string
        }
        Update: {
          amount?: number
          class?: string
          mint?: string
          owner?: string
          reason?: string | null
          window_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "mcpx_rw_hix_frozen_owners_mint_window_start_fkey"
            columns: ["mint", "window_start"]
            isOneToOne: false
            referencedRelation: "mcpx_rw_hix_frozen_snapshots"
            referencedColumns: ["mint", "window_start"]
          },
        ]
      }
      mcpx_rw_hix_frozen_snapshots: {
        Row: {
          ambiguous_total: number
          checkpoint_slot: number
          completeness: string
          cutoff_slot: number
          digest: string
          eligible_total: number
          excluded_total: number
          frozen_at: string
          indexed_total: number
          mint: string
          policy_version: string
          supply_at_cutoff: number
          supply_proof: Json
          window_start: string
        }
        Insert: {
          ambiguous_total: number
          checkpoint_slot: number
          completeness: string
          cutoff_slot: number
          digest: string
          eligible_total: number
          excluded_total: number
          frozen_at?: string
          indexed_total: number
          mint: string
          policy_version: string
          supply_at_cutoff: number
          supply_proof: Json
          window_start: string
        }
        Update: {
          ambiguous_total?: number
          checkpoint_slot?: number
          completeness?: string
          cutoff_slot?: number
          digest?: string
          eligible_total?: number
          excluded_total?: number
          frozen_at?: string
          indexed_total?: number
          mint?: string
          policy_version?: string
          supply_at_cutoff?: number
          supply_proof?: Json
          window_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "mcpx_rw_hix_frozen_snapshots_mint_window_start_fkey"
            columns: ["mint", "window_start"]
            isOneToOne: true
            referencedRelation: "mcpx_rw_hix_window_cutoffs"
            referencedColumns: ["mint", "window_start"]
          },
          {
            foreignKeyName: "mcpx_rw_hix_frozen_snapshots_policy_version_fkey"
            columns: ["policy_version"]
            isOneToOne: false
            referencedRelation: "mcpx_rw_eligibility_policies"
            referencedColumns: ["version"]
          },
        ]
      }
      mcpx_rw_hix_gaps: {
        Row: {
          from_slot: number
          id: number
          mint: string
          reason: string
          repaired_at: string | null
          repaired_by_source: string | null
          to_slot: number
        }
        Insert: {
          from_slot: number
          id?: number
          mint: string
          reason: string
          repaired_at?: string | null
          repaired_by_source?: string | null
          to_slot: number
        }
        Update: {
          from_slot?: number
          id?: number
          mint?: string
          reason?: string
          repaired_at?: string | null
          repaired_by_source?: string | null
          to_slot?: number
        }
        Relationships: []
      }
      mcpx_rw_hix_holds: {
        Row: {
          created_at: string
          detail: Json
          id: number
          mint: string
          reason: string
          resolution: string | null
          resolved_at: string | null
          window_start: string
        }
        Insert: {
          created_at?: string
          detail?: Json
          id?: number
          mint: string
          reason: string
          resolution?: string | null
          resolved_at?: string | null
          window_start: string
        }
        Update: {
          created_at?: string
          detail?: Json
          id?: number
          mint?: string
          reason?: string
          resolution?: string | null
          resolved_at?: string | null
          window_start?: string
        }
        Relationships: []
      }
      mcpx_rw_hix_recovery_candidates: {
        Row: {
          candidate_digest: string | null
          comparison: Json
          correlation_id: string
          created_at: string
          cutoff_slot: number
          hold_ids: number[]
          id: string
          mint: string
          operator: string
          original_digest: string
          payable: boolean
          provenance: Json
          reason: string | null
          status: string
          window_start: string
        }
        Insert: {
          candidate_digest?: string | null
          comparison: Json
          correlation_id: string
          created_at?: string
          cutoff_slot: number
          hold_ids: number[]
          id?: string
          mint: string
          operator: string
          original_digest: string
          payable?: boolean
          provenance: Json
          reason?: string | null
          status: string
          window_start: string
        }
        Update: {
          candidate_digest?: string | null
          comparison?: Json
          correlation_id?: string
          created_at?: string
          cutoff_slot?: number
          hold_ids?: number[]
          id?: string
          mint?: string
          operator?: string
          original_digest?: string
          payable?: boolean
          provenance?: Json
          reason?: string | null
          status?: string
          window_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "mcpx_rw_hix_recovery_candidates_mint_window_start_fkey"
            columns: ["mint", "window_start"]
            isOneToOne: false
            referencedRelation: "mcpx_rw_hix_frozen_snapshots"
            referencedColumns: ["mint", "window_start"]
          },
        ]
      }
      mcpx_rw_hix_recovery_decisions: {
        Row: {
          candidate_id: string
          created_at: string
          decision: string
          hold_ids: number[]
          id: number
          mint: string
          operator: string
          window_start: string
        }
        Insert: {
          candidate_id: string
          created_at?: string
          decision: string
          hold_ids: number[]
          id?: number
          mint: string
          operator: string
          window_start: string
        }
        Update: {
          candidate_id?: string
          created_at?: string
          decision?: string
          hold_ids?: number[]
          id?: number
          mint?: string
          operator?: string
          window_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "mcpx_rw_hix_recovery_decisions_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: true
            referencedRelation: "mcpx_rw_hix_recovery_candidates"
            referencedColumns: ["id"]
          },
        ]
      }
      mcpx_rw_hix_snapshots: {
        Row: {
          created_at: string
          digest: string
          holder_count: number
          mint: string
          slot: number
          supply: number
          window_start: string
        }
        Insert: {
          created_at?: string
          digest: string
          holder_count: number
          mint: string
          slot: number
          supply: number
          window_start: string
        }
        Update: {
          created_at?: string
          digest?: string
          holder_count?: number
          mint?: string
          slot?: number
          supply?: number
          window_start?: string
        }
        Relationships: []
      }
      mcpx_rw_hix_window_cutoffs: {
        Row: {
          cutoff_block_time: string | null
          cutoff_slot: number | null
          evidence: Json
          finalized_head: number | null
          finalized_head_time: string | null
          hold_reason: string | null
          mint: string
          next_block_time: string | null
          next_slot: number | null
          selected_at: string
          selection_method: string
          status: string
          window_end: string
          window_start: string
        }
        Insert: {
          cutoff_block_time?: string | null
          cutoff_slot?: number | null
          evidence?: Json
          finalized_head?: number | null
          finalized_head_time?: string | null
          hold_reason?: string | null
          mint: string
          next_block_time?: string | null
          next_slot?: number | null
          selected_at?: string
          selection_method: string
          status: string
          window_end: string
          window_start: string
        }
        Update: {
          cutoff_block_time?: string | null
          cutoff_slot?: number | null
          evidence?: Json
          finalized_head?: number | null
          finalized_head_time?: string | null
          hold_reason?: string | null
          mint?: string
          next_block_time?: string | null
          next_slot?: number | null
          selected_at?: string
          selection_method?: string
          status?: string
          window_end?: string
          window_start?: string
        }
        Relationships: []
      }
      mcpx_rw_intents: {
        Row: {
          batch_id: string | null
          created_at: string
          cycle_id: string
          epoch_start: string | null
          evidence: Json | null
          finalized_slot: number | null
          first_sent_at: string | null
          idempotency_key: string
          kind: string
          lamports: number
          last_valid_block_height: number
          message_base64: string | null
          message_sha256: string
          ops_cost_lamports: number
          plan_mint: string | null
          plan_rows: Json | null
          plan_token_program: string | null
          reserved_by: string
          send_count: number
          signature: string | null
          signed_tx_base64: string | null
          state: string
          token_amount: number
          updated_at: string
        }
        Insert: {
          batch_id?: string | null
          created_at?: string
          cycle_id: string
          epoch_start?: string | null
          evidence?: Json | null
          finalized_slot?: number | null
          first_sent_at?: string | null
          idempotency_key: string
          kind: string
          lamports: number
          last_valid_block_height: number
          message_base64?: string | null
          message_sha256: string
          ops_cost_lamports?: number
          plan_mint?: string | null
          plan_rows?: Json | null
          plan_token_program?: string | null
          reserved_by: string
          send_count?: number
          signature?: string | null
          signed_tx_base64?: string | null
          state?: string
          token_amount?: number
          updated_at?: string
        }
        Update: {
          batch_id?: string | null
          created_at?: string
          cycle_id?: string
          epoch_start?: string | null
          evidence?: Json | null
          finalized_slot?: number | null
          first_sent_at?: string | null
          idempotency_key?: string
          kind?: string
          lamports?: number
          last_valid_block_height?: number
          message_base64?: string | null
          message_sha256?: string
          ops_cost_lamports?: number
          plan_mint?: string | null
          plan_rows?: Json | null
          plan_token_program?: string | null
          reserved_by?: string
          send_count?: number
          signature?: string | null
          signed_tx_base64?: string | null
          state?: string
          token_amount?: number
          updated_at?: string
        }
        Relationships: []
      }
      mcpx_rw_owner_carry: {
        Row: {
          lamports: number
          owner: string
          window_start: string
        }
        Insert: {
          lamports: number
          owner: string
          window_start: string
        }
        Update: {
          lamports?: number
          owner?: string
          window_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "mcpx_rw_owner_carry_window_start_fkey"
            columns: ["window_start"]
            isOneToOne: false
            referencedRelation: "mcpx_rw_window_plans"
            referencedColumns: ["window_start"]
          },
        ]
      }
      mcpx_rw_payout_intents: {
        Row: {
          authorized_by: string | null
          branch: string
          created_at: string
          epoch_start: string
          id: string
          state: string
          total: number
        }
        Insert: {
          authorized_by?: string | null
          branch: string
          created_at?: string
          epoch_start: string
          id?: string
          state?: string
          total: number
        }
        Update: {
          authorized_by?: string | null
          branch?: string
          created_at?: string
          epoch_start?: string
          id?: string
          state?: string
          total?: number
        }
        Relationships: [
          {
            foreignKeyName: "mcpx_rw_payout_intents_epoch_start_fkey"
            columns: ["epoch_start"]
            isOneToOne: false
            referencedRelation: "mcpx_rw_epochs"
            referencedColumns: ["epoch_start"]
          },
        ]
      }
      mcpx_rw_policies: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          config: Json
          config_sha256: string
          created_at: string
          effective_from_slot: number | null
          version: string
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          config: Json
          config_sha256: string
          created_at?: string
          effective_from_slot?: number | null
          version: string
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          config?: Json
          config_sha256?: string
          created_at?: string
          effective_from_slot?: number | null
          version?: string
        }
        Relationships: []
      }
      mcpx_rw_proc_runs: {
        Row: {
          at: string
          correlation_id: string
          id: number
          outcome: string
          reason: string | null
          window_start: string | null
          worker_id: string
        }
        Insert: {
          at?: string
          correlation_id: string
          id?: number
          outcome: string
          reason?: string | null
          window_start?: string | null
          worker_id: string
        }
        Update: {
          at?: string
          correlation_id?: string
          id?: number
          outcome?: string
          reason?: string | null
          window_start?: string | null
          worker_id?: string
        }
        Relationships: []
      }
      mcpx_rw_proc_state: {
        Row: {
          heartbeat_at: string | null
          id: number
          lease_owner: string | null
          lease_until: string | null
          updated_at: string
          watermark: string | null
        }
        Insert: {
          heartbeat_at?: string | null
          id: number
          lease_owner?: string | null
          lease_until?: string | null
          updated_at?: string
          watermark?: string | null
        }
        Update: {
          heartbeat_at?: string | null
          id?: number
          lease_owner?: string | null
          lease_until?: string | null
          updated_at?: string
          watermark?: string | null
        }
        Relationships: []
      }
      mcpx_rw_receipt_consumption: {
        Row: {
          kind: string
          receipt_key: string
          window_start: string
        }
        Insert: {
          kind: string
          receipt_key: string
          window_start: string
        }
        Update: {
          kind?: string
          receipt_key?: string
          window_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "mcpx_rw_receipt_consumption_receipt_key_fkey"
            columns: ["receipt_key"]
            isOneToOne: true
            referencedRelation: "mcpx_rw_sharing_receipts"
            referencedColumns: ["receipt_key"]
          },
          {
            foreignKeyName: "mcpx_rw_receipt_consumption_window_start_fkey"
            columns: ["window_start"]
            isOneToOne: false
            referencedRelation: "mcpx_rw_window_plans"
            referencedColumns: ["window_start"]
          },
        ]
      }
      mcpx_rw_remote_nonces: {
        Row: {
          nonce: string
          seen_at: string
        }
        Insert: {
          nonce: string
          seen_at?: string
        }
        Update: {
          nonce?: string
          seen_at?: string
        }
        Relationships: []
      }
      mcpx_rw_sharing_receipts: {
        Row: {
          block_time: string
          buyback_budget: number
          commitment: string
          event_index: number
          ingested_at: string
          ix_index: number
          mint: string
          operations_lamports: number
          operations_recipient: string
          program_id: string
          receipt_key: string
          rewards_lamports: number
          rewards_recipient: string
          sharing_config: string
          signature: string
          slot: number
          sol_budget: number
          window_start: string
        }
        Insert: {
          block_time: string
          buyback_budget: number
          commitment: string
          event_index: number
          ingested_at?: string
          ix_index: number
          mint: string
          operations_lamports: number
          operations_recipient: string
          program_id: string
          receipt_key: string
          rewards_lamports: number
          rewards_recipient: string
          sharing_config: string
          signature: string
          slot: number
          sol_budget: number
          window_start: string
        }
        Update: {
          block_time?: string
          buyback_budget?: number
          commitment?: string
          event_index?: number
          ingested_at?: string
          ix_index?: number
          mint?: string
          operations_lamports?: number
          operations_recipient?: string
          program_id?: string
          receipt_key?: string
          rewards_lamports?: number
          rewards_recipient?: string
          sharing_config?: string
          signature?: string
          slot?: number
          sol_budget?: number
          window_start?: string
        }
        Relationships: []
      }
      mcpx_rw_snapshot_holders: {
        Row: {
          amount: number
          owner: string
          snapshot_id: string
        }
        Insert: {
          amount: number
          owner: string
          snapshot_id: string
        }
        Update: {
          amount?: number
          owner?: string
          snapshot_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "mcpx_rw_snapshot_holders_snapshot_id_fkey"
            columns: ["snapshot_id"]
            isOneToOne: false
            referencedRelation: "mcpx_rw_snapshots"
            referencedColumns: ["id"]
          },
        ]
      }
      mcpx_rw_snapshots: {
        Row: {
          created_at: string
          eligible_total: number
          excluded_total: number
          holder_count: number
          id: string
          mint: string
          policy_approved: boolean
          policy_version: string
          slot: number
          source: string
        }
        Insert: {
          created_at?: string
          eligible_total: number
          excluded_total: number
          holder_count: number
          id?: string
          mint: string
          policy_approved?: boolean
          policy_version: string
          slot: number
          source: string
        }
        Update: {
          created_at?: string
          eligible_total?: number
          excluded_total?: number
          holder_count?: number
          id?: string
          mint?: string
          policy_approved?: boolean
          policy_version?: string
          slot?: number
          source?: string
        }
        Relationships: []
      }
      mcpx_rw_swap_intents: {
        Row: {
          budget_lamports: number
          created_at: string
          epoch_start: string
          id: string
          max_price_impact_bps: number
          max_slippage_bps: number
          min_out_base_units: number | null
          state: string
        }
        Insert: {
          budget_lamports: number
          created_at?: string
          epoch_start: string
          id?: string
          max_price_impact_bps: number
          max_slippage_bps: number
          min_out_base_units?: number | null
          state?: string
        }
        Update: {
          budget_lamports?: number
          created_at?: string
          epoch_start?: string
          id?: string
          max_price_impact_bps?: number
          max_slippage_bps?: number
          min_out_base_units?: number | null
          state?: string
        }
        Relationships: [
          {
            foreignKeyName: "mcpx_rw_swap_intents_epoch_start_fkey"
            columns: ["epoch_start"]
            isOneToOne: true
            referencedRelation: "mcpx_rw_epochs"
            referencedColumns: ["epoch_start"]
          },
        ]
      }
      mcpx_rw_window_plans: {
        Row: {
          buyback_budget: number
          committed_by: string
          created_at: string
          hold_reasons: string[]
          input_digest: string
          mode: string
          operations_total: number
          plan: Json
          plan_id: string
          policy_version: string | null
          processor_version: string
          rewards_total: number
          snapshot_slot: number | null
          sol_budget: number
          status: string
          window_start: string
        }
        Insert: {
          buyback_budget: number
          committed_by: string
          created_at?: string
          hold_reasons?: string[]
          input_digest: string
          mode: string
          operations_total: number
          plan: Json
          plan_id: string
          policy_version?: string | null
          processor_version: string
          rewards_total: number
          snapshot_slot?: number | null
          sol_budget: number
          status: string
          window_start: string
        }
        Update: {
          buyback_budget?: number
          committed_by?: string
          created_at?: string
          hold_reasons?: string[]
          input_digest?: string
          mode?: string
          operations_total?: number
          plan?: Json
          plan_id?: string
          policy_version?: string | null
          processor_version?: string
          rewards_total?: number
          snapshot_slot?: number | null
          sol_budget?: number
          status?: string
          window_start?: string
        }
        Relationships: []
      }
      outbox_events: {
        Row: {
          aggregate_id: string
          aggregate_type: string
          created_at: string
          event_type: string
          event_version: number
          id: string
          idempotency_key: string
          occurred_at: string
          payload: Json
        }
        Insert: {
          aggregate_id: string
          aggregate_type: string
          created_at?: string
          event_type: string
          event_version: number
          id?: string
          idempotency_key: string
          occurred_at?: string
          payload?: Json
        }
        Update: {
          aggregate_id?: string
          aggregate_type?: string
          created_at?: string
          event_type?: string
          event_version?: number
          id?: string
          idempotency_key?: string
          occurred_at?: string
          payload?: Json
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      mcpx_ai_admit: {
        Args: {
          _creation: string
          _credential: string
          _in: number
          _out: number
          _ref: string
        }
        Returns: string
      }
      mcpx_ai_purge_usage: { Args: { _batch: number }; Returns: number }
      mcpx_ai_put_credential: {
        Args: {
          _creation: string
          _ct: string
          _expected_rev: number
          _hint: string
          _idem: string
          _iv: string
          _kek: string
          _mode: string
          _model: string
          _provider: string
          _wallet: string
        }
        Returns: string
      }
      mcpx_ai_record_health: {
        Args: {
          _creation: string
          _cred_version: number
          _health: string
          _wallet: string
        }
        Returns: string
      }
      mcpx_ai_revoke: {
        Args: { _creation: string; _expected_rev: number; _wallet: string }
        Returns: string
      }
      mcpx_ai_set_enabled: {
        Args: {
          _creation: string
          _enabled: boolean
          _expected_rev: number
          _wallet: string
        }
        Returns: string
      }
      mcpx_ai_set_model_limits: {
        Args: {
          _conc: number
          _creation: string
          _expected_rev: number
          _in: number
          _model: string
          _out: number
          _pd: number
          _pm: number
          _wallet: string
        }
        Returns: string
      }
      mcpx_ai_settle: {
        Args: {
          _cost: number
          _in: number
          _out: number
          _status: string
          _usage: string
        }
        Returns: boolean
      }
      mcpx_free_test_take: {
        Args: { _bucket: string; _limit: number }
        Returns: boolean
      }
      mcpx_issue_product_key: {
        Args: {
          _actor_kind: string
          _actor_ref: string
          _creation_id: string
          _display_prefix: string
          _expires_at: string
          _idempotency_key: string
          _label: string
          _rotate_key_id: string
          _verifier: string
        }
        Returns: string
      }
      mcpx_rate_limit_take: {
        Args: { _bucket: string; _limit: number; _window_seconds: number }
        Returns: boolean
      }
      mcpx_revoke_product_key: {
        Args: {
          _actor_kind: string
          _actor_ref: string
          _creation_id: string
          _key_id: string
        }
        Returns: boolean
      }
      mcpx_rw_acquire_lease: {
        Args: { _owner: string; _ttl_seconds: number }
        Returns: boolean
      }
      mcpx_rw_budget_remaining: {
        Args: { p_epoch: string }
        Returns: {
          buyback: number
          evidence: boolean
          ops: number
          sol: number
          tokens: number
        }[]
      }
      mcpx_rw_commit_window: {
        Args: {
          _adj: string[]
          _carry: Json
          _expected: string
          _own: string[]
          _owner: string
          _plan: Json
          _processor_version: string
          _window: string
        }
        Returns: string
      }
      mcpx_rw_conservation: {
        Args: never
        Returns: {
          allocated: number
          conserved: boolean
          credited_events: number
          quarantined_events: number
          receipts: number
          residual: number
        }[]
      }
      mcpx_rw_hix_resolve_window: {
        Args: { p_candidate: string; p_operator: string }
        Returns: string
      }
      mcpx_rw_release_lease: { Args: { _owner: string }; Returns: undefined }
      mcpx_rw_remote_exec: { Args: { p_steps: Json }; Returns: Json }
      mcpx_rw_remote_nonce_take: { Args: { p_nonce: string }; Returns: boolean }
      mcpx_rw_row_text: { Args: { r: Json }; Returns: Json }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
