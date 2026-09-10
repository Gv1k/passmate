import { projectId, publicAnonKey } from "../../utils/supabase/info"

const BASE = `https://${projectId}.supabase.co/functions/v1/make-server-f263515b`

// Base URL for the "dify-proxy" Edge Function (see /supabase/functions/dify-proxy
// in the outputs — deploy it separately from make-server-f263515b). The browser
// calls this instead of api.dify.ai directly, sidestepping Dify's CORS block.
export const DIFY_PROXY_BASE = `https://${projectId}.supabase.co/functions/v1/dify-proxy`
export { publicAnonKey }

export interface PassmateState {
  // Format B: written by this app
  seeds?: Array<{ name: string; examDate: string; color: string }>
  checklists?: Record<string, Array<{ id: number; text: string; done: boolean; locked?: boolean }>>
  quickItems?: Record<string, Array<{ id: number; text: string; done: boolean }>>
  notes?: Record<string, string>
  boardTopics?: Record<
    string,
    Array<{
      name: string
      priority?: string
      tag?: string
      freq?: number
      score?: number
      pct?: number
    }>
  >
  subjectProgress?: Record<string, number>
  // 复习流程 section 里每个科目已经点过"完成"的步骤编号（1~5）。
  flowStepsDone?: Record<string, number[]>
  // 每个科目自己设的目标分数（及格保险线），默认 65。
  targetScores?: Record<string, number>
  // Format A: subjects array with embedded progress and board_data
  subjects?: Array<{
    name: string
    examDate?: string
    color?: string
    progress?: number
    board_data?: {
      topics?: Array<{
        name: string
        priority?: string
        tag?: string
        freq?: number
        score?: number
        pct?: number
      }>
    }
  }>
}

export async function loadState(): Promise<PassmateState | null> {
  try {
    const res = await fetch(`${BASE}/passmate`, {
      headers: {
        Authorization: `Bearer ${publicAnonKey}`,
      },
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
export function scheduleSave(state: PassmateState) {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    fetch(`${BASE}/passmate`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${publicAnonKey}`,
      },
      body: JSON.stringify(state),
    }).catch(() => {})
  }, 800)
}