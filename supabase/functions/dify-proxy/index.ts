// Supabase Edge Function: dify-proxy
//
// Forwards requests to Dify's API (https://api.dify.ai) from the server side,
// so the browser never talks to api.dify.ai directly and never hits Dify's
// CORS block. This function also owns all four Dify API keys used by
// PassMate — they no longer need to live in the frontend bundle at all.
//
// Deploy with:
//   supabase functions deploy dify-proxy
//
// (No --no-verify-jwt needed — the frontend already sends the Supabase anon
// key as a Bearer token on every call, same as the existing make-server
// function, so Supabase's default JWT check passes.)
//
// Then set the four secrets (get real values from Dify → each app → API access):
//   supabase secrets set DIFY_STAGE1_KEY=app-xxxxxxxx
//   supabase secrets set DIFY_STAGE2_KEY=app-xxxxxxxx
//   supabase secrets set DIFY_PROMPT_KEY=app-xxxxxxxx
//   supabase secrets set DIFY_ASSISTANT_KEY=app-xxxxxxxx
//
// DIFY_STAGE1_KEY    = 应用1「真题客观拆解」的 key（图片输入）
// DIFY_STAGE2_KEY    = 应用4「真题综合摸规与排序」的 key（纯文本输入）
// DIFY_PROMPT_KEY    = Prompt Center 里 Unit study / Flashcard 用的那个 Dify App 的 key
// DIFY_ASSISTANT_KEY = AI Solver Assistant 聊天用的那个 Dify App 的 key
//
// Frontend calls (see DIFY_PROXY_BASE in lib/passmateApi.ts):
//   POST {DIFY_PROXY_BASE}?action=upload      (multipart/form-data, forwarded as-is)
//   POST {DIFY_PROXY_BASE}?action=run-stage1  (JSON body, forwarded as-is)
//   POST {DIFY_PROXY_BASE}?action=run-stage2  (JSON body, forwarded as-is)
//   POST {DIFY_PROXY_BASE}?action=run-prompt  (JSON body, forwarded as-is)
//   POST {DIFY_PROXY_BASE}?action=chat        (JSON body, forwarded as-is)

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
}

const DIFY_STAGE1_KEY = Deno.env.get("DIFY_STAGE1_KEY") ?? ""
const DIFY_STAGE2_KEY = Deno.env.get("DIFY_STAGE2_KEY") ?? ""
const DIFY_PROMPT_KEY = Deno.env.get("DIFY_PROMPT_KEY") ?? ""
const DIFY_ASSISTANT_KEY = Deno.env.get("DIFY_ASSISTANT_KEY") ?? ""

Deno.serve(async (req: Request) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS })
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    })
  }

  const url = new URL(req.url)
  const action = url.searchParams.get("action")

  try {
    if (action === "upload") {
      // Forward the multipart/form-data body as-is to Dify's file upload endpoint.
      // Stage-1 (真题客观拆解) is the only workflow that takes images, so this
      // always uses DIFY_STAGE1_KEY.
      if (!DIFY_STAGE1_KEY) {
        return jsonError("Missing DIFY_STAGE1_KEY secret on the server", 500)
      }
      const formData = await req.formData()
      const upstream = await fetch("https://api.dify.ai/v1/files/upload", {
        method: "POST",
        headers: { Authorization: `Bearer ${DIFY_STAGE1_KEY}` },
        body: formData,
      })
      return relay(upstream)
    }

    if (
      action === "run-stage1" ||
      action === "run-stage2" ||
      action === "run-prompt"
    ) {
      const key =
        action === "run-stage1"
          ? DIFY_STAGE1_KEY
          : action === "run-stage2"
            ? DIFY_STAGE2_KEY
            : DIFY_PROMPT_KEY
      const keyName =
        action === "run-stage1"
          ? "DIFY_STAGE1_KEY"
          : action === "run-stage2"
            ? "DIFY_STAGE2_KEY"
            : "DIFY_PROMPT_KEY"
      if (!key) {
        return jsonError(`Missing ${keyName} secret on the server`, 500)
      }
      const body = await req.text()
      const upstream = await fetch("https://api.dify.ai/v1/workflows/run", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body,
      })
      return relay(upstream)
    }

    if (action === "chat") {
      if (!DIFY_ASSISTANT_KEY) {
        return jsonError("Missing DIFY_ASSISTANT_KEY secret on the server", 500)
      }
      const body = await req.text()
      const upstream = await fetch("https://api.dify.ai/v1/chat-messages", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${DIFY_ASSISTANT_KEY}`,
          "Content-Type": "application/json",
        },
        body,
      })
      return relay(upstream)
    }

    return jsonError(`Unknown action: ${action}`, 400)
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Proxy error", 500)
  }
})

// Pass an upstream Dify response straight through to the browser, just with
// CORS headers added so the browser will actually accept it.
async function relay(upstream: Response): Promise<Response> {
  const text = await upstream.text()
  return new Response(text, {
    status: upstream.status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": upstream.headers.get("Content-Type") ?? "application/json",
    },
  })
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  })
}
