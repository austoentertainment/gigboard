import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { EmailOtpType } from "@supabase/supabase-js";

// Password-reset (and any other OTP-email) links are verified here via
// token_hash instead of the PKCE code-exchange flow — recovery links are
// routinely opened in a different browser/device than the one that
// requested them (email client, phone vs. laptop), and PKCE's code_verifier
// only exists in the browser that made the original request, so that flow
// reliably fails cross-context. token_hash verification has no such
// requirement.
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const token_hash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const next = searchParams.get("next") || "/board";

  if (token_hash && type) {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash });
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth`);
}
