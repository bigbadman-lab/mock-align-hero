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
