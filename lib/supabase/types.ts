export type LeadStatus = "checking" | "meeting" | "booked" | "played" | "lost";
export type DjTier = "Headliner" | "Resident" | "Associate";
export type ProdTier = "Marquee" | "Modern" | "Essential";
export type TravelZone = "Local" | "Extended Local" | "Regional" | "Central CA";
export type LeadSource = "honeybook" | "manual";
export type AvailabilityAnswer = "available" | "pass";
export type UserRole = "owner" | "dj";

export interface Database {
  public: {
    Tables: {
      users: {
        Row: {
          id: string;
          email: string;
          display_name: string | null;
          role: UserRole;
          created_at: string;
        };
        Insert: {
          id: string;
          email: string;
          display_name?: string | null;
          role?: UserRole;
        };
        Update: {
          display_name?: string | null;
          role?: UserRole;
        };
        Relationships: [];
      };
      dj_profiles: {
        Row: {
          user_id: string;
          dj_tier_visibility: DjTier[];
          notify_email: boolean;
          notify_sms: boolean;
          phone: string | null;
        };
        Insert: {
          user_id: string;
          dj_tier_visibility?: DjTier[];
          notify_email?: boolean;
          notify_sms?: boolean;
          phone?: string | null;
        };
        Update: {
          dj_tier_visibility?: DjTier[];
          notify_email?: boolean;
          notify_sms?: boolean;
          phone?: string | null;
        };
        Relationships: [];
      };
      leads: {
        Row: {
          id: string;
          client_name: string | null;
          fiance_name: string | null;
          contact: string | null;
          event_date: string | null;
          location: string | null;
          dj_tier: DjTier | null;
          prod_tier: ProdTier | null;
          upgrades: string | null;
          client_vision: string | null;
          source: LeadSource;
          owner_notes: string | null;
          dj_notes: string | null;
          meeting_notes: string | null;
          payout: number | null;
          travel_zone: TravelZone | null;
          travel_rate: number | null;
          deposit_paid: boolean;
          paid_in_full: boolean;
          status: LeadStatus;
          assigned_dj_id: string | null;
          honeybook_ref: string | null;
          needs_review: boolean;
          created_at: string;
        };
        Insert: {
          client_name?: string | null;
          fiance_name?: string | null;
          contact?: string | null;
          event_date?: string | null;
          location?: string | null;
          dj_tier?: DjTier | null;
          prod_tier?: ProdTier | null;
          upgrades?: string | null;
          client_vision?: string | null;
          source?: LeadSource;
          owner_notes?: string | null;
          dj_notes?: string | null;
          meeting_notes?: string | null;
          payout?: number | null;
          travel_zone?: TravelZone | null;
          travel_rate?: number | null;
          deposit_paid?: boolean;
          paid_in_full?: boolean;
          status?: LeadStatus;
          assigned_dj_id?: string | null;
          honeybook_ref?: string | null;
          needs_review?: boolean;
        };
        Update: {
          client_name?: string | null;
          fiance_name?: string | null;
          contact?: string | null;
          event_date?: string | null;
          location?: string | null;
          dj_tier?: DjTier | null;
          prod_tier?: ProdTier | null;
          upgrades?: string | null;
          client_vision?: string | null;
          owner_notes?: string | null;
          dj_notes?: string | null;
          meeting_notes?: string | null;
          payout?: number | null;
          travel_zone?: TravelZone | null;
          travel_rate?: number | null;
          deposit_paid?: boolean;
          paid_in_full?: boolean;
          status?: LeadStatus;
          assigned_dj_id?: string | null;
          needs_review?: boolean;
        };
        Relationships: [];
      };
      availability_responses: {
        Row: {
          id: string;
          lead_id: string;
          dj_user_id: string;
          response: AvailabilityAnswer;
          responded_at: string;
        };
        Insert: {
          lead_id: string;
          dj_user_id: string;
          response: AvailabilityAnswer;
        };
        Update: {
          response?: AvailabilityAnswer;
        };
        Relationships: [];
      };
      events: {
        Row: {
          id: string;
          lead_id: string | null;
          actor_user_id: string | null;
          event_type: string;
          detail: Record<string, unknown> | null;
          created_at: string;
        };
        Insert: {
          lead_id?: string | null;
          actor_user_id?: string | null;
          event_type: string;
          detail?: Record<string, unknown> | null;
        };
        Update: Record<string, never>;
        Relationships: [];
      };
      company_settings: {
        Row: {
          id: number;
          headliner_rate: number;
          resident_rate: number;
          associate_rate: number;
          marquee_rate: number;
          modern_rate: number;
          essential_rate: number;
          travel_local_rate: number;
          travel_extended_local_rate: number;
          travel_regional_rate: number;
          travel_central_ca_rate: number;
        };
        Insert: {
          id?: number;
          headliner_rate?: number;
          resident_rate?: number;
          associate_rate?: number;
          marquee_rate?: number;
          modern_rate?: number;
          essential_rate?: number;
          travel_local_rate?: number;
          travel_extended_local_rate?: number;
          travel_regional_rate?: number;
          travel_central_ca_rate?: number;
        };
        Update: {
          headliner_rate?: number;
          resident_rate?: number;
          associate_rate?: number;
          marquee_rate?: number;
          modern_rate?: number;
          essential_rate?: number;
          travel_local_rate?: number;
          travel_extended_local_rate?: number;
          travel_regional_rate?: number;
          travel_central_ca_rate?: number;
        };
        Relationships: [];
      };
    };
    Views: {
      leads_feed: {
        Row: {
          id: string;
          client_name: string | null;
          fiance_name: string | null;
          contact: string | null;
          event_date: string | null;
          location: string | null;
          dj_tier: DjTier | null;
          prod_tier: ProdTier | null;
          upgrades: string | null;
          client_vision: string | null;
          owner_notes: string | null;
          dj_notes: string | null;
          meeting_notes: string | null;
          payout: number | null;
          travel_zone: TravelZone | null;
          travel_rate: number | null;
          deposit_paid: boolean | null;
          paid_in_full: boolean | null;
          status: LeadStatus;
          assigned_dj_id: string | null;
          source: LeadSource;
          honeybook_ref: string | null;
          needs_review: boolean;
          created_at: string;
          has_available: boolean;
        };
        Relationships: [];
      };
      dj_leaderboard: {
        Row: {
          dj_id: string;
          display_name: string | null;
          email: string;
          booking_count: number;
          booking_total: number;
        };
        Relationships: [];
      };
    };
    Functions: Record<string, never>;
  };
}
