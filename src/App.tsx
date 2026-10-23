import {
  useState,
  useEffect,
  useRef,
  type ChangeEvent,
} from "react"
import { loadState, scheduleSave, DIFY_PROXY_BASE, publicAnonKey } from "./lib/passmateApi"

// ─── Scroll reveal hook ──────────────────────────────────────
function useReveal() {
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const obs = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { threshold: 0.12 },
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [])
  return { ref, visible }
}

// ─── Design tokens ───────────────────────────────────────────
const BLUE = "#326AFD"
const LIME = "#92EC47"
const NAVY = "#0C1419"
const WHITE = "#FFFFFF"

// ─── Types ───────────────────────────────────────────────────
interface CheckItem {
  id: number
  text: string
  done: boolean
  locked?: boolean
}

interface BoardQuestionRef {
  setIndex: number // 第几套卷子（1~3）
  questionNo?: string // 在这套卷子里的题号，如"大题第2题"/"选择第5题"
  questionText?: string // 题目原文
}

interface BoardTopic {
  id?: string // 前端生成的稳定 key，用于编辑/删除/打勾（不依赖 AI 返回）
  name: string
  priority?: string // field name used in Supabase
  tag?: string // legacy field name (fallback)
  freq?: number
  score?: number // 绝对分值（如 15），不是百分比
  pct?: number
  category?: "big" | "small" // 大题/小题分类，用于 Priority Board 分板块展示
  difficulty?: string // 仅大题有意义，AI 给出的全局难度判定（"简单好上手/套路死板"/"中等"/"综合灵活"）
  totalSets?: number // 这次分析总共传了几套卷子，用于把 freq 显示成 "2/3" 这种分数
  done?: boolean // 用户手动标记"已学完"，UI 上变灰但位置不变

  // 以下字段需要 Dify 阶段一/阶段二的 prompt+schema 更新后才会有数据；
  // 没数据时详情弹窗会显示占位提示，不会报错。
  questions?: BoardQuestionRef[] // 三套卷子里对应的具体题目
  insight?: string // 考点本质与命题规律总结
  steps?: string[] // 通关必备步骤 step1/step2...
  coreKnowledge?: string // 核心知识点/公式/定义
  pitfalls?: string // 易错点（可能带换行，前端按行拆成多个警告框）
  tags?: string[] // 方法/考法关键词小标签（如"比值法/根值法求R"），需要 Dify 新增字段才会有数据
}

// ─── Dify exam-point analysis (in-app, replaces manual Dify → Supabase copy) ──
// NOTE: Dify calls all go through the "dify-proxy" Supabase Edge Function
// (see /supabase-functions/dify-proxy/index.ts) instead of hitting
// api.dify.ai directly — Dify's API doesn't send CORS headers for arbitrary
// browser origins, so a direct browser→Dify call gets blocked. The proxy
// also owns the actual Dify API keys (as Supabase secrets), so nothing
// Dify-related needs to live in this frontend bundle anymore.

// Upload one image via the proxy and get back the file id the workflow expects.
async function difyUploadFile(file: File): Promise<string> {
  const form = new FormData()
  form.append("file", file)
  form.append("user", "passmate-user")
  const res = await fetch(`${DIFY_PROXY_BASE}?action=upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${publicAnonKey}` },
    body: form,
  })
  if (!res.ok) throw new Error(`Dify file upload failed: ${res.status}`)
  const json = await res.json()
  return json.id as string
}

// Shape of one「真题客观拆解」result (阶段一 output) — pure OCR + point mapping,
// no frequency/priority/difficulty yet, those only get decided in 阶段二.
interface SingleSetResult {
  subject?: string
  big_questions?: Array<{
    point_name: string
    score?: number
  }>
  small_questions?: Array<{
    point_name: string
    score?: number
  }>
}

// Parse a Dify workflow output that may come back as a JSON-stringified
// value depending on the LLM node's output mode.
function parseDifyOutput(raw: unknown): any {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }
  return raw
}

// Flatten 阶段二's final { big_questions: [...], small_questions: [...] }
// output into the flat BoardTopic[] the Priority Board renders. Order is
// preserved as-is — Dify already returns each list pre-sorted by
// priority → frequency → difficulty, so this must NOT re-sort.
function flattenAnalysisOutput(raw: unknown): BoardTopic[] {
  let parsed = parseDifyOutput(raw)
  if (!parsed) return []
  const structured = parsed?.structured_output ?? parsed
  const topics: BoardTopic[] = []

  const pushTopics = (list: any[], category: "big" | "small") => {
    let i = 0
    for (const kp of list ?? []) {
      const rawScore = kp?.score
      const score =
        typeof rawScore === "string" ? parseFloat(rawScore) : rawScore
      const rawQuestions = Array.isArray(kp?.questions) ? kp.questions : []
      topics.push({
        id: `${category}-${i++}-${kp?.point_name ?? "未命名"}`,
        name: kp?.point_name ?? "未命名考点",
        priority: kp?.priority,
        freq: kp?.frequency,
        score: Number.isFinite(score) ? score : undefined,
        category,
        difficulty: category === "big" ? kp?.difficulty : undefined,
        // 下面这些字段目前 Dify 还没有返回（等 prompt/schema 更新后才会有值），
        // 先按 undefined 兜底，UI 会自动显示"暂无数据"占位。
        questions: rawQuestions.length
          ? rawQuestions.map((q: any) => ({
              setIndex: q?.set_index ?? q?.setIndex,
              questionNo: q?.question_no ?? q?.questionNo,
              questionText: q?.question_text ?? q?.questionText,
            }))
          : undefined,
        insight: kp?.insight,
        steps: Array.isArray(kp?.steps) ? kp.steps : undefined,
        coreKnowledge: kp?.core_knowledge ?? kp?.coreKnowledge,
        pitfalls: kp?.pitfalls,
        tags: Array.isArray(kp?.tags) ? kp.tags : undefined,
      })
    }
  }
  pushTopics(structured?.big_questions ?? [], "big")
  pushTopics(structured?.small_questions ?? [], "small")
  return topics
}

// 阶段一：上传一套卷子的照片，跑「真题客观拆解」工作流，返回这一套的原始 JSON 结果
// （不摊平——阶段二综合排序需要把这份原始 JSON 整份作为 analysis_N 文本传入）。
async function runSingleSetAnalysis(
  files: File[],
  subject: string,
  setIndex: number,
): Promise<SingleSetResult> {
  const uploadedIds = await Promise.all(files.map((f) => difyUploadFile(f)))
  const exam_images = uploadedIds.map((id) => ({
    type: "image",
    transfer_method: "local_file",
    upload_file_id: id,
  }))
  const res = await fetch(`${DIFY_PROXY_BASE}?action=run-stage1`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${publicAnonKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      inputs: { exam_images, subject },
      response_mode: "blocking",
      user: "passmate-user",
    }),
  })
  if (!res.ok) throw new Error(`Dify analysis failed for set ${setIndex}: ${res.status}`)
  const json = await res.json()
  const rawOutput =
    json?.data?.outputs?.structured_output ?? json?.data?.outputs
  const parsed = parseDifyOutput(rawOutput)
  return (parsed?.structured_output ?? parsed ?? {}) as SingleSetResult
}

// 阶段二：把 1~3 份单套分析结果（各自整份 JSON 文本，不含图片）作为
// analysis_1 / analysis_2 / analysis_3 传给「真题综合摸规与排序」工作流，
// 返回摊平好、可以直接写入 boardTopics 的最终结果。
// 缺的套次传字符串 "None"（不是空字符串）——跟 Dify prompt 里写的判断逻辑对齐：
// "若 analysis_2 或 analysis_3 为空、'None' 或非法 JSON，请直接忽略"
async function runRankingAnalysis(
  setResults: SingleSetResult[],
): Promise<BoardTopic[]> {
  const inputs: Record<string, string> = {
    analysis_1: JSON.stringify(setResults[0] ?? {}),
    analysis_2: setResults[1] ? JSON.stringify(setResults[1]) : "None",
    analysis_3: setResults[2] ? JSON.stringify(setResults[2]) : "None",
  }
  const res = await fetch(`${DIFY_PROXY_BASE}?action=run-stage2`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${publicAnonKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      inputs,
      response_mode: "blocking",
      user: "passmate-user",
    }),
  })
  if (!res.ok) throw new Error(`Dify ranking step failed: ${res.status}`)
  const json = await res.json()
  const rawOutput =
    json?.data?.outputs?.structured_output ?? json?.data?.outputs
  return flattenAnalysisOutput(rawOutput)
}

// 串联阶段一 + 阶段二：依次跑完每一套的单套分析，再跑一次综合排序。
// `onProgress` 用于给上传页展示"正在分析第X/N套…" → "正在综合排序…" 的进度提示。
async function runExamPointAnalysis(
  fileSets: File[][],
  subject: string,
  onProgress?: (step: { kind: "set"; index: number; total: number } | { kind: "ranking" }) => void,
): Promise<BoardTopic[]> {
  const nonEmptySets = fileSets.filter((files) => files.length > 0)
  if (nonEmptySets.length === 0) return []

  const setResults: SingleSetResult[] = []
  for (let i = 0; i < nonEmptySets.length; i++) {
    onProgress?.({ kind: "set", index: i + 1, total: nonEmptySets.length })
    const result = await runSingleSetAnalysis(nonEmptySets[i], subject, i + 1)
    setResults.push(result)
  }

  onProgress?.({ kind: "ranking" })
  const topics = await runRankingAnalysis(setResults)
  // 打上这次分析总共传了几套卷子，方便 UI 把 freq 显示成 "2/3" 这种分数。
  return topics.map((t) => ({ ...t, totalSets: nonEmptySets.length }))
}

// ─── Data ────────────────────────────────────────────────────
// Master checklist template. Non-deletable, but each item is checkable —
// checking items is what drives a subject's progress. The "Run AI exam-point
// analysis" item (id 2) is the F1 groundwork step: checking it lands the
// initial chunk of progress before any practice is done.
const ANALYSIS_ITEM_ID = 2
const MASTER_ITEMS: CheckItem[] = [
  { id: 1, text: "上传真题（至少3套）", done: false },
  { id: 2, text: "运行AI考点分析", done: false },
  { id: 3, text: "查看优先级看板，确认重点考点", done: false },
  { id: 4, text: "完成高频考点的针对性练习", done: false },
  { id: 5, text: "完成第4套限时模拟考试", done: false },
  { id: 6, text: "提交成绩，生成补救计划", done: false },
]
// A fresh per-subject master checklist with the first `doneCount` items checked.
function makeChecklist(doneCount: number): CheckItem[] {
  return MASTER_ITEMS.map((it, idx) => ({ ...it, done: idx < doneCount }))
}

const QUICK_ITEMS: CheckItem[] = [
  { id: 1, text: '复习条件概率笔记', done: false },
  { id: 2, text: '重做第2次练习中的5道错题', done: false },
]

const HOW_STEPS = [
  {
    num: "01",
    title: "Upload & Analyze",
    body: "Drop in your past papers and syllabi. PassMate extracts high-frequency exam topics, scores them by weight, and builds your personalized priority board.",
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
        <path
          d="M14 4v14M8 12l6-8 6 8"
          stroke={LIME}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <rect
          x="4"
          y="20"
          width="20"
          height="4"
          rx="2"
          fill={BLUE}
          fillOpacity=".3"
        />
        <rect x="4" y="20" width="12" height="4" rx="2" fill={BLUE} />
      </svg>
    ),
  },
  {
    num: "02",
    title: "Study with Structure",
    body: "Your Master Checklist guides you step-by-step through the proven 30-day sprint. Add quick tasks as you study. PassMate's AI tutor explains concepts, solves problems, and flags weak spots.",
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
        <rect
          x="4"
          y="4"
          width="20"
          height="20"
          rx="4"
          stroke={BLUE}
          strokeWidth="1.5"
        />
        <path
          d="M9 10h10M9 14h7M9 18h5"
          stroke={WHITE}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeOpacity=".5"
        />
        <circle cx="21" cy="21" r="5" fill={NAVY} />
        <path
          d="M19 21l1.5 1.5L23 19"
          stroke={LIME}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    num: "03",
    title: "Verify & Improve",
    body: "Take a full timed mock exam at the end of each cycle. Submit your score and get an instant remediation plan targeting exactly the gaps that keep you from passing.",
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
        <circle cx="14" cy="14" r="10" stroke={BLUE} strokeWidth="1.5" />
        <path
          d="M14 8v6l4 2"
          stroke={LIME}
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        <path
          d="M9 20l10-4"
          stroke={WHITE}
          strokeWidth="1"
          strokeOpacity=".3"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
]

// ─── Subject data ────────────────────────────────────────────
// A subject stores no manual progress. `completed`/`total` are derived at
// render time from the subject's master checklist (see deriveSubjects), so the
// orbit view and Priority Board always read the same auto-calculated value.
interface Subject {
  name: string
  examDate: string // ISO yyyy-mm-dd
  completed: number
  total: number
  color: string
  archived?: boolean // 手动归档——从星轨主轨道退到背景装饰行星
}

interface SubjectSeed {
  name: string
  examDate: string
  color: string
  archived?: boolean
}

const SUBJECT_COLORS = [
  BLUE,
  "#7ba8ff",
  LIME,
  "rgba(255,255,255,0.4)",
  "#ff9a7a",
  "#c792ea",
  "#ffd43b",
]

const SUBJECTS_DATA: SubjectSeed[] = [
  { name: "Probability & Statistics", examDate: "2026-08-25", color: BLUE },
  { name: "Linear Algebra", examDate: "2026-08-28", color: "#7ba8ff" },
  { name: "Calculus", examDate: "2026-08-22", color: LIME },
  {
    name: "University Physics",
    examDate: "2026-09-01",
    color: "rgba(255,255,255,0.4)",
  },
]

// Prototype starting state: how many master-checklist items each subject has
// already checked off. This is the single source of truth for progress.
const SEED_DONE: Record<string, number> = {
  "Probability & Statistics": 3,
  "Linear Algebra": 2,
  Calculus: 4,
  "University Physics": 1,
}

type Checklists = Record<string, CheckItem[]>

function seedChecklists(seeds: SubjectSeed[]): Checklists {
  const out: Checklists = {}
  for (const s of seeds) out[s.name] = makeChecklist(SEED_DONE[s.name] ?? 0)
  return out
}

// Combine subject seeds with their checklists into render-ready subjects whose
// progress (completed/total) is computed from checked master-checklist items.
function deriveSubjects(
  seeds: SubjectSeed[],
  checklists: Checklists,
): Subject[] {
  return seeds.map((s) => {
    const items = checklists[s.name] ?? MASTER_ITEMS
    return {
      name: s.name,
      examDate: s.examDate,
      color: s.color,
      completed: items.filter((i) => i.done).length,
      total: items.length,
      archived: s.archived,
    }
  })
}

// Days from today until an exam date (rounded, clamped at 0).
function daysUntil(iso: string): number {
  if (!iso) return 0
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  const d = new Date(iso + "T00:00:00")
  return Math.max(0, Math.round((d.getTime() - now.getTime()) / 86400000))
}
// Short display label, e.g. "Aug 25".
function formatExam(iso: string): string {
  if (!iso) return "—"
  return new Date(iso + "T00:00:00").toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  })
}

// Orbit geometry: fewer days-left → closer orbit; radius quantized so
// subjects with similar days-left share a ring.
const ORBIT_MIN_R = 66
const ORBIT_MAX_R = 168
const ELLIPSE_RATIO = 0.5 // strong vertical squash → flat orbital plane seen from afar
// Stars spread across a virtual 300vh tall space. Each layer's container starts
// at top=-100vh and is 300vh tall, so viewport sees the middle third at rest.
// As scroll increases, layers translateY at different rates — the relative
// drift between layers is what sells the depth illusion.
const STARS = Array.from({ length: 160 }, (_, i) => ({
  x: (i * 61.83) % 100,
  // Distribute y across 0–100% of the 300vh virtual space, biased toward
  // the middle third (33–67%) so most stars are initially on screen.
  y: 15 + ((i * 37.51 + i * 0.7) % 70),
  s: 0.6 + ((i * 13) % 8) / 4, // 0.6–2.6px
  o: 0.2 + ((i * 7) % 7) / 14, // 0.2–0.7
  d: (i % 7) * 0.6,
}))

// Orbit radius is computed per-subject by rank (see rOfIndex in
// OrbitalSubjects) so every subject always gets its own ring — this old
// date-quantized version is no longer used.

function OrbitalSubjects({
  subjects,
  onToggleArchive,
}: {
  subjects: Subject[]
  onToggleArchive: (name: string) => void
}) {
  const [view, setView] = useState<"orbit" | "list">("orbit")
  const [active, setActive] = useState<number | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const anglesRef = useRef<number[]>([])
  const velRef = useRef<number[]>([])
  const draggingRef = useRef<number | null>(null)
  const [, setTick] = useState(0)

  // Archived subjects drop out of the interactive orbit entirely and render
  // as small, non-orbiting background planets instead (see below). All the
  // angle/velocity/ring math below only ever sees the active subset, so
  // archiving/un-archiving one doesn't jump everyone else's position.
  const activeSubjects = subjects.filter((s) => !s.archived)
  const archivedSubjects = subjects.filter((s) => s.archived)

  // Keep angle/velocity arrays sized to the current subject list, preserving
  // existing values so planets don't jump when subjects are added/edited.
  if (anglesRef.current.length !== activeSubjects.length) {
    const n = activeSubjects.length
    anglesRef.current = activeSubjects.map(
      (_, i) => anglesRef.current[i] ?? (i * 2 * Math.PI) / (n || 1),
    )
    velRef.current = activeSubjects.map(
      (_, i) =>
        velRef.current[i] ??
        0.0009 * (i % 2 === 0 ? 1 : -1) * (0.6 + (0.4 * ((i * 7) % 5)) / 5),
    )
  }

  // Idle drift
  useEffect(() => {
    if (view !== "orbit") return
    let raf = 0
    const loop = () => {
      anglesRef.current = anglesRef.current.map((a, i) =>
        draggingRef.current === i ? a : a + (velRef.current[i] || 0),
      )
      setTick((t) => (t + 1) % 100000)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [view])

  // Drag along orbit ring
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const i = draggingRef.current
      if (i === null || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const cx = rect.left + rect.width / 2
      const cy = rect.top + rect.height / 2
      anglesRef.current[i] = Math.atan2(
        (e.clientY - cy) / ELLIPSE_RATIO,
        e.clientX - cx,
      )
      setTick((t) => (t + 1) % 100000)
    }
    const onUp = () => {
      draggingRef.current = null
    }
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    return () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
    }
  }, [])

  const dayList = activeSubjects.map((s) => daysUntil(s.examDate))
  // Every active subject gets its own ring, even if two exam dates coincide —
  // rank by days-left (ties broken by original order) and spread ranks
  // evenly across the orbit range, instead of quantizing by date.
  const rankByIndex: number[] = (() => {
    const order = activeSubjects
      .map((_, i) => i)
      .sort((a, b) => dayList[a] - dayList[b] || a - b)
    const ranks: number[] = []
    order.forEach((origIdx, rank) => {
      ranks[origIdx] = rank
    })
    return ranks
  })()
  const n = activeSubjects.length
  const rOfIndex = (idx: number) =>
    n <= 1
      ? (ORBIT_MIN_R + ORBIT_MAX_R) / 2
      : ORBIT_MIN_R + (rankByIndex[idx] / (n - 1)) * (ORBIT_MAX_R - ORBIT_MIN_R)
  const radii = activeSubjects.map((_, i) => rOfIndex(i))
  const AREA = 380
  const labelScale = activeSubjects.length > 4 ? 0.82 : 1 // shrink labels when crowded

  return (
    <div
      style={{
        width: "100%",
        maxWidth: 440,
        position: "relative",
      }}
    >
      {view === "orbit" ? (
        <div
          ref={containerRef}
          style={{ position: "relative", height: AREA, overflow: "visible" }}
        >
          {/* Elliptical orbit trail rings */}
          {radii.map((r) => (
            <div
              key={r}
              style={{
                position: "absolute",
                top: "50%",
                left: "50%",
                width: r * 2,
                height: r * 2 * ELLIPSE_RATIO,
                transform: "translate(-50%, -50%)",
                border: "1px solid rgba(255,255,255,0.07)",
                boxShadow:
                  "0 0 15px rgba(255,255,255,0.02) inset, 0 0 15px rgba(255,255,255,0.02)",
                borderRadius: "50%",
                pointerEvents: "none",
              }}
            />
          ))}

          {/* Center "today" node */}
          <div
            style={{
              position: "absolute",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
              width: 48,
              height: 48,
              borderRadius: "50%",
              background: "rgba(255,255,255,0.1)",
              border: "1.5px solid rgba(255,255,255,0.25)",
              boxShadow: "0 0 20px rgba(255,255,255,0.08)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              pointerEvents: "none",
            }}
          >
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 8,
                color: "rgba(255,255,255,0.6)",
                letterSpacing: "0.06em",
              }}
            >
              TODAY
            </span>
            <span
              style={{
                fontFamily: "var(--font-sans)",
                fontSize: 12,
                fontWeight: 700,
                color: WHITE,
              }}
            >
              D-0
            </span>
          </div>

          {/* Planets */}
          {activeSubjects.map((s, i) => {
            const daysLeft = daysUntil(s.examDate)
            const pct = s.total
              ? Math.round(((s.completed || 0) / s.total) * 100)
              : 0
            const p = Number.isFinite(pct) ? pct / 100 : 0
            const r = rOfIndex(i)
            const angleRaw = anglesRef.current[i]
            const angle = Number.isFinite(angleRaw)
              ? angleRaw
              : (i * 2 * Math.PI) / (activeSubjects.length || 1)
            const x = Math.cos(angle) * r
            const y = Math.sin(angle) * r * ELLIPSE_RATIO
            // Dramatic contrast: dim little moons (~7px) → bright large planets (~44px)
            const size = 7 + Math.pow(Number.isFinite(p) ? p : 0, 1.7) * 37
            const halo = size * (1.6 + p * 1.4) // glow radius grows with progress
            const bright = 0.78 + p * 0.22 // keep low-progress planets readable
            const isActive = active === i
            // Persistent label: offset radially outward (into the emptiest space)
            const len = Math.hypot(x, y) || 1
            const ux = x / len,
              uy = y / len
            const gap = size / 2 + 14
            const labelAlignX = ux >= 0 ? "0" : "-100%"
            const connAngle = Math.atan2(uy, ux)
            return (
              <div
                key={s.name}
                onPointerDown={(e) => {
                  draggingRef.current = i
                  setActive(i)
                  ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
                }}
                onDoubleClick={() => onToggleArchive(s.name)}
                title="Double-click to archive"
                style={{
                  position: "absolute",
                  top: "50%",
                  left: "50%",
                  transform: `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`,
                  cursor: "grab",
                  zIndex: isActive ? 30 : 10,
                }}
              >
                {/* Connector line from planet outward to label */}
                <div
                  style={{
                    position: "absolute",
                    left: "50%",
                    top: "50%",
                    width: gap,
                    height: 1.5,
                    background: "rgba(255,255,255,0.25)",
                    transformOrigin: "0 50%",
                    transform: `rotate(${connAngle}rad)`,
                    pointerEvents: "none",
                  }}
                />
                {/* Soft halo */}
                <div
                  style={{
                    position: "absolute",
                    top: "50%",
                    left: "50%",
                    transform: "translate(-50%,-50%)",
                    width: halo,
                    height: halo,
                    borderRadius: "50%",
                    background: `radial-gradient(circle, ${s.color} 0%, transparent 68%)`,
                    opacity: (0.3 + p * 0.5) * (isActive ? 1.4 : 1),
                    filter: "blur(2px)",
                    pointerEvents: "none",
                    transition: "opacity 0.2s",
                  }}
                />
                {/* Planet body — bright core fading outward */}
                <div
                  style={{
                    position: "relative",
                    width: size,
                    height: size,
                    borderRadius: "50%",
                    background: `radial-gradient(circle at 34% 30%, #ffffff 0%, ${s.color} 42%, ${s.color} 72%, rgba(0,0,0,0.35) 100%)`,
                    boxShadow: `0 0 ${halo * 0.55}px ${s.color}, inset -2px -2px 4px rgba(0,0,0,0.35)`,
                    opacity: bright,
                    outline: isActive ? `2px solid ${s.color}55` : "none",
                    outlineOffset: 3,
                    transition: "box-shadow 0.2s, outline 0.2s",
                  }}
                />
                {/* Persistent label */}
                <div
                  style={{
                    position: "absolute",
                    left: "50%",
                    top: "50%",
                    transform: `translate(${ux * gap}px, ${uy * gap}px) translate(${labelAlignX}, -50%)`,
                    padding: `${6 * labelScale}px ${9 * labelScale}px`,
                    whiteSpace: "nowrap",
                    background: `${NAVY}f2`,
                    border: "1px solid rgba(255,255,255,0.12)",
                    borderRadius: 9,
                    boxShadow: "0 6px 18px rgba(0,0,0,0.4)",
                    pointerEvents: "none",
                  }}
                >
                  <div
                    style={{
                      fontSize: 11.5 * labelScale,
                      fontWeight: 600,
                      color: WHITE,
                      marginBottom: 3,
                    }}
                  >
                    {s.name}
                  </div>
                  <div
                    style={{ display: "flex", gap: 8, alignItems: "center" }}
                  >
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 9 * labelScale,
                        color:
                          daysLeft <= 24 ? "#ff9a7a" : "rgba(255,255,255,0.5)",
                      }}
                    >
                      {formatExam(s.examDate)}
                    </span>
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 9 * labelScale,
                        color: LIME,
                      }}
                    >
                      {pct}%
                    </span>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <div style={{ padding: "8px 0" }}>
          {subjects.map((s, i) => {
            const daysLeft = daysUntil(s.examDate)
            const pct = s.total ? Math.round((s.completed / s.total) * 100) : 0
            return (
              <div
                key={s.name}
                style={{
                  padding: "14px 24px",
                  borderBottom:
                    i < subjects.length - 1
                      ? "1px solid rgba(255,255,255,0.04)"
                      : "none",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "flex-start",
                    marginBottom: 10,
                  }}
                >
                  <div>
                    <div
                      style={{
                        fontSize: 13,
                        fontWeight: 600,
                        color: WHITE,
                        marginBottom: 3,
                      }}
                    >
                      {s.name}
                    </div>
                  </div>
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    <div
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 15,
                        fontWeight: 700,
                        color:
                          daysLeft <= 24 ? "#ff9a7a" : "rgba(255,255,255,0.6)",
                        lineHeight: 1,
                      }}
                    >
                      {formatExam(s.examDate)}
                    </div>
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div
                    style={{
                      flex: 1,
                      height: 3,
                      background: "rgba(255,255,255,0.07)",
                      borderRadius: 2,
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        height: "100%",
                        width: `${pct}%`,
                        background: s.color,
                        borderRadius: 2,
                        transition: "width 0.8s cubic-bezier(0.4,0,0.2,1)",
                      }}
                    />
                  </div>
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 9,
                      color: "rgba(255,255,255,0.3)",
                      minWidth: 32,
                      textAlign: "right",
                    }}
                  >
                    {s.completed}/{s.total}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Archived subjects — tucked into a small corner icon instead of a
          full-width box; click to expand a popover with the chip list. */}
      {archivedSubjects.length > 0 && (
        <div style={{ position: "absolute", top: 0, right: 0, zIndex: 40 }}>
          <button
            onClick={() => setShowArchived((v) => !v)}
            title="Archived subjects"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              padding: "5px 9px",
              background: showArchived
                ? "rgba(255,255,255,0.08)"
                : "rgba(255,255,255,0.03)",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 100,
              cursor: "pointer",
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
              <path
                d="M3 7h18M5 7v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V7M9 11h6"
                stroke="rgba(255,255,255,0.5)"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                color: "rgba(255,255,255,0.45)",
              }}
            >
              {archivedSubjects.length}
            </span>
          </button>

          {showArchived && (
            <div
              style={{
                position: "absolute",
                top: "calc(100% + 8px)",
                right: 0,
                minWidth: 180,
                padding: "10px 12px",
                background: "#10191f",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 10,
                boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
              }}
            >
              <div
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 9,
                  color: "rgba(255,255,255,0.3)",
                  letterSpacing: "0.06em",
                  marginBottom: 8,
                }}
              >
                ARCHIVED
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {archivedSubjects.map((s) => {
                  const pct = s.total
                    ? Math.round(((s.completed || 0) / s.total) * 100)
                    : 0
                  return (
                    <button
                      key={s.name}
                      onClick={() => onToggleArchive(s.name)}
                      title="Click to restore to orbit"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "5px 8px",
                        background: "rgba(255,255,255,0.03)",
                        border: "1px solid rgba(255,255,255,0.08)",
                        borderRadius: 8,
                        cursor: "pointer",
                        whiteSpace: "nowrap",
                      }}
                    >
                      <span
                        style={{
                          width: 7,
                          height: 7,
                          borderRadius: "50%",
                          background: s.color,
                          opacity: 0.7,
                          flexShrink: 0,
                        }}
                      />
                      <span style={{ fontSize: 11.5, color: "rgba(255,255,255,0.6)" }}>
                        {s.name}
                      </span>
                      <span
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: 9.5,
                          color: "rgba(255,255,255,0.3)",
                          marginLeft: "auto",
                        }}
                      >
                        {pct}%
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function HeroIllustration({
  subjects,
  onToggleArchive,
}: {
  subjects: Subject[]
  onToggleArchive: (name: string) => void
}) {
  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {/* Ambient glow behind card */}
      <div
        style={{
          position: "absolute",
          top: "15%",
          left: "5%",
          width: 380,
          height: 380,
          background: `radial-gradient(circle, ${BLUE}35 0%, transparent 70%)`,
          borderRadius: "50%",
          filter: "blur(54px)",
          animation: "pulse1 6s ease-in-out infinite",
          pointerEvents: "none",
        }}
      />
      <div
        style={{
          position: "absolute",
          bottom: "-5%",
          right: "-5%",
          width: 240,
          height: 240,
          background: `radial-gradient(circle, ${LIME}25 0%, transparent 70%)`,
          borderRadius: "50%",
          filter: "blur(40px)",
          animation: "pulse2 8s ease-in-out infinite",
          pointerEvents: "none",
        }}
      />
      <OrbitalSubjects subjects={subjects} onToggleArchive={onToggleArchive} />
      <style>{`
        @keyframes pulse1 { 0%,100%{opacity:.4;transform:scale(1)} 50%{opacity:.7;transform:scale(1.06)} }
        @keyframes pulse2 { 0%,100%{opacity:.3;transform:scale(1)} 50%{opacity:.55;transform:scale(1.1)} }
        @keyframes slideIn { from{transform:translateX(100%);opacity:0} to{transform:translateX(0);opacity:1} }
        @keyframes checkIn { from{transform:scale(0) rotate(-10deg);opacity:0} to{transform:scale(1) rotate(0deg);opacity:1} }
        @keyframes revealUp { from{opacity:0;transform:translateY(36px)} to{opacity:1;transform:translateY(0)} }
        @keyframes twinkle { 0%,100%{opacity:.15} 50%{opacity:.55} }
      `}</style>
    </div>
  )
}

// ─── Nav ─────────────────────────────────────────────────────
function Nav({
  subjects,
  active,
  onSelect,
}: {
  subjects: Subject[]
  active: string
  onSelect: (s: string) => void
}) {
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const el = document.getElementById("page-scroll")
    if (!el) return
    const onScroll = () => setScrolled(el.scrollTop > 24)
    el.addEventListener("scroll", onScroll)
    return () => el.removeEventListener("scroll", onScroll)
  }, [])

  return (
    <nav
      style={{
        position: "sticky",
        top: 0,
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 80px",
        height: 64,
        background: scrolled ? `${NAVY}e0` : "transparent",
        backdropFilter: scrolled ? "blur(16px)" : "none",
        borderBottom: scrolled
          ? "1px solid rgba(255,255,255,0.06)"
          : "1px solid transparent",
        transition: "all 0.3s ease",
      }}
    >
      {/* Logo */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: 7,
            background: `linear-gradient(135deg, ${BLUE}, ${BLUE}80)`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M7 2L12 11H2L7 2Z" fill={WHITE} fillOpacity=".9" />
          </svg>
        </div>
        <span
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: 17,
            fontWeight: 700,
            color: WHITE,
            letterSpacing: "-0.02em",
          }}
        >
          PassMate
        </span>
      </div>

      {/* Right: subject switcher + settings */}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {/* Subject switcher pill */}
        <div
          style={{
            position: "relative",
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "7px 12px 7px 14px",
            borderRadius: 100,
            background: "rgba(255,255,255,0.05)",
            border: "1px solid rgba(255,255,255,0.12)",
          }}
        >
          <div
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: LIME,
              flexShrink: 0,
            }}
          />
          <span
            style={{
              fontFamily: "var(--font-body)",
              fontSize: 13,
              fontWeight: 500,
              color: WHITE,
              whiteSpace: "nowrap",
            }}
          >
            {active}
          </span>
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            style={{ flexShrink: 0 }}
          >
            <path
              d="M2 3.5L5 6.5L8 3.5"
              stroke="rgba(255,255,255,0.5)"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <select
            value={active}
            onChange={(e) => onSelect(e.target.value)}
            aria-label="Switch subject"
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              opacity: 0,
              cursor: "pointer",
              appearance: "none",
            }}
          >
            {subjects.map((s) => (
              <option key={s.name} value={s.name} style={{ background: NAVY }}>
                {s.name}
              </option>
            ))}
          </select>
        </div>

        {/* Settings (placeholder) */}
        <button
          aria-label="Settings"
          title="Settings"
          style={{
            width: 36,
            height: 36,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(255,255,255,0.05)",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 9,
            cursor: "pointer",
            transition: "all 0.15s",
          }}
          onMouseEnter={(e) =>
            (e.currentTarget.style.borderColor = "rgba(255,255,255,0.28)")
          }
          onMouseLeave={(e) =>
            (e.currentTarget.style.borderColor = "rgba(255,255,255,0.12)")
          }
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
            <circle
              cx="12"
              cy="12"
              r="3"
              stroke="rgba(255,255,255,0.65)"
              strokeWidth="1.6"
            />
            <path
              d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
              stroke="rgba(255,255,255,0.65)"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
    </nav>
  )
}

// ─── Dual Checklist Panel ────────────────────────────────────
function ChecklistPanel({
  subject,
  quickItems,
  onQuickChange,
  notes,
  onNotesChange,
}: {
  subject: Subject | undefined
  quickItems: CheckItem[]
  onQuickChange: (next: CheckItem[]) => void
  notes: string
  onNotesChange: (v: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<"quick" | "notes">("quick")
  const [newTask, setNewTask] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)

  const toggleQuick = (id: number) => {
    onQuickChange(
      quickItems.map((i) => (i.id === id ? { ...i, done: !i.done } : i)),
    )
  }
  const removeQuick = (id: number) => {
    onQuickChange(quickItems.filter((i) => i.id !== id))
  }
  const addQuick = () => {
    if (!newTask.trim()) return
    onQuickChange([
      ...quickItems,
      { id: Date.now(), text: newTask.trim(), done: false },
    ])
    setNewTask("")
  }

  const quickDone = quickItems.filter((i) => i.done).length
  const hasNotes = notes.trim().length > 0

  return (
    <div
      style={{
        position: "fixed",
        right: 0,
        top: "50%",
        transform: "translateY(-50%)",
        zIndex: 200,
        display: "flex",
        alignItems: "center",
      }}
    >
      {/* Collapsed pill */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 6,
            padding: "16px 10px",
            background: `${NAVY}f0`,
            backdropFilter: "blur(20px)",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRight: "none",
            borderRadius: "12px 0 0 12px",
            cursor: "pointer",
            boxShadow: `-4px 0 24px rgba(0,0,0,0.4)`,
            transition: "all 0.2s",
          }}
          onMouseEnter={(e) =>
            (e.currentTarget.style.borderColor = `${BLUE}50`)
          }
          onMouseLeave={(e) =>
            (e.currentTarget.style.borderColor = "rgba(255,255,255,0.1)")
          }
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path
              d="M2 3h10M2 7h7M2 11h4"
              stroke={BLUE}
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 9,
              color: "rgba(255,255,255,0.5)",
              letterSpacing: "0.06em",
              writingMode: "vertical-rl",
              textOrientation: "mixed",
              transform: "rotate(180deg)",
            }}
          >
            CHECKLIST
          </span>
          <div
            style={{
              width: 20,
              height: 20,
              borderRadius: "50%",
              background: BLUE,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 9,
              fontWeight: 700,
              color: WHITE,
              fontFamily: "var(--font-mono)",
            }}
          >
            {quickDone}
          </div>
        </button>
      )}

      {/* Expanded panel */}
      {open && (
        <div
          style={{
            width: 340,
            background: `${NAVY}f5`,
            backdropFilter: "blur(24px)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRight: "none",
            borderRadius: "16px 0 0 16px",
            boxShadow: "-8px 0 48px rgba(0,0,0,0.5)",
            animation: "slideIn 0.25s ease-out",
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
            maxHeight: "80vh",
          }}
        >
          {/* Panel header */}
          <div style={{ padding: "18px 20px 0", flexShrink: 0 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                marginBottom: 14,
              }}
            >
              <div>
                <span
                  style={{
                    fontFamily: "var(--font-sans)",
                    fontSize: 13,
                    fontWeight: 700,
                    color: WHITE,
                    display: "block",
                  }}
                >
                  Sprint Checklist
                </span>
                {subject && (
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 9,
                      color: LIME,
                      letterSpacing: "0.06em",
                    }}
                  >
                    {subject.name.toUpperCase()} ·{" "}
                    {subject.total
                      ? Math.round((subject.completed / subject.total) * 100)
                      : 0}
                    %
                  </span>
                )}
              </div>
              <button
                onClick={() => setOpen(false)}
                style={{
                  width: 24,
                  height: 24,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "rgba(255,255,255,0.06)",
                  border: "1px solid rgba(255,255,255,0.08)",
                  borderRadius: 6,
                  cursor: "pointer",
                  color: "rgba(255,255,255,0.5)",
                  fontSize: 14,
                  transition: "all 0.15s",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.color = WHITE)}
                onMouseLeave={(e) =>
                  (e.currentTarget.style.color = "rgba(255,255,255,0.5)")
                }
              >
                ×
              </button>
            </div>

            {/* Tabs */}
            <div
              style={{
                display: "flex",
                background: "rgba(255,255,255,0.04)",
                borderRadius: 8,
                padding: 3,
              }}
            >
              {([
                {
                  id: "quick",
                  label: `Quick (${quickDone}/${quickItems.length})`,
                },
                { id: "notes", label: hasNotes ? "Notes ●" : "Notes" },
              ] as const).map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  style={{
                    flex: 1,
                    padding: "6px 0",
                    background:
                      tab === t.id ? "rgba(255,255,255,0.08)" : "transparent",
                    border: "none",
                    borderRadius: 6,
                    color: tab === t.id ? WHITE : "rgba(255,255,255,0.4)",
                    fontSize: 11,
                    fontWeight: tab === t.id ? 600 : 400,
                    fontFamily: "var(--font-body)",
                    cursor: "pointer",
                    transition: "all 0.15s",
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {/* Items */}
          <div
            className="scrollable"
            style={{ flex: 1, overflowY: "auto", padding: "12px 16px 8px" }}
          >
            {tab === "notes" ? (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  height: "100%",
                }}
              >
                <div
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 9,
                    color: "rgba(255,255,255,0.3)",
                    letterSpacing: "0.08em",
                    marginBottom: 4,
                  }}
                >
                  MY REVIEW NOTES ·{" "}
                  {subject?.name?.toUpperCase() ?? "NO SUBJECT"}
                </div>
                <textarea
                  value={notes}
                  onChange={(e) => onNotesChange(e.target.value)}
                  placeholder={
                    "Jot down anything from your session — mistakes, insights, formulas to remember…"
                  }
                  style={{
                    flex: 1,
                    minHeight: 220,
                    resize: "none",
                    background: "rgba(255,255,255,0.03)",
                    border: "1px solid rgba(255,255,255,0.08)",
                    borderRadius: 10,
                    padding: "12px 14px",
                    color: "rgba(255,255,255,0.85)",
                    fontSize: 12.5,
                    fontFamily: "var(--font-body)",
                    lineHeight: 1.65,
                    outline: "none",
                    transition: "border-color 0.15s",
                  }}
                  onFocus={(e) => (e.target.style.borderColor = `${BLUE}50`)}
                  onBlur={(e) =>
                    (e.target.style.borderColor = "rgba(255,255,255,0.08)")
                  }
                />
                {notes.trim() && (
                  <div
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 9,
                      color: "rgba(255,255,255,0.2)",
                      textAlign: "right",
                    }}
                  >
                    {notes.trim().split(/\s+/).length} words · auto-saved
                  </div>
                )}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 9,
                    color: "rgba(255,255,255,0.3)",
                    letterSpacing: "0.08em",
                    marginBottom: 4,
                  }}
                >
                  YOUR TASKS · ADD & REMOVE FREELY
                </div>
                {quickItems.length === 0 && (
                  <div
                    style={{
                      padding: "24px",
                      textAlign: "center",
                      border: "1px dashed rgba(255,255,255,0.1)",
                      borderRadius: 8,
                    }}
                  >
                    <div
                      style={{
                        fontSize: 12,
                        color: "rgba(255,255,255,0.25)",
                        lineHeight: 1.6,
                      }}
                    >
                      Add tasks as you study.
                      <br />
                      Quick wins go here.
                    </div>
                  </div>
                )}
                {quickItems.map((item) => (
                  <div
                    key={item.id}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 10,
                      padding: "10px 12px",
                      background: "rgba(255,255,255,0.03)",
                      border: `1px solid ${
                        item.done ? `${LIME}25` : "rgba(255,255,255,0.06)"
                      }`,
                      borderRadius: 8,
                    }}
                  >
                    <div
                      onClick={() => toggleQuick(item.id)}
                      style={{
                        width: 16,
                        height: 16,
                        borderRadius: 4,
                        flexShrink: 0,
                        marginTop: 1,
                        border: `1.5px solid ${
                          item.done ? LIME : "rgba(255,255,255,0.2)"
                        }`,
                        background: item.done ? LIME : "transparent",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        cursor: "pointer",
                        transition: "all 0.2s",
                      }}
                    >
                      {item.done && (
                        <svg width="9" height="7" viewBox="0 0 9 7" fill="none">
                          <path
                            d="M1 3.5L3.5 6 8 1"
                            stroke={NAVY}
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      )}
                    </div>
                    <span
                      style={{
                        flex: 1,
                        fontSize: 12,
                        color: item.done
                          ? "rgba(255,255,255,0.3)"
                          : "rgba(255,255,255,0.8)",
                        textDecoration: item.done ? "line-through" : "none",
                        lineHeight: 1.5,
                        transition: "all 0.2s",
                      }}
                    >
                      {item.text}
                    </span>
                    <button
                      onClick={() => removeQuick(item.id)}
                      style={{
                        width: 20,
                        height: 20,
                        flexShrink: 0,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        background: "rgba(255,255,255,0.04)",
                        border: "1px solid rgba(255,255,255,0.06)",
                        borderRadius: 4,
                        cursor: "pointer",
                        color: "rgba(255,255,255,0.3)",
                        fontSize: 12,
                        transition: "all 0.15s",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.color = "#ff6b6b"
                        e.currentTarget.style.borderColor = "#ff6b6b40"
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.color = "rgba(255,255,255,0.3)"
                        e.currentTarget.style.borderColor =
                          "rgba(255,255,255,0.06)"
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Add task (Quick tab only) */}
          {tab === "quick" && (
            <div
              style={{
                padding: "8px 16px 16px",
                flexShrink: 0,
                borderTop: "1px solid rgba(255,255,255,0.05)",
              }}
            >
              <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                <input
                  ref={inputRef}
                  value={newTask}
                  onChange={(e) => setNewTask(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addQuick()}
                  placeholder="Add a quick task..."
                  style={{
                    flex: 1,
                    padding: "8px 12px",
                    background: "rgba(255,255,255,0.04)",
                    border: "1px solid rgba(255,255,255,0.08)",
                    borderRadius: 7,
                    fontSize: 12,
                    fontFamily: "var(--font-body)",
                    color: WHITE,
                    outline: "none",
                    transition: "border-color 0.15s",
                  }}
                  onFocus={(e) => (e.target.style.borderColor = `${BLUE}60`)}
                  onBlur={(e) =>
                    (e.target.style.borderColor = "rgba(255,255,255,0.08)")
                  }
                />
                <button
                  onClick={addQuick}
                  style={{
                    padding: "8px 12px",
                    borderRadius: 7,
                    border: "none",
                    background: BLUE,
                    color: WHITE,
                    fontSize: 12,
                    fontWeight: 600,
                    fontFamily: "var(--font-body)",
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                    transition: "opacity 0.15s",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.85")}
                  onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}
                >
                  Add
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Hero ─────────────────────────────────────────────────────
function Hero({
  subjects,
  onSave,
  onToggleArchive,
}: {
  subjects: Subject[]
  onSave: (s: SubjectSeed[]) => void
  onToggleArchive: (name: string) => void
}) {
  const [query, setQuery] = useState("")
  const [modalOpen, setModalOpen] = useState(false)
  const [focused, setFocused] = useState(false)

  return (
    <section
      style={{
        minHeight: "calc(100vh - 64px)",
        display: "flex",
        alignItems: "center",
        padding: "80px 80px 60px",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* Background glow */}
      <div
        style={{
          position: "absolute",
          top: "-20%",
          left: "30%",
          width: 600,
          height: 600,
          background: `radial-gradient(circle, ${BLUE}30 0%, transparent 70%)`,
          pointerEvents: "none",
        }}
      />
      <div
        style={{
          position: "absolute",
          bottom: "-10%",
          right: "20%",
          width: 400,
          height: 400,
          background: `radial-gradient(circle, ${LIME}15 0%, transparent 70%)`,
          pointerEvents: "none",
        }}
      />

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(320px, 400px) 1fr",
          gap: 64,
          alignItems: "center",
          width: "100%",
          maxWidth: 1280,
        }}
      >
        {/* Left: Claude-style minimal composer */}
        <div style={{ maxWidth: 360, marginTop: 96 }}>
          {/* Small headline */}
          <h1
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: 23,
              fontWeight: 600,
              lineHeight: 1.35,
              letterSpacing: "-0.02em",
              color: WHITE,
              margin: "0 0 20px",
            }}
          >
            one focused sprint at a time
            <br />
            for PassMate.
          </h1>

          {/* Composer — single-row */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              background: "rgba(255,255,255,0.04)",
              border: `1px solid ${
                focused ? `${BLUE}55` : "rgba(255,255,255,0.1)"
              }`,
              borderRadius: 14,
              padding: "8px 8px 8px 16px",
              transition: "border-color 0.2s",
            }}
          >
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  setModalOpen(true)
                }
              }}
              placeholder="What do you want to do?"
              style={{
                flex: 1,
                minWidth: 0,
                background: "transparent",
                border: "none",
                outline: "none",
                color: WHITE,
                fontSize: 15,
                lineHeight: 1.5,
                fontFamily: "var(--font-body)",
              }}
            />
            <button
              onClick={() => setModalOpen(true)}
              aria-label="Add my exams"
              style={{
                flexShrink: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 34,
                height: 34,
                borderRadius: 10,
                background: BLUE,
                border: "none",
                color: WHITE,
                cursor: "pointer",
                transition: "opacity 0.15s, transform 0.1s",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.88")}
              onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 19V5M5 12l7-7 7 7" />
              </svg>
            </button>
          </div>
        </div>

        {/* Right: illustration */}
        <div
          style={{
            position: "relative",
            height: 700,
            marginTop: -40,
            transform: "scale(1.32)",
            transformOrigin: "center top",
          }}
        >
          <HeroIllustration subjects={subjects} onToggleArchive={onToggleArchive} />
        </div>
      </div>

      {modalOpen && (
        <ExamModal
          subjects={subjects}
          onClose={() => setModalOpen(false)}
          onSave={(next) => {
            onSave(next)
            setModalOpen(false)
          }}
        />
      )}
    </section>
  )
}

// ─── Exam schedule modal ──────────────────────────────────────
interface ExamRow {
  name: string
  examDate: string
}

function ExamModal({
  subjects,
  onClose,
  onSave,
}: {
  subjects: Subject[]
  onClose: () => void
  onSave: (s: SubjectSeed[]) => void
}) {
  // Seed from existing entries so it works for both setup and later editing.
  const [rows, setRows] = useState<ExamRow[]>(
    subjects.length
      ? subjects.map((s) => ({ name: s.name, examDate: s.examDate }))
      : [{ name: "", examDate: "" }],
  )

  const update = (i: number, patch: Partial<ExamRow>) =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  const addRow = () => setRows((rs) => [...rs, { name: "", examDate: "" }])
  const removeRow = (i: number) =>
    setRows((rs) => rs.filter((_, idx) => idx !== i))

  const save = () => {
    const prev = new Map(subjects.map((s) => [s.name, s]))
    // Emit seeds only — progress is never entered here; it's derived from each
    // subject's checklist. New subjects start at 0% until analysis/tasks are done.
    const next: SubjectSeed[] = rows
      .filter((r) => r.name.trim() && r.examDate)
      .map((r, i) => {
        const existing = prev.get(r.name.trim())
        return {
          name: r.name.trim(),
          examDate: r.examDate,
          color: existing?.color ?? SUBJECT_COLORS[i % SUBJECT_COLORS.length],
        }
      })
    onSave(next)
  }

  const canSave = rows.some((r) => r.name.trim() && r.examDate)
  const inputStyle = {
    padding: "10px 12px",
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: 9,
    color: WHITE,
    fontSize: 13,
    fontFamily: "var(--font-body)",
    outline: "none",
  } as const

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 500,
        background: "rgba(6,10,14,0.7)",
        backdropFilter: "blur(6px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 520,
          maxHeight: "85vh",
          display: "flex",
          flexDirection: "column",
          background: `${NAVY}`,
          border: "1px solid rgba(255,255,255,0.1)",
          borderRadius: 18,
          boxShadow: "0 24px 80px rgba(0,0,0,0.6)",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "22px 24px 18px",
            borderBottom: "1px solid rgba(255,255,255,0.07)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
          }}
        >
          <div>
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                color: BLUE,
                letterSpacing: "0.1em",
                marginBottom: 6,
              }}
            >
              EXAM SCHEDULE
            </div>
            <h3
              style={{
                fontFamily: "var(--font-sans)",
                fontSize: 20,
                fontWeight: 700,
                color: WHITE,
                margin: 0,
              }}
            >
              Add your exams
            </h3>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              width: 28,
              height: 28,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "rgba(255,255,255,0.06)",
              border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 7,
              cursor: "pointer",
              color: "rgba(255,255,255,0.6)",
              fontSize: 16,
            }}
          >
            ×
          </button>
        </div>

        {/* Rows */}
        <div
          className="scrollable"
          style={{ padding: "18px 24px", overflowY: "auto", flex: 1 }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 150px 32px",
              gap: 10,
              marginBottom: 8,
              paddingLeft: 2,
            }}
          >
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 9,
                color: "rgba(255,255,255,0.3)",
                letterSpacing: "0.06em",
              }}
            >
              SUBJECT
            </div>
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 9,
                color: "rgba(255,255,255,0.3)",
                letterSpacing: "0.06em",
              }}
            >
              EXAM DATE
            </div>
            <div />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {rows.map((r, i) => (
              <div
                key={i}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 150px 32px",
                  gap: 10,
                  alignItems: "center",
                }}
              >
                <input
                  value={r.name}
                  onChange={(e) => update(i, { name: e.target.value })}
                  placeholder="e.g. Calculus"
                  style={inputStyle}
                  onFocus={(e) => (e.target.style.borderColor = `${BLUE}60`)}
                  onBlur={(e) =>
                    (e.target.style.borderColor = "rgba(255,255,255,0.1)")
                  }
                />
                <input
                  type="date"
                  value={r.examDate}
                  onChange={(e) => update(i, { examDate: e.target.value })}
                  style={{ ...inputStyle, colorScheme: "dark" }}
                  onFocus={(e) => (e.target.style.borderColor = `${BLUE}60`)}
                  onBlur={(e) =>
                    (e.target.style.borderColor = "rgba(255,255,255,0.1)")
                  }
                />
                <button
                  onClick={() => removeRow(i)}
                  disabled={rows.length === 1}
                  aria-label="Remove subject"
                  style={{
                    width: 32,
                    height: 32,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: "rgba(255,255,255,0.04)",
                    border: "1px solid rgba(255,255,255,0.08)",
                    borderRadius: 8,
                    cursor: rows.length === 1 ? "default" : "pointer",
                    color: "rgba(255,255,255,0.35)",
                    fontSize: 15,
                    opacity: rows.length === 1 ? 0.3 : 1,
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>

          <button
            onClick={addRow}
            style={{
              marginTop: 14,
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              padding: "9px 14px",
              background: "transparent",
              border: "1px dashed rgba(255,255,255,0.18)",
              borderRadius: 9,
              color: "rgba(255,255,255,0.65)",
              fontSize: 13,
              fontFamily: "var(--font-body)",
              cursor: "pointer",
              transition: "all 0.15s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = `${BLUE}60`
              e.currentTarget.style.color = WHITE
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = "rgba(255,255,255,0.18)"
              e.currentTarget.style.color = "rgba(255,255,255,0.65)"
            }}
          >
            <span style={{ fontSize: 15, lineHeight: 1 }}>+</span> Add another
            subject
          </button>

          <div
            style={{
              marginTop: 18,
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
              fontFamily: "var(--font-body)",
              fontSize: 12,
              color: "rgba(255,255,255,0.35)",
              lineHeight: 1.6,
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 14 14"
              fill="none"
              style={{ flexShrink: 0, marginTop: 2 }}
            >
              <circle
                cx="7"
                cy="7"
                r="5.5"
                stroke={LIME}
                strokeWidth="1.2"
                strokeOpacity="0.7"
              />
              <path
                d="M7 6.2v3M7 4.6v.05"
                stroke={LIME}
                strokeWidth="1.2"
                strokeLinecap="round"
              />
            </svg>
            Progress is tracked automatically — each subject starts at 0% and
            fills in as you run the exam-point analysis and check off Sprint
            Checklist items.
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "16px 24px",
            borderTop: "1px solid rgba(255,255,255,0.07)",
            display: "flex",
            justifyContent: "flex-end",
            gap: 10,
          }}
        >
          <button
            onClick={onClose}
            style={{
              padding: "10px 18px",
              borderRadius: 9,
              background: "transparent",
              border: "1px solid rgba(255,255,255,0.14)",
              color: "rgba(255,255,255,0.7)",
              fontSize: 13,
              fontFamily: "var(--font-body)",
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={!canSave}
            style={{
              padding: "10px 24px",
              borderRadius: 9,
              border: "none",
              background: canSave ? WHITE : "rgba(255,255,255,0.15)",
              color: canSave ? NAVY : "rgba(255,255,255,0.4)",
              fontSize: 13,
              fontWeight: 700,
              fontFamily: "var(--font-sans)",
              cursor: canSave ? "pointer" : "default",
              transition: "opacity 0.15s",
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── How it works ─────────────────────────────────────────────
// Category tabs, each showing a showcase card with an example prompt and the
// study artifact it produces — mirrors a prompt-library layout.
// The three AI apps + the schedule view. Each tab's black card carries an
// action button that opens the matching page.
const USE_TABS = [
  {
    id: "analyze",
    label: "Analyze",
    icon: (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
        <path
          d="M2 13V9M6 13V4M10 13V7M14 13V2"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    ),
    prompt:
      "Upload your papers and PassMate distills the essential exam points from the last three years.",
    title: "Probability & Statistics exam-point breakdown",
    cta: "Import photos",
  },
  {
    id: "assistant",
    label: "AI Solver",
    icon: (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
        <path
          d="M8 1.5l1.1 3.5L12.5 4l-2.2 2.8L13 8l-3.5.3L10 12l-2-2.9L6 12l.2-3.7L3 8l2.7-1.2L3.5 4l3.4 1L8 1.5z"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
      </svg>
    ),
    prompt:
      "Stuck on a question? Snap a photo or type it out and solve it step by step with the AI tutor in full screen.",
    title: "Step-by-step problem walkthrough",
    cta: "Open AI Solver →",
  },
  {
    id: "prompt",
    label: "Prompt Center",
    icon: (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
        <path
          d="M3 4l3 4-3 4M8 12h5"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
    prompt:
      "Generate the perfect study prompt for any subject, stage and topic — ready to paste straight into your AI chat.",
    title: "Session-ready study prompts",
    cta: "Open Prompt Center →",
  },
  {
    id: "schedule",
    label: "My Schedule",
    icon: (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
        <rect
          x="2.5"
          y="3"
          width="11"
          height="10.5"
          rx="1.5"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path
          d="M2.5 6h11M5.5 1.8v2M10.5 1.8v2"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    ),
    prompt:
      "See every subject, when each exam falls, and exactly how far along your revision is — all in one list.",
    title: "Exam schedule & revision progress",
    cta: "View my schedule →",
  },
] as const

function HowItWorks({
  onAction,
  tab,
  setTab,
}: {
  onAction: (id: string) => void
  tab: number
  setTab: (i: number) => void
}) {
  const { ref, visible } = useReveal()
  const active = USE_TABS[tab]
  const isAnalyze = active.id === "analyze"

  return (
    <section
      ref={ref}
      style={{
        padding: "100px 80px",
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(40px)",
        transition: "opacity 0.7s ease, transform 0.7s ease",
      }}
    >
      <div style={{ maxWidth: 900, margin: "0 auto" }}>
        {/* Centered icon */}
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            marginBottom: 24,
          }}
        >
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              background: `${BLUE}18`,
              border: `1px solid ${BLUE}35`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#7ba8ff",
            }}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
              <path
                d="M12 2l1.6 5.2L19 6l-3.4 4.2L20 13l-5.3.4L15 19l-3-4.3L9 19l.3-5.6L4 13l4.4-2.8L5 6l5.4 1.2L12 2z"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        </div>

        {/* Centered heading */}
        <h2
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: 60,
            fontWeight: 800,
            letterSpacing: "-0.03em",
            color: WHITE,
            margin: "0 0 120px",
            lineHeight: 1.05,
            textAlign: "center",
          }}
        >
          How you can use PassMate
        </h2>

        {/* Category tabs — left-aligned inside a white pill frame */}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-start",
            marginBottom: 44,
          }}
        >
          <div
            style={{
              display: "inline-flex",
              flexWrap: "wrap",
              gap: 3,
              padding: 4,
              background: WHITE,
              border: "1px solid rgba(255,255,255,0.14)",
              borderRadius: 100,
              boxShadow: "0 8px 30px rgba(0,0,0,0.25)",
            }}
          >
            {USE_TABS.map((t, i) => {
              const on = tab === i
              return (
                <button
                  key={t.id}
                  onClick={() => setTab(i)}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "6px 12px",
                    borderRadius: 100,
                    border: "none",
                    background: on ? NAVY : "transparent",
                    color: on ? WHITE : "rgba(12,20,25,0.5)",
                    fontFamily: "var(--font-body)",
                    fontSize: 12,
                    fontWeight: on ? 600 : 500,
                    cursor: "pointer",
                    transition: "all 0.15s",
                  }}
                  onMouseEnter={(e) => {
                    if (!on) e.currentTarget.style.color = "rgba(12,20,25,0.85)"
                  }}
                  onMouseLeave={(e) => {
                    if (!on) e.currentTarget.style.color = "rgba(12,20,25,0.5)"
                  }}
                >
                  {t.icon}
                  {t.label}
                </button>
              )
            })}
          </div>
        </div>

        {/* Showcase card — slides up + fades in on each tab change */}
        <style>{`
          @keyframes cardSlideUp {
            from { opacity: 0; transform: translateY(48px); }
            to   { opacity: 1; transform: translateY(0); }
          }
        `}</style>
        <div
          key={active.id}
          style={{
            position: "relative",
            overflow: "hidden",
            borderRadius: 24,
            padding: "48px 48px 0",
            minHeight: 340,
            background: `linear-gradient(150deg, ${BLUE} 0%, #204bc4 55%, ${NAVY} 130%)`,
            border: "1px solid rgba(255,255,255,0.1)",
            animation: "cardSlideUp 1.1s cubic-bezier(0.22, 1, 0.36, 1)",
          }}
        >
          {/* Soft orbital arcs in the corner for texture */}
          <div
            style={{
              position: "absolute",
              top: -80,
              right: -60,
              width: 320,
              height: 320,
              borderRadius: "50%",
              border: "1px solid rgba(255,255,255,0.12)",
              pointerEvents: "none",
            }}
          />
          <div
            style={{
              position: "absolute",
              top: -30,
              right: -10,
              width: 200,
              height: 200,
              borderRadius: "50%",
              border: "1px solid rgba(255,255,255,0.09)",
              pointerEvents: "none",
            }}
          />

          {/* Inner white artifact card + floating prompt box */}
          <div
            style={{
              position: "relative",
              display: "flex",
              alignItems: "flex-end",
              gap: 28,
              flexWrap: "wrap",
            }}
          >
            {/* Prompt / Upload box (dark, floating bottom-left) */}
            <div
              style={{
                flexShrink: 0,
                width: 260,
                marginBottom: -1,
                background: "#0A0F14",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: "14px 14px 0 0",
                padding: "18px 20px 24px",
                boxShadow: "0 -8px 30px rgba(0,0,0,0.35)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  marginBottom: 12,
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 100,
                    background: LIME,
                    boxShadow: `0 0 6px ${LIME}`,
                  }}
                />
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 10,
                    color: "rgba(255,255,255,0.55)",
                    letterSpacing: "0.08em",
                  }}
                >
                  {isAnalyze ? "UPLOAD" : "APP"}
                </span>
              </div>

              <p
                style={{
                  margin: "0 0 16px",
                  fontFamily: "var(--font-body)",
                  fontSize: 12.5,
                  lineHeight: 1.65,
                  color: "rgba(255,255,255,0.85)",
                }}
              >
                {active.prompt}
              </p>

              <button
                onClick={() => onAction(active.id)}
                style={{
                  width: "100%",
                  padding: "11px",
                  borderRadius: 9,
                  border: "none",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                  background: LIME,
                  color: NAVY,
                  fontFamily: "var(--font-sans)",
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: "pointer",
                  opacity: 1,
                  transition: "opacity 0.15s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.opacity = "0.88"
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.opacity = "1"
                }}
              >
                {isAnalyze && (
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <path d="M21 15l-5-5L5 21" />
                  </svg>
                )}
                {active.cta}
              </button>
            </div>

            {/* Artifact card (light, the produced result) */}
            <div
              style={{
                flex: 1,
                minWidth: 280,
                marginBottom: 0,
                background: WHITE,
                borderRadius: "16px 16px 0 0",
                padding: "30px 32px 40px",
                minHeight: 200,
                boxShadow: "0 -10px 40px rgba(0,0,0,0.25)",
              }}
            >
              <div
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                  color: BLUE,
                  letterSpacing: "0.1em",
                  marginBottom: 16,
                }}
              >
                {active.label.toUpperCase()} · PASSMATE
              </div>
              <h3
                style={{
                  fontFamily: "var(--font-sans)",
                  fontSize: 30,
                  fontWeight: 700,
                  letterSpacing: "-0.02em",
                  color: NAVY,
                  margin: 0,
                  lineHeight: 1.2,
                }}
              >
                {active.title}
              </h3>
              <div
                style={{
                  marginTop: 22,
                  display: "flex",
                  flexDirection: "column",
                  gap: 9,
                }}
              >
                {[92, 78, 64].map((w) => (
                  <div
                    key={w}
                    style={{
                      height: 7,
                      width: `${w}%`,
                      borderRadius: 4,
                      background: "rgba(12,20,25,0.08)",
                    }}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

// Hardcoded fallback topics — used only when Supabase has no board data yet.
const FALLBACK_TOPICS: BoardTopic[] = [
  {
    name: "Conditional Probability",
    freq: 8,
    score: 12,
    tag: "Must Do",
    pct: 95,
  },
  {
    name: "Normal Distribution MLE",
    freq: 7,
    score: 10,
    tag: "Must Do",
    pct: 85,
  },
  {
    name: "Hypothesis Testing (t-test)",
    freq: 5,
    score: 8,
    tag: "Important",
    pct: 62,
  },
  {
    name: "Expected Value & Variance",
    freq: 6,
    score: 6,
    tag: "Important",
    pct: 74,
  },
  {
    name: "Central Limit Theorem",
    freq: 4,
    score: 6,
    tag: "Optional",
    pct: 48,
  },
]

// ─── Past Papers section ──────────────────────────────────────
function PastPapersSection({
  subject,
  analysisDone,
  onOpenUpload,
  onOpenBoard,
  onOpenPrompt,
  topics: topicsProp,
  progressPct,
}: {
  subject: Subject | undefined
  analysisDone: boolean
  onOpenUpload: () => void
  onOpenBoard: () => void
  onOpenPrompt: () => void
  topics?: BoardTopic[]
  progressPct?: number
}) {
  const { ref, visible } = useReveal()
  // Use Supabase-sourced progress when available; fall back to checklist-derived value.
  const pct =
    progressPct ??
    (subject && subject.total
      ? Math.round((subject.completed / subject.total) * 100)
      : 0)
  // Use Supabase-sourced topics when available; fall back to the static defaults.
  const topics =
    topicsProp && topicsProp.length > 0 ? topicsProp : FALLBACK_TOPICS

  return (
    <section
      ref={ref}
      style={{
        padding: "100px 80px",
        background: "rgba(255,255,255,0.015)",
        borderTop: "1px solid rgba(255,255,255,0.05)",
        borderBottom: "1px solid rgba(255,255,255,0.05)",
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(40px)",
        transition: "opacity 0.7s ease, transform 0.7s ease",
      }}
    >
      <div
        style={{
          maxWidth: 1280,
          margin: "0 auto",
          display: "grid",
          gridTemplateColumns: "1fr 1.2fr",
          gap: 80,
          alignItems: "center",
        }}
      >
        {/* Left copy */}
        <div>
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: LIME,
              letterSpacing: "0.12em",
              marginBottom: 12,
            }}
          >
            FROM PAST PAPERS TO PASSING STRATEGY
          </div>
          <h2
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: 40,
              fontWeight: 800,
              letterSpacing: "-0.025em",
              color: WHITE,
              margin: "0 0 36px",
              lineHeight: 1.1,
            }}
          >
            Know exactly what to study.
          </h2>
          <div style={{ display: "flex", gap: 28 }}>
            {[
              { num: "87%", label: "Topic coverage" },
              { num: "4×", label: "Faster planning" },
            ].map((stat) => (
              <div key={stat.num}>
                <div
                  style={{
                    fontFamily: "var(--font-sans)",
                    fontSize: 32,
                    fontWeight: 800,
                    color: LIME,
                    letterSpacing: "-0.03em",
                    lineHeight: 1,
                  }}
                >
                  {stat.num}
                </div>
                <div
                  style={{
                    fontFamily: "var(--font-body)",
                    fontSize: 12,
                    color: "rgba(255,255,255,0.4)",
                    marginTop: 6,
                  }}
                >
                  {stat.label}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Right: priority board mock */}
        <div
          style={{
            background: "rgba(255,255,255,0.03)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 16,
            overflow: "hidden",
          }}
        >
          {/* Board header */}
          <div
            style={{
              padding: "16px 20px",
              borderBottom: "1px solid rgba(255,255,255,0.06)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <div>
              <div
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                  color: "rgba(255,255,255,0.3)",
                  letterSpacing: "0.08em",
                  marginBottom: 2,
                }}
              >
                PRIORITY BOARD
              </div>
              <div
                style={{
                  fontFamily: "var(--font-sans)",
                  fontSize: 13,
                  fontWeight: 600,
                  color: WHITE,
                }}
              >
                {subject?.name ?? "No subject selected"}
              </div>
            </div>
            <button
              onClick={onOpenPrompt}
              style={{
                padding: "6px 12px",
                background: `${BLUE}20`,
                border: `1px solid ${BLUE}40`,
                borderRadius: 100,
                fontFamily: "var(--font-sans)",
                fontSize: 11,
                fontWeight: 600,
                color: "#7ba8ff",
                cursor: "pointer",
                transition: "all 0.15s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = `${BLUE}30`
                e.currentTarget.style.color = WHITE
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = `${BLUE}20`
                e.currentTarget.style.color = "#7ba8ff"
              }}
            >
              Prompt Center →
            </button>
          </div>

          {/* Progress + analysis strip — same auto-calculated value as the orbit view */}
          <div
            style={{
              padding: "12px 20px",
              borderBottom: "1px solid rgba(255,255,255,0.05)",
              display: "flex",
              alignItems: "center",
              gap: 14,
            }}
          >
            <div style={{ flex: 1 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  marginBottom: 6,
                }}
              >
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 9,
                    color: "rgba(255,255,255,0.35)",
                    letterSpacing: "0.08em",
                  }}
                >
                  SUBJECT PROGRESS
                </span>
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 10,
                    fontWeight: 600,
                    color: LIME,
                  }}
                >
                  {pct}%
                </span>
              </div>
              <div
                style={{
                  height: 4,
                  background: "rgba(255,255,255,0.07)",
                  borderRadius: 2,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    height: "100%",
                    width: `${pct}%`,
                    background: `linear-gradient(90deg, ${BLUE}, ${LIME})`,
                    borderRadius: 2,
                    transition: "width 0.6s cubic-bezier(0.4,0,0.2,1)",
                  }}
                />
              </div>
            </div>
            <button
              onClick={() => {
                if (analysisDone) {
                  onOpenBoard()
                } else {
                  onOpenUpload()
                }
              }}
              style={{
                flexShrink: 0,
                padding: "8px 14px",
                borderRadius: 8,
                background: analysisDone ? `${LIME}18` : BLUE,
                border: analysisDone ? `1px solid ${LIME}45` : "none",
                color: analysisDone ? LIME : WHITE,
                fontFamily: "var(--font-sans)",
                fontSize: 11,
                fontWeight: 600,
                cursor: "pointer",
                whiteSpace: "nowrap",
                opacity: 1,
                transition: "opacity 0.15s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.opacity = "0.85"
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.opacity = "1"
              }}
            >
              {analysisDone
                ? "✓ Analysis complete · Open board →"
                : "Upload past papers to run analysis"}
            </button>
          </div>

          {/* Column headers */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 64px 64px 80px",
              padding: "10px 20px",
              borderBottom: "1px solid rgba(255,255,255,0.05)",
            }}
          >
            {["Topic", "Freq", "Score", "Priority"].map((h) => (
              <div
                key={h}
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 9,
                  color: "rgba(255,255,255,0.3)",
                  letterSpacing: "0.08em",
                }}
              >
                {h}
              </div>
            ))}
          </div>

          {/* Rows — `priority` is the Supabase field name; `tag` is the legacy fallback */}
          {topics.map((t, i) => {
            const label = t.priority ?? t.tag ?? "Optional"
            const isMust = label === "Must Do"
            const isImportant = label === "Important"
            return (
              <div
                key={t.name}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 64px 64px 80px",
                  padding: "12px 20px",
                  borderBottom:
                    i < topics.length - 1
                      ? "1px solid rgba(255,255,255,0.04)"
                      : "none",
                  alignItems: "center",
                  transition: "background 0.15s",
                }}
                onMouseEnter={(e) =>
                  ((e.currentTarget as HTMLDivElement).style.background =
                    "rgba(255,255,255,0.02)")
                }
                onMouseLeave={(e) =>
                  ((e.currentTarget as HTMLDivElement).style.background =
                    "transparent")
                }
              >
                <div>
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 500,
                      color: WHITE,
                      marginBottom: 4,
                    }}
                  >
                    {t.name}
                  </div>
                  <div
                    style={{
                      height: 2,
                      background: "rgba(255,255,255,0.06)",
                      borderRadius: 1,
                      width: "80%",
                    }}
                  >
                    <div
                      style={{
                        height: "100%",
                        width: `${t.pct ?? 0}%`,
                        background: BLUE,
                        borderRadius: 1,
                      }}
                    />
                  </div>
                </div>
                <div
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 12,
                    color: "rgba(255,255,255,0.5)",
                  }}
                >
                  {t.freq != null ? `${t.freq}×` : "—"}
                </div>
                <div
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 12,
                    color: "rgba(255,255,255,0.5)",
                  }}
                >
                  {t.score != null ? `${t.score}pt` : "—"}
                </div>
                <div>
                  <span
                    style={{
                      display: "inline-flex",
                      padding: "2px 8px",
                      borderRadius: 100,
                      fontSize: 10,
                      fontWeight: 600,
                      background: isMust
                        ? `${LIME}20`
                        : isImportant
                          ? `${BLUE}20`
                          : "rgba(255,255,255,0.06)",
                      color: isMust
                        ? LIME
                        : isImportant
                          ? "#7ba8ff"
                          : "rgba(255,255,255,0.35)",
                      border: `1px solid ${
                        isMust
                          ? `${LIME}35`
                          : isImportant
                            ? `${BLUE}35`
                            : "rgba(255,255,255,0.08)"
                      }`,
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    {label}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

// ─── AI Solver Assistant ──────────────────────────────────────
type ChatMsg = { role: "user" | "assistant"; text?: string; image?: string }

function AssistantPanel({
  messages,
  onSend,
  variant,
  thinking,
  onExpand,
  onBack,
}: {
  messages: ChatMsg[]
  onSend: (text: string, image?: string) => void
  variant: "card" | "page"
  thinking: boolean
  onExpand?: () => void
  onBack?: () => void
}) {
  const [text, setText] = useState("")
  const [image, setImage] = useState<string | undefined>(undefined)
  const fileRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const isPage = variant === "page"

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
  }, [messages, thinking])

  const pickImage = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    const r = new FileReader()
    r.onload = () => setImage(r.result as string)
    r.readAsDataURL(f)
  }

  const submit = () => {
    if (!text.trim() && !image) return
    onSend(text.trim(), image)
    setText("")
    setImage(undefined)
    if (fileRef.current) fileRef.current.value = ""
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: isPage ? "72vh" : "100%",
        padding: isPage ? 28 : 24,
        background: isPage
          ? "rgba(255,255,255,0.03)"
          : `linear-gradient(150deg, #3b74ff 0%, ${BLUE} 55%, #204bc4 100%)`,
        border: isPage ? "1px solid rgba(255,255,255,0.08)" : "none",
        borderRadius: 16,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 16,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div
            style={{
              width: 7,
              height: 7,
              borderRadius: 100,
              background: LIME,
              boxShadow: `0 0 8px ${LIME}`,
            }}
          />
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              color: "rgba(255,255,255,0.4)",
              letterSpacing: "0.08em",
            }}
          >
            AI SOLVER ASSISTANT
          </div>
        </div>
        {isPage ? (
          <button
            onClick={onBack}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 12px",
              background: "rgba(255,255,255,0.05)",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 8,
              color: "rgba(255,255,255,0.6)",
              fontSize: 12,
              fontFamily: "var(--font-body)",
              cursor: "pointer",
            }}
          >
            ← Back
          </button>
        ) : (
          <button
            onClick={onExpand}
            title="Open full assistant"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 28,
              height: 28,
              borderRadius: 8,
              background: isPage ? "rgba(255,255,255,0.04)" : "#ffffff",
              border: isPage ? "1px solid rgba(255,255,255,0.1)" : "none",
              color: isPage ? "rgba(255,255,255,0.55)" : "rgba(0,0,0,0.5)",
              cursor: "pointer",
              transition: "all 0.15s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = isPage ? WHITE : BLUE
              e.currentTarget.style.borderColor = `${BLUE}60`
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = isPage
                ? "rgba(255,255,255,0.55)"
                : "rgba(0,0,0,0.5)"
              e.currentTarget.style.borderColor = isPage
                ? "rgba(255,255,255,0.1)"
                : "transparent"
            }}
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
            </svg>
          </button>
        )}
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        className="scrollable"
        style={{
          flex: 1,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 12,
          paddingRight: 4,
        }}
      >
        {messages.length === 0 && !thinking && (
          <div
            style={{
              margin: "auto",
              textAlign: "center",
              maxWidth: 320,
              padding: "24px 0",
            }}
          >
            <div style={{ fontSize: 26, marginBottom: 12 }}>✦</div>
            <div
              style={{
                fontFamily: "var(--font-sans)",
                fontSize: 15,
                fontWeight: 600,
                color: WHITE,
                marginBottom: 6,
              }}
            >
              Stuck on a question?
            </div>
            <div
              style={{
                fontFamily: "var(--font-body)",
                fontSize: 12.5,
                color: "rgba(255,255,255,0.4)",
                lineHeight: 1.6,
              }}
            >
              Snap a photo of the problem or type it out. I'll walk you through
              the solution step by step.
            </div>
          </div>
        )}

        {messages.map((m, i) => {
          const mine = m.role === "user"
          return (
            <div
              key={i}
              style={{
                display: "flex",
                justifyContent: mine ? "flex-end" : "flex-start",
              }}
            >
              <div
                style={{
                  maxWidth: "82%",
                  padding: m.image && !m.text ? 4 : "10px 14px",
                  background: "#ffffff",
                  border: "none",
                  borderRadius: 12,
                  borderBottomRightRadius: mine ? 4 : 12,
                  borderBottomLeftRadius: mine ? 12 : 4,
                }}
              >
                {m.image && (
                  <img
                    src={m.image}
                    alt="uploaded problem"
                    style={{
                      display: "block",
                      maxWidth: "100%",
                      maxHeight: 200,
                      borderRadius: 8,
                      marginBottom: m.text ? 8 : 0,
                    }}
                  />
                )}
                {m.text && (
                  <div
                    style={{
                      fontFamily: "var(--font-body)",
                      fontSize: 13,
                      lineHeight: 1.6,
                      color: "rgba(0,0,0,0.8)",
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {m.text}
                  </div>
                )}
              </div>
            </div>
          )
        })}

        {thinking && (
          <div style={{ display: "flex", justifyContent: "flex-start" }}>
            <div
              style={{
                padding: "10px 14px",
                background: isPage ? "rgba(255,255,255,0.04)" : "#ffffff",
                border: isPage ? "1px solid rgba(255,255,255,0.08)" : "none",
                borderRadius: 12,
                borderBottomLeftRadius: 4,
                display: "flex",
                gap: 4,
                alignItems: "center",
              }}
            >
              {[0, 1, 2].map((d) => (
                <span
                  key={d}
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: 100,
                    background: isPage
                      ? "rgba(255,255,255,0.5)"
                      : "rgba(0,0,0,0.3)",
                    animation: `dotPulse 1.2s ${d * 0.15}s ease-in-out infinite`,
                  }}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Image preview */}
      {image && (
        <div
          style={{
            position: "relative",
            display: "inline-block",
            marginTop: 12,
            alignSelf: "flex-start",
          }}
        >
          <img
            src={image}
            alt="preview"
            style={{
              height: 56,
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.12)",
            }}
          />
          <button
            onClick={() => {
              setImage(undefined)
              if (fileRef.current) fileRef.current.value = ""
            }}
            style={{
              position: "absolute",
              top: -7,
              right: -7,
              width: 18,
              height: 18,
              borderRadius: 100,
              background: NAVY,
              border: "1px solid rgba(255,255,255,0.2)",
              color: WHITE,
              fontSize: 11,
              lineHeight: 1,
              cursor: "pointer",
              padding: 0,
            }}
          >
            ×
          </button>
        </div>
      )}

      {/* Composer */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          gap: 8,
          marginTop: 12,
          padding: 8,
          background: isPage ? "rgba(255,255,255,0.03)" : "#ffffff",
          border: isPage ? "1px solid rgba(255,255,255,0.08)" : "none",
          borderRadius: 12,
        }}
      >
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          onChange={pickImage}
          style={{ display: "none" }}
        />
        <button
          onClick={() => fileRef.current?.click()}
          title="Upload image"
          style={{
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 34,
            height: 34,
            borderRadius: 8,
            background: isPage ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.06)",
            border: isPage ? "1px solid rgba(255,255,255,0.1)" : "none",
            color: isPage ? "rgba(255,255,255,0.55)" : "rgba(0,0,0,0.4)",
            cursor: "pointer",
            transition: "all 0.15s",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = isPage ? LIME : BLUE
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = isPage
              ? "rgba(255,255,255,0.55)"
              : "rgba(0,0,0,0.4)"
          }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <path d="M21 15l-5-5L5 21" />
          </svg>
        </button>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder="Ask about a problem…"
          rows={1}
          style={{
            flex: 1,
            resize: "none",
            maxHeight: 120,
            minHeight: 34,
            padding: "8px 4px",
            background: "transparent",
            border: "none",
            outline: "none",
            color: isPage ? WHITE : "rgba(0,0,0,0.8)",
            fontSize: 13,
            lineHeight: 1.5,
            fontFamily: "var(--font-body)",
          }}
        />
        <button
          onClick={submit}
          disabled={!text.trim() && !image}
          style={{
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 34,
            height: 34,
            borderRadius: 8,
            background:
              text.trim() || image
                ? BLUE
                : isPage
                  ? "rgba(255,255,255,0.06)"
                  : "rgba(0,0,0,0.08)",
            border: "none",
            color: WHITE,
            cursor: text.trim() || image ? "pointer" : "default",
            opacity: text.trim() || image ? 1 : 0.5,
            transition: "all 0.15s",
          }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
          </svg>
        </button>
      </div>
    </div>
  )
}

// ─── Mock exam section ────────────────────────────────────────
function MockExamSection({
  chat,
  onSend,
  thinking,
  onExpand,
  subject,
  targetScore,
  onChangeTargetScore,
  progressPct,
  mustDoLeft,
  flowDoneCount,
}: {
  chat: ChatMsg[]
  onSend: (text: string, image?: string) => void
  thinking: boolean
  onExpand: () => void
  subject: Subject | undefined
  targetScore: number
  onChangeTargetScore: (v: number) => void
  progressPct: number
  mustDoLeft: number
  flowDoneCount: number
}) {
  const { ref, visible } = useReveal()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(String(targetScore))
  const daysLeft = subject ? daysUntil(subject.examDate) : 0
  const examLabel = subject ? formatExam(subject.examDate) : "—"

  const commit = () => {
    const n = Math.max(0, Math.min(100, Math.round(Number(draft)) || 0))
    onChangeTargetScore(n)
    setEditing(false)
  }

  return (
    <section
      ref={ref}
      style={{
        padding: "100px 80px",
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(40px)",
        transition: "opacity 0.7s ease, transform 0.7s ease",
      }}
    >
      <div style={{ maxWidth: 1280, margin: "0 auto" }}>
        <div style={{ textAlign: "center", marginBottom: 64 }}>
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: BLUE,
              letterSpacing: "0.12em",
              marginBottom: 12,
            }}
          >
            FINAL MOCK EXAM & REVIEW LOOP
          </div>
          <h2
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: 42,
              fontWeight: 800,
              letterSpacing: "-0.025em",
              color: WHITE,
              margin: "0 auto",
              lineHeight: 1.1,
              maxWidth: 520,
            }}
          >
            Prove you're ready before exam day.
          </h2>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 20,
            maxWidth: 900,
            margin: "0 auto",
          }}
        >
          {/* Target score card — editable, per-subject, persisted */}
          <div
            style={{
              padding: 32,
              background: `linear-gradient(150deg, #3b74ff 0%, ${BLUE} 55%, #204bc4 100%)`,
              borderRadius: 16,
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                color: "rgba(255,255,255,0.3)",
                letterSpacing: "0.08em",
                marginBottom: 20,
              }}
            >
              YOUR TARGET SCORE
            </div>

            <div
              style={{
                display: "flex",
                alignItems: "flex-end",
                gap: 12,
                marginBottom: 16,
              }}
            >
              {editing ? (
                <input
                  autoFocus
                  type="number"
                  min={0}
                  max={100}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commit}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commit()
                    if (e.key === "Escape") {
                      setDraft(String(targetScore))
                      setEditing(false)
                    }
                  }}
                  style={{
                    width: 140,
                    fontFamily: "var(--font-sans)",
                    fontSize: 72,
                    fontWeight: 800,
                    color: LIME,
                    lineHeight: 1,
                    letterSpacing: "-0.04em",
                    background: "transparent",
                    border: "none",
                    borderBottom: `2px solid ${LIME}80`,
                    outline: "none",
                    padding: 0,
                  }}
                />
              ) : (
                <button
                  onClick={() => {
                    setDraft(String(targetScore))
                    setEditing(true)
                  }}
                  title="Click to edit"
                  style={{
                    fontFamily: "var(--font-sans)",
                    fontSize: 72,
                    fontWeight: 800,
                    color: LIME,
                    lineHeight: 1,
                    letterSpacing: "-0.04em",
                    background: "transparent",
                    border: "none",
                    padding: 0,
                    cursor: "pointer",
                  }}
                >
                  {targetScore}
                </button>
              )}
              <div style={{ paddingBottom: 12 }}>
                <div
                  style={{
                    fontFamily: "var(--font-body)",
                    fontSize: 13,
                    color: "rgba(255,255,255,0.4)",
                  }}
                >
                  /100
                </div>
              </div>
            </div>

            <p
              style={{
                fontFamily: "var(--font-body)",
                fontSize: 12.5,
                color: "rgba(255,255,255,0.55)",
                lineHeight: 1.6,
                margin: 0,
              }}
            >
              Click the number to edit — this is the pass line you set for yourself, not a mock exam score.
            </p>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 12,
                marginTop: 24,
              }}
            >
              {[
                {
                  label: "Days left",
                  value: `${daysLeft}`,
                  sub: examLabel,
                  color: daysLeft <= 24 ? "#ff9a7a" : WHITE,
                },
                {
                  label: "Review progress",
                  value: `${progressPct}%`,
                  sub: "checklist completion",
                  color: WHITE,
                },
                {
                  label: "Must-do left",
                  value: `${mustDoLeft}`,
                  sub: "unchecked on your board",
                  color: WHITE,
                },
                {
                  label: "Flow steps",
                  value: `${flowDoneCount}/5`,
                  sub: "revision flow progress",
                  color: WHITE,
                },
              ].map((s) => (
                <div
                  key={s.label}
                  style={{
                    padding: "12px 14px",
                    background: "rgba(255,255,255,0.08)",
                    border: "1px solid rgba(255,255,255,0.12)",
                    borderRadius: 10,
                  }}
                >
                  <div
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 9,
                      color: "rgba(255,255,255,0.45)",
                      letterSpacing: "0.06em",
                      marginBottom: 4,
                    }}
                  >
                    {s.label.toUpperCase()}
                  </div>
                  <div
                    style={{
                      fontFamily: "var(--font-sans)",
                      fontSize: 22,
                      fontWeight: 700,
                      color: s.color,
                      lineHeight: 1.2,
                    }}
                  >
                    {s.value}
                  </div>
                  <div
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 10.5,
                      color: s.color === WHITE ? "rgba(255,255,255,0.4)" : s.color,
                      marginTop: 2,
                    }}
                  >
                    {s.sub}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* AI Solver Assistant */}
          <AssistantPanel
            variant="card"
            messages={chat}
            onSend={onSend}
            thinking={thinking}
            onExpand={onExpand}
          />
        </div>
      </div>
    </section>
  )
}

// ─── Footer ───────────────────────────────────────────────────
function Footer() {
  return (
    <footer
      style={{
        padding: "32px 80px",
        borderTop: "1px solid rgba(255,255,255,0.05)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div
          style={{
            width: 22,
            height: 22,
            borderRadius: 5,
            background: `linear-gradient(135deg, ${BLUE}, ${BLUE}80)`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
            <path
              d="M5.5 1.5L10 9.5H1L5.5 1.5Z"
              fill={WHITE}
              fillOpacity=".9"
            />
          </svg>
        </div>
        <span
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: 14,
            fontWeight: 600,
            color: "rgba(255,255,255,0.5)",
          }}
        >
          PassMate
        </span>
      </div>
      <div style={{ display: "flex", gap: 32 }}>
        {["Privacy", "Terms", "Support"].map((l) => (
          <a
            key={l}
            href="#"
            style={{
              fontFamily: "var(--font-body)",
              fontSize: 12,
              color: "rgba(255,255,255,0.3)",
              textDecoration: "none",
              transition: "color 0.15s",
            }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.color = "rgba(255,255,255,0.6)")
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.color = "rgba(255,255,255,0.3)")
            }
          >
            {l}
          </a>
        ))}
      </div>
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          color: "rgba(255,255,255,0.2)",
          letterSpacing: "0.06em",
        }}
      >
        © 2026 PASSMATE
      </div>
    </footer>
  )
}

// ─── Prompt Center page ───────────────────────────────────────
const STAGES = [
  { id: "unit", label: "Unit study" },
  { id: "practice", label: "Practice review" },
  { id: "flashcard", label: "Flashcard drill" },
] as const
type StageId = typeof STAGES[number]["id"]

// 场景2：做完一套卷子后去 Gemini 一题一题复盘用的固定模板——不联动站内 AI，
// 纯本地拼字符串，点一下直接复制。科目名自动带入。
function buildPracticeReviewTemplate(subject: string): string {
  const s = subject.trim() || "（科目）"
  return `喵喵喵！我现在是大二学生，正在复习${s}。

后续接收${s}相关题目作答规则：
1. 每次对话开头固定带上：喵喵喵
2. 先标注题目对应知识点以及考频（结合本次考点）
3. 列明本题易错点与出错诱因
4. 分步书写解题过程 + 最终标准答案`
}

function buildPrompt(subject: string, stage: StageId, topic: string): string {
  const t = topic.trim() || "（当前专题）"
  if (stage === "unit") {
    return `你是我的《${subject}》考试冲刺辅导老师。请围绕「${t}」为我做单元精讲：\n1. 用一个直观的例子解释核心概念；\n2. 列出这个考点最容易考的 2–3 种题型；\n3. 给出解题的标准步骤和常见陷阱；\n4. 最后出 1 道由浅入深的自测题，先不给答案。`
  }
  if (stage === "practice") {
    return `你是我的《${subject}》练习复盘助手。我刚做完关于「${t}」的练习题。请帮我：\n1. 逐步讲解这一考点的标准解法；\n2. 分析我在这类题上最可能犯的错误（概念、计算、粗心）；\n3. 针对薄弱环节，再给我 3 道同类型强化题（附答案）。`
  }
  return `你是我的《${subject}》记忆卡助手。请把「${t}」拆成一组抽认卡（flashcards）：\n1. 每张卡正面是一个精炼的问题或术语，背面是简短准确的答案；\n2. 覆盖必背的定义、公式和易混点；\n3. 生成 8–10 张，并按重要程度排序。`
}

function PromptCenter({
  subjects,
  boardTopics,
  onBack,
}: {
  subjects: Subject[]
  boardTopics: Record<string, BoardTopic[]>
  onBack: () => void
}) {
  const [subject, setSubject] = useState(subjects[0]?.name ?? "")
  const [stage, setStage] = useState<StageId>("unit")
  const [topic, setTopic] = useState("")
  const [output, setOutput] = useState("")
  const [copied, setCopied] = useState(false)
  const [generating, setGenerating] = useState(false)

  const subjectTopics = boardTopics[subject] ?? []

  const generate = async () => {
    setCopied(false)
    // 场景2（Practice review）是固定模板，不联网、不调 Dify，直接本地生成。
    if (stage === "practice") {
      setOutput(buildPracticeReviewTemplate(subject))
      return
    }
    setGenerating(true)
    setOutput("")
    try {
      const STAGE_MAP: Record<StageId, string> = {
        unit: "unit_study",
        practice: "practice_review",
        flashcard: "flashcard",
      }
      const stageLabel = STAGE_MAP[stage] ?? stage
      const res = await fetch(`${DIFY_PROXY_BASE}?action=run-prompt`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${publicAnonKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          inputs: { subject, stage: stageLabel, content_detail: topic },
          response_mode: "blocking",
          user: "passmate-user",
        }),
      })
      const json = await res.json()
      const text =
        json?.data?.outputs?.text ??
        json?.data?.outputs?.result ??
        json?.data?.outputs?.prompt ??
        Object.values(json?.data?.outputs ?? {})[0] ??
        ""
      setOutput(typeof text === "string" ? text : JSON.stringify(text, null, 2))
    } catch (err) {
      setOutput("Failed to reach the Dify API. Check your network or API key.")
    } finally {
      setGenerating(false)
    }
  }

  const copy = () => {
    if (!output) return
    navigator.clipboard?.writeText(output)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  const fieldLabel = {
    fontFamily: "var(--font-mono)",
    fontSize: 10,
    color: "rgba(255,255,255,0.35)",
    letterSpacing: "0.08em",
    marginBottom: 10,
    display: "block",
  } as const

  return (
    <section
      style={{ padding: "48px 80px 100px", minHeight: "calc(100vh - 64px)" }}
    >
      <div style={{ maxWidth: 900, margin: "0 auto" }}>
        {/* Breadcrumb / back */}
        <button
          onClick={onBack}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            marginBottom: 24,
            padding: "6px 12px",
            background: "transparent",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 8,
            color: "rgba(255,255,255,0.6)",
            fontSize: 12,
            fontFamily: "var(--font-body)",
            cursor: "pointer",
            transition: "all 0.15s",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = WHITE
            e.currentTarget.style.borderColor = "rgba(255,255,255,0.28)"
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "rgba(255,255,255,0.6)"
            e.currentTarget.style.borderColor = "rgba(255,255,255,0.12)"
          }}
        >
          ← Back to Priority Board
        </button>

        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: BLUE,
            letterSpacing: "0.12em",
            marginBottom: 12,
          }}
        >
          PROMPT CENTER
        </div>
        <h1
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: 38,
            fontWeight: 800,
            letterSpacing: "-0.025em",
            color: WHITE,
            margin: "0 0 40px",
            lineHeight: 1.1,
          }}
        >
          Build the right prompt, every session.
        </h1>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 20,
            alignItems: "start",
          }}
        >
          {/* Config card */}
          <div
            style={{
              padding: 28,
              background: "rgba(255,255,255,0.03)",
              border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 16,
            }}
          >
            {/* Subject selector */}
            <label style={fieldLabel}>SUBJECT</label>
            <select
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              style={{
                width: "100%",
                padding: "11px 14px",
                marginBottom: 24,
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 10,
                color: WHITE,
                fontSize: 13,
                fontFamily: "var(--font-body)",
                outline: "none",
                cursor: "pointer",
                appearance: "none",
              }}
            >
              {subjects.map((s) => (
                <option
                  key={s.name}
                  value={s.name}
                  style={{ background: NAVY }}
                >
                  {s.name}
                </option>
              ))}
            </select>

            {/* Stage segmented control */}
            <label style={fieldLabel}>STAGE</label>
            <div
              style={{
                display: "flex",
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: 10,
                padding: 4,
                marginBottom: 24,
              }}
            >
              {STAGES.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setStage(s.id)}
                  style={{
                    flex: 1,
                    padding: "9px 0",
                    background: stage === s.id ? BLUE : "transparent",
                    border: "none",
                    borderRadius: 7,
                    color: stage === s.id ? WHITE : "rgba(255,255,255,0.5)",
                    fontSize: 12,
                    fontWeight: stage === s.id ? 600 : 450,
                    fontFamily: "var(--font-body)",
                    cursor: "pointer",
                    transition: "all 0.15s",
                  }}
                >
                  {s.label}
                </button>
              ))}
            </div>

            {/* Unit study: 从考点看板里选一个考点，自动填进下面的 topic */}
            {stage === "unit" && subjectTopics.length > 0 && (
              <>
                <label style={fieldLabel}>Pick from your exam board (optional)</label>
                <select
                  value=""
                  onChange={(e) => {
                    if (e.target.value) setTopic(e.target.value)
                  }}
                  style={{
                    width: "100%",
                    padding: "11px 14px",
                    marginBottom: 12,
                    background: "rgba(255,255,255,0.04)",
                    border: "1px solid rgba(255,255,255,0.1)",
                    borderRadius: 10,
                    color: WHITE,
                    fontSize: 13,
                    fontFamily: "var(--font-body)",
                    outline: "none",
                  }}
                >
                  <option value="">— none, type your own —</option>
                  {subjectTopics.map((t) => (
                    <option key={t.id ?? t.name} value={t.name}>
                      {t.name}
                      {t.priority ? `（${t.priority}）` : ""}
                    </option>
                  ))}
                </select>
              </>
            )}

            {/* Topic input */}
            <label style={fieldLabel}>CURRENT TOPIC / FOCUS AREA</label>
            <input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && generate()}
              placeholder="e.g. Conditional probability & Bayes' theorem"
              style={{
                width: "100%",
                padding: "11px 14px",
                marginBottom: 24,
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 10,
                color: WHITE,
                fontSize: 13,
                fontFamily: "var(--font-body)",
                outline: "none",
                transition: "border-color 0.15s",
              }}
              onFocus={(e) => (e.target.style.borderColor = `${BLUE}60`)}
              onBlur={(e) =>
                (e.target.style.borderColor = "rgba(255,255,255,0.1)")
              }
            />

            <button
              onClick={generate}
              disabled={generating}
              style={{
                width: "100%",
                padding: "13px",
                borderRadius: 10,
                background: generating ? "rgba(255,255,255,0.15)" : WHITE,
                border: "none",
                color: generating ? "rgba(255,255,255,0.5)" : NAVY,
                fontSize: 14,
                fontWeight: 700,
                fontFamily: "var(--font-sans)",
                cursor: generating ? "default" : "pointer",
                transition: "opacity 0.15s, background 0.15s",
              }}
              onMouseEnter={(e) => {
                if (!generating) e.currentTarget.style.opacity = "0.9"
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.opacity = "1"
              }}
            >
              {generating ? "Generating…" : "Generate prompt"}
            </button>
          </div>

          {/* Output card */}
          <div
            style={{
              padding: 28,
              background: "rgba(255,255,255,0.03)",
              border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 16,
              display: "flex",
              flexDirection: "column",
              minHeight: 360,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 16,
              }}
            >
              <label style={{ ...fieldLabel, marginBottom: 0 }}>
                GENERATED PROMPT
              </label>
              <button
                onClick={copy}
                disabled={!output}
                style={{
                  padding: "5px 12px",
                  borderRadius: 8,
                  background: copied ? `${LIME}20` : "rgba(255,255,255,0.06)",
                  border: `1px solid ${
                    copied ? `${LIME}40` : "rgba(255,255,255,0.1)"
                  }`,
                  color: copied
                    ? LIME
                    : output
                      ? "rgba(255,255,255,0.7)"
                      : "rgba(255,255,255,0.25)",
                  fontSize: 11,
                  fontWeight: 600,
                  fontFamily: "var(--font-body)",
                  cursor: output ? "pointer" : "default",
                  transition: "all 0.15s",
                }}
              >
                {copied ? "✓ Copied" : "Copy"}
              </button>
            </div>
            <div
              style={{
                flex: 1,
                padding: "16px 18px",
                background: "rgba(0,0,0,0.2)",
                border: "1px solid rgba(255,255,255,0.06)",
                borderRadius: 10,
                whiteSpace: "pre-wrap",
                fontSize: 13,
                lineHeight: 1.7,
                fontFamily: "var(--font-body)",
                color: output
                  ? "rgba(255,255,255,0.82)"
                  : "rgba(255,255,255,0.3)",
                overflowY: "auto",
              }}
            >
              {output ||
                "Your generated prompt will appear here. Pick a subject, stage and topic, then hit Generate."}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

// ─── My Schedule page ─────────────────────────────────────────
// Full-page list of subjects: what to sit, when the exam falls, and how far
// along revision is. Progress mirrors the auto-calculated orbit value.
function SchedulePage({
  subjects,
  onBack,
}: {
  subjects: Subject[]
  onBack: () => void
}) {
  const ordered = [...subjects].sort(
    (a, b) => daysUntil(a.examDate) - daysUntil(b.examDate),
  )
  return (
    <section
      style={{ padding: "48px 80px 100px", minHeight: "calc(100vh - 64px)" }}
    >
      <div style={{ maxWidth: 900, margin: "0 auto" }}>
        <button
          onClick={onBack}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            marginBottom: 24,
            padding: "6px 12px",
            background: "transparent",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 8,
            color: "rgba(255,255,255,0.6)",
            fontSize: 12,
            fontFamily: "var(--font-body)",
            cursor: "pointer",
            transition: "all 0.15s",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = WHITE
            e.currentTarget.style.borderColor = "rgba(255,255,255,0.28)"
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "rgba(255,255,255,0.6)"
            e.currentTarget.style.borderColor = "rgba(255,255,255,0.12)"
          }}
        >
          ← Back to home
        </button>

        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: BLUE,
            letterSpacing: "0.12em",
            marginBottom: 12,
          }}
        >
          MY SCHEDULE
        </div>
        <h1
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: 38,
            fontWeight: 800,
            letterSpacing: "-0.025em",
            color: WHITE,
            margin: "0 0 32px",
            lineHeight: 1.1,
          }}
        >
          Every exam, and how ready you are.
        </h1>

        {/* Column headers */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 120px 90px 200px",
            gap: 16,
            padding: "0 20px 10px",
          }}
        >
          {["Subject", "Exam date", "Days left", "Revision progress"].map(
            (h) => (
              <div
                key={h}
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 9,
                  color: "rgba(255,255,255,0.3)",
                  letterSpacing: "0.08em",
                }}
              >
                {h.toUpperCase()}
              </div>
            ),
          )}
        </div>

        {/* Rows */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {ordered.map((s) => {
            const daysLeft = daysUntil(s.examDate)
            const pct = s.total ? Math.round((s.completed / s.total) * 100) : 0
            const urgent = daysLeft <= 24
            return (
              <div
                key={s.name}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 120px 90px 200px",
                  gap: 16,
                  alignItems: "center",
                  padding: "18px 20px",
                  background: "rgba(255,255,255,0.03)",
                  border: "1px solid rgba(255,255,255,0.08)",
                  borderRadius: 14,
                  transition: "border-color 0.15s",
                }}
                onMouseEnter={(e) =>
                  ((e.currentTarget as HTMLDivElement).style.borderColor = `${BLUE}30`)
                }
                onMouseLeave={(e) =>
                  ((e.currentTarget as HTMLDivElement).style.borderColor =
                    "rgba(255,255,255,0.08)")
                }
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    minWidth: 0,
                  }}
                >
                  <span
                    style={{
                      width: 9,
                      height: 9,
                      borderRadius: "50%",
                      background: s.color,
                      flexShrink: 0,
                      boxShadow: `0 0 8px ${s.color}`,
                    }}
                  />
                  <span
                    style={{
                      fontFamily: "var(--font-sans)",
                      fontSize: 15,
                      fontWeight: 600,
                      color: WHITE,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {s.name}
                  </span>
                </div>
                <div
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 12,
                    color: "rgba(255,255,255,0.55)",
                  }}
                >
                  {formatExam(s.examDate)}
                </div>
                <div
                  style={{ display: "flex", alignItems: "baseline", gap: 4 }}
                >
                  <span
                    style={{
                      fontFamily: "var(--font-sans)",
                      fontSize: 20,
                      fontWeight: 800,
                      color: urgent ? "#ff9a7a" : WHITE,
                      lineHeight: 1,
                    }}
                  >
                    {daysLeft}
                  </span>
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 9,
                      color: "rgba(255,255,255,0.3)",
                    }}
                  >
                    D
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div
                    style={{
                      flex: 1,
                      height: 5,
                      background: "rgba(255,255,255,0.07)",
                      borderRadius: 3,
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        height: "100%",
                        width: `${pct}%`,
                        background: `linear-gradient(90deg, ${BLUE}, ${LIME})`,
                        borderRadius: 3,
                        transition: "width 0.7s cubic-bezier(0.4,0,0.2,1)",
                      }}
                    />
                  </div>
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 11,
                      fontWeight: 600,
                      color: LIME,
                      minWidth: 34,
                      textAlign: "right",
                    }}
                  >
                    {pct}%
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

// ─── Exam-Point Board ─────────────────────────────────────────
type Prio = "Must Do" | "Important" | "Optional"

interface BoardQuestion {
  set: number // which of the 3 uploaded past-paper sets
  q: string // question label, e.g. "Q3(a)"
  score: number // marks
  tag: Prio
  text: string // the actual question
}
interface BoardPoint {
  name: string
  freq: number // appearances across the 3 sets
  difficulty: "Formulaic" | "Moderate" | "Tricky" // 套路固定 → 偏难
  beginner: boolean // easy for newcomers to grasp
  tag: Prio
  questions: BoardQuestion[]
}

// Mock analysis output: every question about each exam point, collected from
// the 3 uploaded past-paper sets and tagged by priority.
const EXAM_BOARD: BoardPoint[] = [
  {
    name: "Conditional Probability & Bayes",
    freq: 8,
    difficulty: "Formulaic",
    beginner: true,
    tag: "Must Do",
    questions: [
      {
        set: 1,
        q: "Q3(a)",
        score: 12,
        tag: "Must Do",
        text: "A box holds 6 red and 4 white balls. Two are drawn without replacement — find the probability the second is red given the first was white.",
      },
      {
        set: 2,
        q: "Q2",
        score: 10,
        tag: "Must Do",
        text: "Given P(A)=0.3, P(B)=0.5 and P(A∩B)=0.2, compute P(A|B) and decide whether A and B are independent.",
      },
      {
        set: 3,
        q: "Q4(b)",
        score: 8,
        tag: "Important",
        text: "A test is 95% accurate; the disease affects 1% of people. Using Bayes' theorem, find the probability a positive result is a true positive.",
      },
    ],
  },
  {
    name: "Normal Distribution & MLE",
    freq: 7,
    difficulty: "Moderate",
    beginner: false,
    tag: "Must Do",
    questions: [
      {
        set: 1,
        q: "Q6",
        score: 10,
        tag: "Must Do",
        text: "Let X₁…Xₙ be i.i.d. N(μ, σ²). Derive the maximum-likelihood estimators of μ and σ².",
      },
      {
        set: 2,
        q: "Q5",
        score: 8,
        tag: "Important",
        text: "Given a sample of 5 measurements, estimate μ by maximum likelihood and state its distribution.",
      },
      {
        set: 3,
        q: "Q6",
        score: 10,
        tag: "Must Do",
        text: "Show the MLE of μ is unbiased and find its variance for a normal population.",
      },
    ],
  },
  {
    name: "Expected Value & Variance",
    freq: 6,
    difficulty: "Formulaic",
    beginner: true,
    tag: "Important",
    questions: [
      {
        set: 1,
        q: "Q1",
        score: 6,
        tag: "Important",
        text: "A discrete r.v. takes values 1,2,3 with probabilities 0.2, 0.5, 0.3. Find E[X] and Var(X).",
      },
      {
        set: 2,
        q: "Q1",
        score: 6,
        tag: "Important",
        text: "Compute E[X] and Var(X) for a continuous r.v. with density f(x)=2x on [0,1].",
      },
      {
        set: 3,
        q: "Q2",
        score: 5,
        tag: "Optional",
        text: "For Y = 2X + 3 with Var(X)=4, find Var(Y) and E[Y] given E[X]=1.",
      },
    ],
  },
  {
    name: "Hypothesis Testing (t-test)",
    freq: 5,
    difficulty: "Moderate",
    beginner: false,
    tag: "Important",
    questions: [
      {
        set: 1,
        q: "Q7",
        score: 8,
        tag: "Important",
        text: "A sample of 10 has mean 52 and s.d. 4. Test at 5% whether the population mean differs from 50.",
      },
      {
        set: 3,
        q: "Q7(a)",
        score: 6,
        tag: "Important",
        text: "State the assumptions of a one-sample t-test and set up the hypotheses for the given data.",
      },
    ],
  },
  {
    name: "Central Limit Theorem",
    freq: 4,
    difficulty: "Tricky",
    beginner: false,
    tag: "Optional",
    questions: [
      {
        set: 2,
        q: "Q8",
        score: 6,
        tag: "Optional",
        text: "The mean of 100 i.i.d. draws (μ=3, σ=2) is taken. Approximate P(sample mean > 3.3).",
      },
      {
        set: 3,
        q: "Q8",
        score: 6,
        tag: "Optional",
        text: "Explain why the sampling distribution of the mean tends to normal, and state the conditions required.",
      },
    ],
  },
]

const PRIO_STYLE: Record<Prio, { fg: string; bg: string; bd: string }> = {
  "Must Do": { fg: LIME, bg: `${LIME}18`, bd: `${LIME}40` },
  Important: { fg: "#7ba8ff", bg: `${BLUE}20`, bd: `${BLUE}40` },
  Optional: {
    fg: "rgba(255,255,255,0.4)",
    bg: "rgba(255,255,255,0.05)",
    bd: "rgba(255,255,255,0.1)",
  },
}
const DIFF_STYLE: Record<BoardPoint["difficulty"], {
  label: string
  fg: string
}> = {
  Formulaic: { label: "Formulaic", fg: LIME },
  Moderate: { label: "Moderate", fg: "#7ba8ff" },
  Tricky: { label: "Tricky", fg: "#ff9a7a" },
}

function PrioTag({ tag, small }: { tag: Prio; small?: boolean }) {
  const s = PRIO_STYLE[tag]
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: small ? "2px 7px" : "3px 9px",
        borderRadius: 100,
        fontFamily: "var(--font-mono)",
        fontSize: small ? 9 : 10,
        fontWeight: 600,
        background: s.bg,
        color: s.fg,
        border: `1px solid ${s.bd}`,
        whiteSpace: "nowrap",
      }}
    >
      {tag}
    </span>
  )
}

// Unified shape both real (BoardTopic) and demo (BoardPoint) data are mapped
// into for rendering — keeps the card markup below single-sourced.

// ─── 三套真题上传页 ──────────────────────────────────────────
// PRD §3: 三个并列的上传卡片（卷子1/2/3），至少一套有图即可"开始分析"；
// 点击后依次跑阶段一（1~3 次），再跑一次阶段二，期间显示进度提示。
type UploadProgress =
  | { kind: "idle" }
  | { kind: "set"; index: number; total: number }
  | { kind: "ranking" }

function ExamSlotCard({
  index,
  files,
  onChange,
  disabled,
}: {
  index: number
  files: File[]
  onChange: (files: File[]) => void
  disabled: boolean
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  return (
    <div
      style={{
        background: "rgba(255,255,255,0.03)",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 16,
        padding: 20,
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: 16,
          fontWeight: 700,
          color: WHITE,
        }}
      >
        Set {index + 1}
        {index > 0 && (
          <span
            style={{
              fontFamily: "var(--font-body)",
              fontSize: 11,
              fontWeight: 500,
              color: "rgba(255,255,255,0.35)",
              marginLeft: 8,
            }}
          >
            optional
          </span>
        )}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        disabled={disabled}
        style={{ display: "none" }}
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? [])
          if (picked.length > 0) onChange([...files, ...picked])
          if (fileRef.current) fileRef.current.value = ""
        }}
      />

      {files.length === 0 ? (
        <button
          disabled={disabled}
          onClick={() => fileRef.current?.click()}
          style={{
            height: 220,
            border: "1px dashed rgba(255,255,255,0.18)",
            borderRadius: 12,
            background: "transparent",
            color: "rgba(255,255,255,0.4)",
            fontFamily: "var(--font-body)",
            fontSize: 13,
            lineHeight: 1.5,
            padding: "0 16px",
            cursor: disabled ? "not-allowed" : "pointer",
          }}
        >
          Upload set {index + 1}{index > 0 ? " (optional)" : ""}
        </button>
      ) : (
        <div style={{ minHeight: 220, display: "flex", flexDirection: "column", gap: 12 }}>
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              color: LIME,
            }}
          >
            {files.length} uploaded
          </div>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
            }}
          >
            {files.map((f, i) => (
              <div
                key={i}
                style={{
                  position: "relative",
                  width: 68,
                  height: 68,
                  borderRadius: 8,
                  overflow: "hidden",
                  border: "1px solid rgba(255,255,255,0.1)",
                }}
              >
                <img
                  src={URL.createObjectURL(f)}
                  alt=""
                  style={{ width: "100%", height: "100%", objectFit: "cover" }}
                />
                {!disabled && (
                  <button
                    onClick={() => onChange(files.filter((_, fi) => fi !== i))}
                    style={{
                      position: "absolute",
                      top: 2,
                      right: 2,
                      width: 18,
                      height: 18,
                      borderRadius: "50%",
                      border: "none",
                      background: "rgba(0,0,0,0.6)",
                      color: WHITE,
                      fontSize: 11,
                      lineHeight: "18px",
                      cursor: "pointer",
                      padding: 0,
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
          <button
            disabled={disabled}
            onClick={() => fileRef.current?.click()}
            style={{
              alignSelf: "flex-start",
              background: "transparent",
              border: "none",
              color: BLUE,
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              cursor: disabled ? "not-allowed" : "pointer",
              padding: 0,
              marginTop: "auto",
            }}
          >
            + Add more
          </button>
        </div>
      )}
    </div>
  )
}

function ExamUploadPage({
  subject,
  onBack,
  onAnalysisComplete,
}: {
  subject: Subject | undefined
  onBack: () => void
  onAnalysisComplete: (topics: BoardTopic[]) => void
}) {
  const [slots, setSlots] = useState<File[][]>([[], [], []])
  const [progress, setProgress] = useState<UploadProgress>({ kind: "idle" })
  const [error, setError] = useState<string | null>(null)
  const analyzing = progress.kind !== "idle"
  const filledCount = slots.filter((s) => s.length > 0).length

  const progressLabel =
    progress.kind === "set"
      ? `Scanning set ${progress.index}/${progress.total}…`
      : progress.kind === "ranking"
        ? "Cross-referencing & ranking…"
        : ""

  const startAnalysis = () => {
    if (!subject || filledCount === 0 || analyzing) return
    setError(null)
    setProgress({ kind: "set", index: 1, total: filledCount })
    runExamPointAnalysis(slots, subject.name, (step) => {
      if (step.kind === "set")
        setProgress({ kind: "set", index: step.index, total: step.total })
      else setProgress({ kind: "ranking" })
    })
      .then((topics) => {
        if (topics.length === 0) {
          setError("No valid topics returned — please retry or check image clarity.")
          return
        }
        onAnalysisComplete(topics)
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Analysis failed — please try again.")
      })
      .finally(() => setProgress({ kind: "idle" }))
  }

  return (
    <section style={{ padding: "48px 80px 100px", minHeight: "calc(100vh - 64px)" }}>
      <div style={{ maxWidth: 900, margin: "0 auto" }}>
        <button
          onClick={onBack}
          disabled={analyzing}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            marginBottom: 24,
            padding: "6px 12px",
            background: "transparent",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 8,
            color: "rgba(255,255,255,0.6)",
            fontSize: 12,
            fontFamily: "var(--font-body)",
            cursor: analyzing ? "not-allowed" : "pointer",
          }}
        >
          ← Back
        </button>

        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: LIME,
            letterSpacing: "0.12em",
            marginBottom: 12,
          }}
        >
          UPLOAD PAST PAPERS
        </div>
        <h1
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: 34,
            fontWeight: 800,
            letterSpacing: "-0.025em",
            color: WHITE,
            margin: "0 0 28px",
            lineHeight: 1.1,
          }}
        >
          {subject?.name ?? "Your subject"} — Upload Past Papers
        </h1>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 20, marginBottom: 16 }}>
          {slots.map((files, i) => (
            <ExamSlotCard
              key={i}
              index={i}
              files={files}
              disabled={analyzing}
              onChange={(next) =>
                setSlots((prev) => prev.map((s, si) => (si === i ? next : s)))
              }
            />
          ))}
        </div>

        <p
          style={{
            fontFamily: "var(--font-body)",
            fontSize: 13,
            color: "rgba(255,255,255,0.35)",
            margin: "0 0 24px",
          }}
        >
          3 sets recommended — more data means sharper pattern detection.
        </p>

        <button
          disabled={filledCount === 0 || analyzing}
          onClick={startAnalysis}
          style={{
            width: "100%",
            padding: "13px",
            borderRadius: 10,
            border: "none",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            background: LIME,
            color: NAVY,
            fontFamily: "var(--font-sans)",
            fontSize: 14,
            fontWeight: 700,
            cursor: filledCount === 0 || analyzing ? "not-allowed" : "pointer",
            opacity: filledCount === 0 || analyzing ? 0.55 : 1,
          }}
        >
          {analyzing && (
            <span
              style={{
                width: 14,
                height: 14,
                borderRadius: "50%",
                border: `2px solid ${NAVY}55`,
                borderTopColor: NAVY,
                animation: "spin 0.7s linear infinite",
              }}
            />
          )}
          {analyzing ? progressLabel : "Start Analysis"}
        </button>

        {error && (
          <div
            style={{
              marginTop: 14,
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "#ff9a7a",
            }}
          >
            {error}
          </div>
        )}
      </div>
    </section>
  )
}

// Unified shape both real (BoardTopic) and demo (BoardPoint) data are mapped
// into for rendering — keeps the card markup below single-sourced.
interface RankedPoint {
  id: string
  name: string
  freq: number
  totalSets?: number
  score?: number
  priority: Prio
  difficulty?: string // 仅大题有意义
  done?: boolean
  questions?: BoardQuestionRef[]
  insight?: string
  steps?: string[]
  coreKnowledge?: string
  pitfalls?: string
  tags?: string[]
  isDemo: boolean // demo 数据不可编辑/删除/打勾
}

const EASY_DIFFICULTY_LABELS = new Set(["简单好上手/套路死板", "套路固定"])
const PRIO_RANK: Record<Prio, number> = { "Must Do": 0, Important: 1, Optional: 2 }

// ─── 复习流程（首页内嵌 section，放在 Hero 和 HowItWorks 中间） ──────────
// 对应用户的真实复习循环：上传分析 → 学新知识 prompt → 自己做卷 → 复盘
// prompt → 打勾清单。编号步骤 + 竖向连接线，样式按站内暗色主题重做（不是
// 照抄参考图里的手绘曲线，只保留"编号+连接线串起来"的核心感觉）。
interface FlowStep {
  n: number
  title: string
  desc: string
  cta?: string
  onClick?: () => void
  copyText?: string
}

function RevisionFlowSection({
  subject,
  doneSteps,
  onToggleStep,
  onOpenUpload,
  onOpenPrompt,
}: {
  subject: Subject | undefined
  doneSteps: number[]
  onToggleStep: (n: number) => void
  onOpenUpload: () => void
  onOpenPrompt: () => void
}) {
  const { ref, visible } = useReveal()
  const [copiedStep, setCopiedStep] = useState<number | null>(null)
  const subjectName = subject?.name ?? "this subject"

  const copy = (n: number, text: string) => {
    navigator.clipboard?.writeText(text)
    setCopiedStep(n)
    setTimeout(() => setCopiedStep((cur) => (cur === n ? null : cur)), 1800)
  }

  const steps: FlowStep[] = [
    {
      n: 1,
      title: "Upload 3 past papers",
      desc: "Upload your last few years of past papers — AI surfaces the must-know topics and jumps to your exam board when it's done.",
      cta: "Upload",
      onClick: onOpenUpload,
    },
    {
      n: 2,
      title: 'Copy the "learn a topic" prompt',
      desc: "For any topic you haven't mastered yet, head to Prompt Center for a worked-example prompt you can build on.",
      cta: "Open Prompt Center",
      onClick: onOpenPrompt,
    },
    {
      n: 3,
      title: "Do a past paper yourself",
      desc: "Pick a paper you haven't seen, time yourself, and don't peek at the answers.",
    },
    {
      n: 4,
      title: 'Copy the "review" prompt for Gemini',
      desc: "Fixed template, one click to copy — paste it into Gemini for a question-by-question breakdown.",
      cta: copiedStep === 4 ? "Copied ✓" : "Copy prompt",
      copyText: buildPracticeReviewTemplate(subjectName),
    },
    {
      n: 5,
      title: "Mark it done",
      desc: "Once you've reviewed a topic, tick it off on your exam board.",
    },
  ]

  return (
    <section
      ref={ref}
      id="revision-flow"
      style={{
        padding: "100px 80px",
        background: "rgba(255,255,255,0.015)",
        borderTop: "1px solid rgba(255,255,255,0.05)",
        borderBottom: "1px solid rgba(255,255,255,0.05)",
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(40px)",
        transition: "opacity 0.7s ease, transform 0.7s ease",
      }}
    >
      <div style={{ maxWidth: 720, margin: "0 auto" }}>
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: BLUE,
            letterSpacing: "0.12em",
            marginBottom: 12,
          }}
        >
          REVISION FLOW
        </div>
        <h2
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: 34,
            fontWeight: 800,
            letterSpacing: "-0.025em",
            color: WHITE,
            margin: "0 0 32px",
            lineHeight: 1.1,
          }}
        >
          {subjectName} — Revision Flow
        </h2>

        {/* Numbered steps, connected by a vertical rail */}
        <div style={{ position: "relative" }}>
          {steps.map((s, i) => {
            const done = doneSteps.includes(s.n)
            return (
            <div key={s.n} style={{ display: "flex", gap: 20, position: "relative" }}>
              {/* Rail: number dot (click to mark done) + connecting line down to next step */}
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0 }}>
                <button
                  onClick={() => onToggleStep(s.n)}
                  title={done ? "Mark as not done" : "Mark as done"}
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: "50%",
                    background: done ? LIME : `${BLUE}18`,
                    border: `1.5px solid ${done ? LIME : `${BLUE}66`}`,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontFamily: "var(--font-mono)",
                    fontSize: 13,
                    fontWeight: 700,
                    color: done ? NAVY : BLUE,
                    flexShrink: 0,
                    cursor: "pointer",
                    padding: 0,
                    transition: "background 0.15s, border-color 0.15s, color 0.15s",
                  }}
                >
                  {done ? (
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <path
                        d="M2.5 7l3 3 6-6"
                        stroke={NAVY}
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  ) : (
                    s.n
                  )}
                </button>
                {i < steps.length - 1 && (
                  <div
                    style={{
                      width: 2,
                      flex: 1,
                      minHeight: 44,
                      background: done
                        ? "linear-gradient(rgba(146,236,71,0.5), rgba(255,255,255,0.08))"
                        : "linear-gradient(rgba(50,106,253,0.45), rgba(255,255,255,0.08))",
                      margin: "4px 0",
                    }}
                  />
                )}
              </div>

              {/* Content */}
              <div style={{ paddingBottom: 36, flex: 1 }}>
                <h3
                  style={{
                    fontFamily: "var(--font-sans)",
                    fontSize: 16,
                    fontWeight: 700,
                    color: WHITE,
                    margin: "4px 0 6px",
                  }}
                >
                  {s.title}
                </h3>
                <p
                  style={{
                    fontFamily: "var(--font-body)",
                    fontSize: 13,
                    color: "rgba(255,255,255,0.5)",
                    lineHeight: 1.65,
                    margin: "0 0 12px",
                    maxWidth: 520,
                  }}
                >
                  {s.desc}
                </p>
                {s.cta && (
                  <button
                    onClick={() =>
                      s.copyText ? copy(s.n, s.copyText) : s.onClick?.()
                    }
                    style={{
                      padding: "8px 16px",
                      borderRadius: 8,
                      border: "none",
                      background:
                        s.copyText && copiedStep === s.n ? `${LIME}20` : LIME,
                      color: s.copyText && copiedStep === s.n ? LIME : NAVY,
                      fontFamily: "var(--font-sans)",
                      fontSize: 12.5,
                      fontWeight: 700,
                      cursor: "pointer",
                    }}
                  >
                    {s.cta}
                  </button>
                )}
              </div>
            </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

function ExamBoard({
  subject,
  topics: realTopicsProp,
  canRevert,
  onRevert,
  onChangeTopics,
  onBack,
}: {
  subject: Subject | undefined
  topics?: BoardTopic[]
  canRevert: boolean
  onRevert: () => void
  onChangeTopics: (next: BoardTopic[]) => void
  onBack: () => void
}) {
  const hasRealData = !!realTopicsProp && realTopicsProp.length > 0
  const [detailId, setDetailId] = useState<string | null>(null)
  const [editId, setEditId] = useState<string | null>(null)

  const toRanked = (t: BoardTopic, i: number, category: "big" | "small"): RankedPoint => ({
    id: t.id ?? `${category}-${i}-${t.name}`,
    name: t.name,
    freq: t.freq ?? 0,
    totalSets: t.totalSets,
    score: t.score,
    priority: (t.priority as Prio) ?? "Optional",
    difficulty: t.difficulty,
    done: t.done,
    questions: t.questions,
    insight: t.insight,
    steps: t.steps,
    coreKnowledge: t.coreKnowledge,
    pitfalls: t.pitfalls,
    tags: t.tags,
    isDemo: false,
  })

  // Group by priority (Must Do block → Important block → Optional block);
  // within a block keep the order Dify already returned (it's sorted by
  // frequency/difficulty inside each priority tier).
  const groupSort = (points: RankedPoint[]) =>
    [...points].sort((a, b) => PRIO_RANK[a.priority] - PRIO_RANK[b.priority])

  const bigPoints: RankedPoint[] = hasRealData
    ? groupSort(
        realTopicsProp!
          .map((t, i) => ({ t, i }))
          .filter(({ t }) => (t.category ?? "big") === "big")
          .map(({ t, i }) => toRanked(t, i, "big")),
      )
    : []
  const smallPoints: RankedPoint[] = hasRealData
    ? groupSort(
        realTopicsProp!
          .map((t, i) => ({ t, i }))
          .filter(({ t }) => t.category === "small")
          .map(({ t, i }) => toRanked(t, i, "small")),
      )
    : []

  // No real data yet: fall back to the static demo board, all shown under
  // the 大题 section (the demo data predates the big/small split).
  const demoDiffRank: Record<string, number> = { Formulaic: 0, Moderate: 1, Tricky: 2 }
  const demoPoints: RankedPoint[] = !hasRealData
    ? [...EXAM_BOARD]
        .sort(
          (a, b) =>
            b.freq - a.freq ||
            demoDiffRank[a.difficulty] - demoDiffRank[b.difficulty] ||
            Number(b.beginner) - Number(a.beginner),
        )
        .map((p, i) => ({
          id: `demo-${i}-${p.name}`,
          name: p.name,
          freq: p.freq,
          priority: p.tag,
          difficulty:
            p.difficulty === "Formulaic"
              ? "套路固定"
              : p.difficulty === "Tricky"
                ? "综合灵活"
                : "中等",
          isDemo: true,
        }))
    : []

  const allReal = [...bigPoints, ...smallPoints]
  const totalPoints = hasRealData ? allReal.length : demoPoints.length
  const mustCount = hasRealData
    ? allReal.filter((p) => p.priority === "Must Do").length
    : demoPoints.filter((p) => p.priority === "Must Do").length

  const updateReal = (mutate: (topics: BoardTopic[]) => BoardTopic[]) => {
    if (!realTopicsProp) return
    onChangeTopics(mutate(realTopicsProp))
  }
  const toggleDone = (id: string) =>
    updateReal((topics) =>
      topics.map((t, i) =>
        (t.id ?? `${t.category ?? "big"}-${i}-${t.name}`) === id
          ? { ...t, done: !t.done }
          : t,
      ),
    )
  const deleteTopic = (id: string) =>
    updateReal((topics) =>
      topics.filter((t, i) => (t.id ?? `${t.category ?? "big"}-${i}-${t.name}`) !== id),
    )
  const saveEdit = (id: string, patch: Partial<BoardTopic>) =>
    updateReal((topics) =>
      topics.map((t, i) =>
        (t.id ?? `${t.category ?? "big"}-${i}-${t.name}`) === id ? { ...t, ...patch } : t,
      ),
    )

  const detailPoint = allReal.find((p) => p.id === detailId)
  const editPoint = allReal.find((p) => p.id === editId)

  const eyebrow = {
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    color: LIME,
    letterSpacing: "0.12em",
    marginBottom: 12,
  } as const

  const renderCard = (p: RankedPoint, idx: number) => {
    const isEasy = p.difficulty ? EASY_DIFFICULTY_LABELS.has(p.difficulty) : false
    const freqLabel =
      !p.isDemo && p.totalSets ? `${p.freq}/${p.totalSets}` : `${p.freq}×`
    return (
      <div
        key={p.id}
        onClick={() => !p.isDemo && setDetailId(p.id)}
        style={{
          background: "rgba(255,255,255,0.03)",
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 16,
          padding: "16px 22px",
          display: "flex",
          alignItems: "center",
          gap: 16,
          opacity: p.done ? 0.45 : 1,
          cursor: p.isDemo ? "default" : "pointer",
          transition: "opacity 0.15s, border-color 0.15s",
        }}
        onMouseEnter={(e) => {
          if (!p.isDemo)
            (e.currentTarget as HTMLDivElement).style.borderColor = "rgba(255,255,255,0.18)"
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLDivElement).style.borderColor = "rgba(255,255,255,0.08)"
        }}
      >
        {/* Done checkbox */}
        {!p.isDemo && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              toggleDone(p.id)
            }}
            title={p.done ? "Mark as not done" : "Mark as done"}
            style={{
              flexShrink: 0,
              width: 22,
              height: 22,
              borderRadius: 6,
              border: `1.5px solid ${p.done ? LIME : "rgba(255,255,255,0.25)"}`,
              background: p.done ? LIME : "transparent",
              color: NAVY,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              padding: 0,
            }}
          >
            {p.done && (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path
                  d="M2 6l2.5 2.5L10 3"
                  stroke={NAVY}
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </button>
        )}

        {/* Rank */}
        <div
          style={{
            flexShrink: 0,
            width: 30,
            height: 30,
            borderRadius: 8,
            background: idx === 0 ? `${LIME}18` : "rgba(255,255,255,0.05)",
            border: `1px solid ${idx === 0 ? `${LIME}40` : "rgba(255,255,255,0.1)"}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: "var(--font-mono)",
            fontSize: 13,
            fontWeight: 700,
            color: idx === 0 ? LIME : "rgba(255,255,255,0.5)",
          }}
        >
          {idx + 1}
        </div>

        {/* Name + meta */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 6,
              flexWrap: "wrap",
            }}
          >
            <span
              style={{
                fontFamily: "var(--font-sans)",
                fontSize: 16,
                fontWeight: 700,
                color: WHITE,
                textDecoration: p.done ? "line-through" : "none",
              }}
            >
              {p.name}
              {p.score != null && (
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 12,
                    fontWeight: 500,
                    color: "rgba(255,255,255,0.4)",
                    marginLeft: 6,
                  }}
                >
                  ({p.score}分)
                </span>
              )}
            </span>
            <PrioTag tag={p.priority} small />
            {isEasy && (
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                  color: LIME,
                }}
              >
                💡 Easy win
              </span>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "rgba(255,255,255,0.45)" }}>
              <span style={{ color: WHITE }}>{freqLabel}</span> across sets
            </span>
            {p.difficulty && (
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "rgba(255,255,255,0.45)" }}>
                ◆ {p.difficulty}
              </span>
            )}
          </div>
        </div>

        {/* Edit / delete */}
        {!p.isDemo && (
          <div style={{ flexShrink: 0, display: "flex", gap: 6 }}>
            <button
              onClick={(e) => {
                e.stopPropagation()
                setEditId(p.id)
              }}
              title="Edit"
              style={{
                width: 28,
                height: 28,
                borderRadius: 7,
                border: "1px solid rgba(255,255,255,0.12)",
                background: "transparent",
                color: "rgba(255,255,255,0.5)",
                cursor: "pointer",
              }}
            >
              ✎
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation()
                if (confirm(`Delete "${p.name}"?`)) deleteTopic(p.id)
              }}
              title="Delete"
              style={{
                width: 28,
                height: 28,
                borderRadius: 7,
                border: "1px solid rgba(255,255,255,0.12)",
                background: "transparent",
                color: "rgba(255,255,255,0.5)",
                cursor: "pointer",
              }}
            >
              ×
            </button>
          </div>
        )}
      </div>
    )
  }

  const renderSection = (title: string, points: RankedPoint[]) => (
    <div style={{ marginBottom: 32 }}>
      <div
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: 15,
          fontWeight: 800,
          color: WHITE,
          marginBottom: 12,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        {title}
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            fontWeight: 500,
            color: "rgba(255,255,255,0.35)",
          }}
        >
          {points.length}
        </span>
      </div>
      {points.length === 0 ? (
        <p
          style={{
            fontFamily: "var(--font-body)",
            fontSize: 12.5,
            color: "rgba(255,255,255,0.4)",
            margin: 0,
          }}
        >
          No data yet.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {points.map((p, idx) => renderCard(p, idx))}
        </div>
      )}
    </div>
  )

  return (
    <section
      style={{ padding: "48px 80px 100px", minHeight: "calc(100vh - 64px)" }}
    >
      <div style={{ maxWidth: 1040, margin: "0 auto" }}>
        {/* Back + revert */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 24 }}>
          <button
            onClick={onBack}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 12px",
              background: "transparent",
              border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: 8,
              color: "rgba(255,255,255,0.6)",
              fontSize: 12,
              fontFamily: "var(--font-body)",
              cursor: "pointer",
              transition: "all 0.15s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = WHITE
              e.currentTarget.style.borderColor = "rgba(255,255,255,0.28)"
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "rgba(255,255,255,0.6)"
              e.currentTarget.style.borderColor = "rgba(255,255,255,0.12)"
            }}
          >
            ← Back to Priority Board
          </button>
          {canRevert && (
            <button
              onClick={() => {
                if (confirm("Revert to the previous analysis? Current board edits will be lost.")) onRevert()
              }}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "6px 12px",
                background: "transparent",
                border: "1px solid rgba(255,154,122,0.35)",
                borderRadius: 8,
                color: "#ff9a7a",
                fontSize: 12,
                fontFamily: "var(--font-body)",
                cursor: "pointer",
              }}
            >
              ↺ Revert last analysis
            </button>
          )}
        </div>

        <div style={eyebrow}>EXAM-POINT BOARD</div>
        <h1
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: 38,
            fontWeight: 800,
            letterSpacing: "-0.025em",
            color: WHITE,
            margin: "0 0 14px",
            lineHeight: 1.1,
          }}
        >
          {subject?.name ?? "Your subject"}
        </h1>
        <p
          style={{
            fontFamily: "var(--font-body)",
            fontSize: 15,
            color: "rgba(255,255,255,0.45)",
            lineHeight: 1.7,
            margin: "0 0 28px",
            maxWidth: 620,
          }}
        >
          Topics are grouped Must Do → Important → Optional, sorted by frequency then difficulty within each group — work top to bottom. Click a card for questions, patterns, and steps; tick to mark done; ✎ to edit, × to delete.
        </p>

        {/* Summary + legend */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 24,
            padding: "14px 20px",
            marginBottom: 28,
            background: "rgba(255,255,255,0.03)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 12,
          }}
        >
          {[
            { n: totalPoints, l: "Exam points" },
            { n: mustCount, l: "Must-do topics" },
          ].map((s) => (
            <div key={s.l} style={{ display: "flex", flexDirection: "column" }}>
              <span
                style={{
                  fontFamily: "var(--font-sans)",
                  fontSize: 20,
                  fontWeight: 800,
                  color: WHITE,
                  lineHeight: 1,
                }}
              >
                {s.n}
              </span>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 9,
                  color: "rgba(255,255,255,0.35)",
                  letterSpacing: "0.06em",
                  marginTop: 4,
                }}
              >
                {s.l.toUpperCase()}
              </span>
            </div>
          ))}
          <div style={{ flex: 1 }} />
          <div style={{ display: "flex", gap: 8 }}>
            {(["Must Do", "Important", "Optional"] as Prio[]).map((t) => (
              <PrioTag key={t} tag={t} small />
            ))}
          </div>
        </div>

        {hasRealData ? (
          <>
            {renderSection("Big Questions", bigPoints)}
            {renderSection("Short Questions", smallPoints)}
          </>
        ) : (
          renderSection("Big Questions (demo data)", demoPoints)
        )}
      </div>

      {detailPoint && (
        <TopicDetailModal point={detailPoint} onClose={() => setDetailId(null)} />
      )}
      {editPoint && (
        <TopicEditModal
          point={editPoint}
          onClose={() => setEditId(null)}
          onSave={(patch) => {
            saveEdit(editPoint.id, patch)
            setEditId(null)
          }}
        />
      )}
    </section>
  )
}

// ─── 考点详情弹窗 ────────────────────────────────────────────
function ModalShell({
  onClose,
  children,
  title,
}: {
  onClose: () => void
  children: React.ReactNode
  title: string
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#10191f",
          border: "1px solid rgba(255,255,255,0.1)",
          borderRadius: 18,
          padding: 32,
          maxWidth: 880,
          width: "100%",
          maxHeight: "88vh",
          overflowY: "auto",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <h3
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: 20,
              fontWeight: 800,
              color: WHITE,
              margin: 0,
            }}
          >
            {title}
          </h3>
          <button
            onClick={onClose}
            style={{
              width: 28,
              height: 28,
              borderRadius: 7,
              border: "1px solid rgba(255,255,255,0.12)",
              background: "transparent",
              color: "rgba(255,255,255,0.5)",
              cursor: "pointer",
            }}
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 10.5,
          color: LIME,
          letterSpacing: "0.06em",
          marginBottom: 8,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  )
}

function EmptyHint() {
  return (
    <p
      style={{
        fontFamily: "var(--font-body)",
        fontSize: 12.5,
        color: "rgba(255,255,255,0.3)",
        margin: 0,
        fontStyle: "italic",
      }}
    >
      No data yet — needs a Dify prompt/schema update, then re-run analysis.
    </p>
  )
}

function TopicDetailModal({ point, onClose }: { point: RankedPoint; onClose: () => void }) {
  const pitfallLines = point.pitfalls
    ? point.pitfalls.split("\n").map((l) => l.trim()).filter(Boolean)
    : []
  const subtitleParts = [
    point.totalSets ? `${point.freq}/${point.totalSets} sets` : `${point.freq}× across sets`,
    point.score != null ? `${point.score}分` : null,
    point.difficulty,
  ].filter(Boolean)

  return (
    <ModalShell onClose={onClose} title={point.name}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: -10, marginBottom: 24 }}>
        <PrioTag tag={point.priority} small />
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "rgba(255,255,255,0.45)" }}>
          {subtitleParts.join(" · ")}
        </span>
      </div>

      {point.tags?.length ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 24 }}>
          {point.tags.map((t, i) => (
            <span
              key={i}
              style={{
                padding: "4px 12px",
                borderRadius: 100,
                background: `${BLUE}15`,
                border: `1px solid ${BLUE}40`,
                color: "#8fb3ff",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
              }}
            >
              {t}
            </span>
          ))}
        </div>
      ) : null}

      <DetailSection title="Original Questions (3 Sets)">
        {point.questions?.length ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {point.questions.map((q, i) => (
              <div
                key={i}
                style={{
                  padding: "12px 14px",
                  background: "rgba(255,255,255,0.03)",
                  border: "1px solid rgba(255,255,255,0.06)",
                  borderRadius: 10,
                }}
              >
                <div
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 10,
                    color: "#7ba8ff",
                    marginBottom: 4,
                  }}
                >
                  Set {q.setIndex} {q.questionNo ?? ""}
                </div>
                <div style={{ fontFamily: "var(--font-body)", fontSize: 13.5, color: "rgba(255,255,255,0.8)", lineHeight: 1.6 }}>
                  {q.questionText ?? "(no original text)"}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyHint />
        )}
      </DetailSection>

      <DetailSection title="Nature of the Topic & Pattern">
        {point.insight ? (
          <div
            style={{
              padding: "14px 16px",
              background: "rgba(146,120,255,0.08)",
              borderLeft: "3px solid #9278ff",
              borderRadius: "0 10px 10px 0",
            }}
          >
            <p style={{ fontFamily: "var(--font-body)", fontSize: 13.5, color: "rgba(255,255,255,0.85)", lineHeight: 1.7, margin: 0 }}>
              {point.insight}
            </p>
          </div>
        ) : (
          <EmptyHint />
        )}
      </DetailSection>

      <DetailSection title="Steps to Master It">
        {point.steps?.length ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {point.steps.map((s, i) => (
              <div key={i} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                <div
                  style={{
                    flexShrink: 0,
                    width: 22,
                    height: 22,
                    borderRadius: "50%",
                    background: `${BLUE}20`,
                    border: `1px solid ${BLUE}55`,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    fontWeight: 700,
                    color: "#8fb3ff",
                    marginTop: 1,
                  }}
                >
                  {i + 1}
                </div>
                <p style={{ fontFamily: "var(--font-body)", fontSize: 13.5, color: "rgba(255,255,255,0.8)", lineHeight: 1.6, margin: 0, paddingTop: 2 }}>
                  {s}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <EmptyHint />
        )}
      </DetailSection>

      <DetailSection title="Core Knowledge / Formulas / Definitions">
        {point.coreKnowledge ? (
          <div
            style={{
              padding: "14px 16px",
              background: `${BLUE}10`,
              border: `1px solid ${BLUE}30`,
              borderRadius: 10,
            }}
          >
            <p style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "rgba(255,255,255,0.85)", lineHeight: 1.8, margin: 0, whiteSpace: "pre-wrap" }}>
              {point.coreKnowledge}
            </p>
          </div>
        ) : (
          <EmptyHint />
        )}
      </DetailSection>

      <DetailSection title="Common Pitfalls">
        {pitfallLines.length ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {pitfallLines.map((line, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  gap: 8,
                  padding: "10px 14px",
                  background: "rgba(255,193,71,0.08)",
                  border: "1px solid rgba(255,193,71,0.3)",
                  borderRadius: 10,
                }}
              >
                <span style={{ flexShrink: 0 }}>⚠️</span>
                <p style={{ fontFamily: "var(--font-body)", fontSize: 13, color: "#ffd699", lineHeight: 1.6, margin: 0 }}>
                  {line}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <EmptyHint />
        )}
      </DetailSection>
    </ModalShell>
  )
}

// ─── 考点编辑弹窗 ────────────────────────────────────────────
function TopicEditModal({
  point,
  onClose,
  onSave,
}: {
  point: RankedPoint
  onClose: () => void
  onSave: (patch: Partial<BoardTopic>) => void
}) {
  const [name, setName] = useState(point.name)
  const [score, setScore] = useState(point.score != null ? String(point.score) : "")
  const [freq, setFreq] = useState(point.freq != null ? String(point.freq) : "")
  const [priority, setPriority] = useState<Prio>(point.priority)
  const [difficulty, setDifficulty] = useState(point.difficulty ?? "")

  const fieldLabel = {
    fontFamily: "var(--font-mono)",
    fontSize: 10,
    color: "rgba(255,255,255,0.4)",
    letterSpacing: "0.06em",
    marginBottom: 6,
    display: "block",
  } as const
  const inputStyle = {
    width: "100%",
    padding: "9px 12px",
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 8,
    color: WHITE,
    fontFamily: "var(--font-body)",
    fontSize: 13,
    outline: "none",
    boxSizing: "border-box" as const,
  }

  return (
    <ModalShell onClose={onClose} title="Edit topic">
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <label style={fieldLabel}>Topic name</label>
          <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div style={{ display: "flex", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <label style={fieldLabel}>Score</label>
            <input
              style={inputStyle}
              type="number"
              value={score}
              onChange={(e) => setScore(e.target.value)}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label style={fieldLabel}>Frequency (# of sets)</label>
            <input
              style={inputStyle}
              type="number"
              value={freq}
              onChange={(e) => setFreq(e.target.value)}
            />
          </div>
        </div>
        <div>
          <label style={fieldLabel}>Priority</label>
          <div style={{ display: "flex", gap: 8 }}>
            {(["Must Do", "Important", "Optional"] as Prio[]).map((p) => (
              <button
                key={p}
                onClick={() => setPriority(p)}
                style={{
                  padding: "6px 12px",
                  borderRadius: 7,
                  border: `1px solid ${priority === p ? LIME : "rgba(255,255,255,0.15)"}`,
                  background: priority === p ? `${LIME}18` : "transparent",
                  color: priority === p ? LIME : "rgba(255,255,255,0.6)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  cursor: "pointer",
                }}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
        {point.difficulty !== undefined || true ? (
          <div>
            <label style={fieldLabel}>Difficulty (big questions only)</label>
            <input
              style={inputStyle}
              value={difficulty}
              placeholder="套路固定 / 中等 / 综合灵活"
              onChange={(e) => setDifficulty(e.target.value)}
            />
          </div>
        ) : null}
        <button
          onClick={() =>
            onSave({
              name: name.trim() || point.name,
              score: score.trim() ? Number(score) : undefined,
              freq: freq.trim() ? Number(freq) : undefined,
              priority,
              difficulty: difficulty.trim() || undefined,
            })
          }
          style={{
            marginTop: 4,
            padding: "11px",
            borderRadius: 9,
            border: "none",
            background: LIME,
            color: NAVY,
            fontFamily: "var(--font-sans)",
            fontSize: 13,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Save
        </button>
      </div>
    </ModalShell>
  )
}

// ─── Full-page starfield ──────────────────────────────────────
// Fixed background layer of scattered stars + faint constellation figures,
// spread across the whole page behind all content.
function StarField() {
  // scrollTop drives parallax drift; progress (0–1) drives which constellations
  // are visible. Three star layers drift at different speeds for a depth feel.
  const [scrollTop, setScrollTop] = useState(0)
  const [progress, setProgress] = useState(0)

  useEffect(() => {
    const el = document.getElementById("page-scroll")
    if (!el) return
    const onScroll = () => {
      const max = el.scrollHeight - el.clientHeight
      setScrollTop(el.scrollTop)
      setProgress(max > 0 ? el.scrollTop / max : 0)
    }
    onScroll()
    el.addEventListener("scroll", onScroll, { passive: true })
    return () => el.removeEventListener("scroll", onScroll)
  }, [])

  // Background=slow (feels far), midground, foreground=fast (feels near).
  // The container is 300vh tall starting at top=-100vh so the middle third
  // sits in the viewport at rest. Drifting by up to ~50vh is safe within
  // the 100vh buffers above/below.
  const LAYER_SPEED = [0.12, 0.32, 0.62]

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 0,
        pointerEvents: "none",
        overflow: "hidden",
      }}
    >
      {/* Scroll-reactive nebula — its position, hue and intensity shift as you
          scroll, so the whole backdrop visibly transforms top→bottom. */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `
          radial-gradient(ellipse 70% 55% at ${50 + progress * 26}% ${-12 + progress * 46}%,
            hsla(${222 - progress * 40}, 80%, 60%, ${0.16 - progress * 0.05}) 0%, transparent 60%),
          radial-gradient(ellipse 60% 50% at ${28 - progress * 20}% ${118 - progress * 42}%,
            hsla(${90 + progress * 20}, 70%, 55%, ${0.04 + progress * 0.07}) 0%, transparent 55%)
        `,
          transition: "background 0.2s linear",
        }}
      />

      <style>{`
        @keyframes star-twinkle {
          0%,100% { opacity: var(--base-o); }
          50%      { opacity: calc(var(--base-o) * 0.35); }
        }
      `}</style>
    </div>
  )
}

// ─── Root ─────────────────────────────────────────────────────
export default function App() {
  const [page, setPage] = useState<"home" | "prompt" | "board" | "assistant" | "schedule" | "uploadExams">("home")
const [howTab, setHowTab] = useState(0)
const overlayRef = useRef<HTMLDivElement>(null)

const goHome = () => setPage("home")

const navigateTo = (target: 'assistant' | 'board' | 'prompt' | 'schedule' | 'uploadExams') => {
  setPage(target)
  overlayRef.current?.scrollTo({ top: 0 })
}

const [chat, setChat] = useState<ChatMsg[]>([])
const [thinking, setThinking] = useState(false)

  const sendChat = async (text: string, image?: string) => {
    setChat((prev) => [
      ...prev,
      { role: "user", text: text || undefined, image },
    ])
    setThinking(true)
    try {
      const res = await fetch(`${DIFY_PROXY_BASE}?action=chat`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${publicAnonKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          inputs: {},
          query: text,
          response_mode: "blocking",
          user: "passmate-user",
        }),
      })
      const json = await res.json()
      const answer =
        json?.answer ?? "No response from the AI. Please try again."
      setChat((prev) => [...prev, { role: "assistant", text: answer }])
    } catch {
      setChat((prev) => [
        ...prev,
        {
          role: "assistant",
          text: "Failed to reach the AI. Check your network connection and try again.",
        },
      ])
    } finally {
      setThinking(false)
    }
  }
  const [dbLoaded, setDbLoaded] = useState(false)
  const [seeds, setSeeds] = useState<SubjectSeed[]>(SUBJECTS_DATA)
  const [checklists, setChecklists] = useState<Checklists>(() =>
    seedChecklists(SUBJECTS_DATA),
  )
  const [quickItems, setQuickItems] = useState<Record<string, CheckItem[]>>(
    () => Object.fromEntries(SUBJECTS_DATA.map((s) => [s.name, QUICK_ITEMS])),
  )
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [boardTopics, setBoardTopics] = useState<Record<string, BoardTopic[]>>(
    {},
  )
  // 上一次分析前的看板快照，按科目存一份，用于"撤回整体分析"（不持久化到
  // Supabase——只在本次会话里有效，够用，避免额外占用存储空间）。
  const [boardTopicsHistory, setBoardTopicsHistory] = useState<
    Record<string, BoardTopic[] | undefined>
  >({})
  const [subjectProgress, setSubjectProgress] =
    useState<Record<string, number>>({})
  // 复习流程 section 每个科目里点过"完成"的步骤编号，持久化到 Supabase。
  const [flowStepsDone, setFlowStepsDone] = useState<Record<string, number[]>>({})
  // 每个科目自己设的目标分数（及格保险线），默认 65，持久化到 Supabase。
  const [targetScores, setTargetScores] = useState<Record<string, number>>({})
  const [activeSubject, setActiveSubject] = useState(SUBJECTS_DATA[0].name)

  // Load from Supabase once on mount.
  // Handles two formats:
  //   • { seeds, checklists, quickItems, notes } — this app's own save format
  //   • { subjects: [{ name, progress, board_data: { topics: [...] } }] } — legacy format
  // Format B (seeds) is checked FIRST: this app only ever writes Format B, so
  // if it's present it's always the current data. A stale legacy `subjects`
  // field left over from an older save must never shadow newer Format B data
  // (that was the bug where a newly-added subject "disappeared" on refresh).
  useEffect(() => {
    loadState().then((saved) => {
      if (!saved) {
        setDbLoaded(true)
        return
      }

      // Format B: seeds/checklists/quickItems/notes (saved by this app)
      if (Array.isArray(saved.seeds) && saved.seeds.length > 0) {
        const savedSeeds = saved.seeds
        setSeeds(savedSeeds)
        setChecklists(() => {
          const out: Checklists = {}
          for (const s of savedSeeds)
            out[s.name] = saved.checklists?.[s.name] ?? makeChecklist(0)
          return out
        })
        if (saved.quickItems) setQuickItems(saved.quickItems)
        if (saved.notes) setNotes(saved.notes)
        if (saved.boardTopics) setBoardTopics(saved.boardTopics)
        if (saved.subjectProgress) setSubjectProgress(saved.subjectProgress)
        if (saved.flowStepsDone) setFlowStepsDone(saved.flowStepsDone)
        if (saved.targetScores) setTargetScores(saved.targetScores)
        setActiveSubject(saved.seeds[0].name)
      }
      // Format A: subjects array (legacy — only used if Format B was never saved)
      else if (Array.isArray(saved.subjects) && saved.subjects.length > 0) {
        const subjectList = saved.subjects as Array<{
          name: string
          examDate?: string
          color?: string
          progress?: number
          board_data?: { topics?: BoardTopic[] }
        }>
        const newSeeds: SubjectSeed[] = subjectList.map((s, i) => ({
          name: s.name,
          examDate: s.examDate ?? "",
          color: s.color ?? SUBJECT_COLORS[i % SUBJECT_COLORS.length],
        }))
        setSeeds(newSeeds)
        setChecklists(() => {
          const out: Checklists = {}
          for (const s of newSeeds) out[s.name] = makeChecklist(0)
          return out
        })
        const newTopics: Record<string, BoardTopic[]> = {}
        const newProgress: Record<string, number> = {}
        for (const s of subjectList) {
          if (s.board_data?.topics?.length)
            newTopics[s.name] = s.board_data.topics
          if (s.progress != null) newProgress[s.name] = s.progress
        }
        setBoardTopics(newTopics)
        setSubjectProgress(newProgress)
        setActiveSubject(newSeeds[0].name)
      }

      setDbLoaded(true)
    })
  }, [])

  // Debounce-save whenever persistent state changes (after first load).
  // `subjects: []` is sent explicitly to clear out any stale legacy Format-A
  // data still sitting in the record — otherwise it could keep shadowing
  // this save on a future load (see the priority note above).
  useEffect(() => {
    if (!dbLoaded) return
    scheduleSave({
      seeds,
      checklists,
      quickItems,
      notes,
      boardTopics,
      subjectProgress,
      flowStepsDone,
      targetScores,
      subjects: [],
    })
  }, [
    seeds,
    checklists,
    quickItems,
    notes,
    boardTopics,
    subjectProgress,
    flowStepsDone,
    targetScores,
    dbLoaded,
  ])

  // Single source of truth: progress is derived from each subject's checklist.
  const subjects = deriveSubjects(seeds, checklists)
  const active = subjects.find((s) => s.name === activeSubject) ?? subjects[0]
  const activeItems = (active && checklists[active.name]) ?? []
  const analysisDone = activeItems.some(
    (i) => i.id === ANALYSIS_ITEM_ID && i.done,
  )

  // Apply exam-modal edits: keep checklists/quickItems/notes for surviving subjects, seed new ones.
  const saveSeeds = (next: SubjectSeed[]) => {
    setChecklists((prev) => {
      const out: Checklists = {}
      for (const s of next) out[s.name] = prev[s.name] ?? makeChecklist(0)
      return out
    })
    setQuickItems((prev) => {
      const out: Record<string, CheckItem[]> = {}
      for (const s of next) out[s.name] = prev[s.name] ?? []
      return out
    })
    setNotes((prev) => {
      const out: Record<string, string> = {}
      for (const s of next) out[s.name] = prev[s.name] ?? ""
      return out
    })
    setSeeds(next)
    if (!next.some((s) => s.name === activeSubject) && next[0])
      setActiveSubject(next[0].name)
  }

  const toggleItem = (subjectName: string, id: number) => {
    setChecklists((prev) => ({
      ...prev,
      [subjectName]: (prev[subjectName] ?? []).map((i) =>
        i.id === id ? { ...i, done: !i.done } : i,
      ),
    }))
  }

  // Running the F1 analysis checks off its master-checklist item (the initial
  // progress chunk) — it never un-checks.
  const runAnalysis = (subjectName: string) => {
    setChecklists((prev) => ({
      ...prev,
      [subjectName]: (prev[subjectName] ?? []).map((i) =>
        i.id === ANALYSIS_ITEM_ID ? { ...i, done: true } : i,
      ),
    }))
  }
return (
  <div id="page-scroll" className="scrollable" style={{
    minHeight: "100vh",
    background: NAVY,
    overflowY: "auto",
    overflowX: "hidden",
    fontFamily: "var(--font-body)",
    color: WHITE,
    position: "relative",
  }}>
    <StarField />

    <div
      style={{
        position: "fixed",
        top: 0, left: 0, right: 0, bottom: 0,
        background: `radial-gradient(ellipse 80% 50% at 50% -10%, ${BLUE}18 0%, transparent 60%)`,
        pointerEvents: "none",
        zIndex: 0,
      }}
    />

    <div style={{ position: "relative", zIndex: 1 }}>
      <Nav
        subjects={subjects}
        active={activeSubject}
        onSelect={setActiveSubject}
      />

      <Hero
        subjects={subjects}
        onSave={saveSeeds}
        onToggleArchive={(name) => {
          setSeeds((prev) =>
            prev.map((s) => (s.name === name ? { ...s, archived: !s.archived } : s)),
          )
        }}
      />
      <RevisionFlowSection
        subject={active}
        doneSteps={active ? (flowStepsDone[active.name] ?? []) : []}
        onToggleStep={(n) => {
          if (!active) return
          setFlowStepsDone((prev) => {
            const cur = prev[active.name] ?? []
            const next = cur.includes(n) ? cur.filter((x) => x !== n) : [...cur, n]
            return { ...prev, [active.name]: next }
          })
        }}
        onOpenUpload={() => navigateTo("uploadExams")}
        onOpenPrompt={() => navigateTo("prompt")}
      />
      <HowItWorks
        tab={howTab}
        setTab={setHowTab}
        onAction={(id) => {
          if (id === "analyze") navigateTo("uploadExams")
          else if (id === "assistant") navigateTo("assistant")
          else if (id === "prompt") navigateTo("prompt")
          else if (id === "schedule") navigateTo("schedule")
        }}
      />
      <PastPapersSection
        subject={active}
        analysisDone={analysisDone}
        onOpenUpload={() => navigateTo("uploadExams")}
        topics={active ? boardTopics[active.name] : undefined}
        progressPct={active ? subjectProgress[active.name] : undefined}
        onOpenBoard={() => navigateTo("board")}
        onOpenPrompt={() => navigateTo("prompt")}
      />
      <MockExamSection
        chat={chat}
        onSend={sendChat}
        thinking={thinking}
        onExpand={() => navigateTo("assistant")}
        subject={active}
        targetScore={active ? (targetScores[active.name] ?? 65) : 65}
        onChangeTargetScore={(v) => {
          if (!active) return
          setTargetScores((prev) => ({ ...prev, [active.name]: v }))
        }}
        progressPct={
          active
            ? (subjectProgress[active.name] ??
              (active.total ? Math.round((active.completed / active.total) * 100) : 0))
            : 0
        }
        mustDoLeft={
          active
            ? (boardTopics[active.name] ?? []).filter(
                (t) => t.priority === "Must Do" && !t.done,
              ).length
            : 0
        }
        flowDoneCount={active ? (flowStepsDone[active.name]?.length ?? 0) : 0}
      />
      <Footer />
    </div>

    <div
      ref={overlayRef}
      className="scrollable"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: NAVY,
        overflowY: "auto",
        display: page === "home" ? "none" : "block",
      }}
    >
      {page === "prompt" && (
        <PromptCenter subjects={subjects} boardTopics={boardTopics} onBack={goHome} />
      )}
      {page === "schedule" && <SchedulePage subjects={subjects} onBack={goHome} />}
      {page === "board" && (
        <ExamBoard
          subject={active}
          topics={active ? boardTopics[active.name] : undefined}
          canRevert={!!(active && boardTopicsHistory[active.name])}
          onRevert={() => {
            if (!active) return
            const prevSnapshot = boardTopicsHistory[active.name]
            if (!prevSnapshot) return
            setBoardTopics((prev) => ({ ...prev, [active.name]: prevSnapshot }))
            setBoardTopicsHistory((prev) => ({ ...prev, [active.name]: undefined }))
          }}
          onChangeTopics={(next) => {
            if (!active) return
            setBoardTopics((prev) => ({ ...prev, [active.name]: next }))
          }}
          onBack={goHome}
        />
      )}
      {page === "uploadExams" && (
        <ExamUploadPage
          subject={active}
          onBack={goHome}
          onAnalysisComplete={(newTopics) => {
            if (!active) return
            setBoardTopicsHistory((prev) => ({
              ...prev,
              [active.name]: boardTopics[active.name],
            }))
            setBoardTopics((prev) => ({ ...prev, [active.name]: newTopics }))
            runAnalysis(active.name)
            navigateTo("board")
          }}
        />
      )}
      {page === "assistant" && (
        <section style={{ padding: "48px 80px 80px", minHeight: "80vh" }}>
          <div style={{ maxWidth: 900, margin: "0 auto" }}>
            <div style={{ textAlign: "center", marginBottom: 32 }}>
              <div style={{
                fontFamily: "var(--font-mono)", fontSize: 11, color: BLUE,
                letterSpacing: "0.12em", marginBottom: 12,
              }}>
                AI SOLVER ASSISTANT
              </div>
              <h2 style={{
                fontFamily: "var(--font-sans)", fontSize: 40, fontWeight: 800,
                letterSpacing: "-0.025em", color: WHITE, margin: 0, lineHeight: 1.1,
              }}>
                Solve it together, step by step.
              </h2>
            </div>
            <AssistantPanel
              variant="page"
              messages={chat}
              onSend={sendChat}
              thinking={thinking}
              onBack={goHome}
            />
          </div>
        </section>
      )}
    </div>

    <ChecklistPanel
      subject={active}
      quickItems={active ? (quickItems[active.name] ?? []) : []}
      onQuickChange={(next) => {
        if (!active) return
        setQuickItems((prev) => ({ ...prev, [active.name]: next }))
      }}
      notes={active ? (notes[active.name] ?? "") : ""}
      onNotesChange={(v) => {
        if (!active) return
        setNotes((prev) => ({ ...prev, [active.name]: v }))
      }}
    />
  </div>
)
}