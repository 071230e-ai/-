import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-workers'
import { renderer } from './renderer'

type Bindings = {
  DB: D1Database
  SESSION_SECRET?: string
}

type Variables = {
  user?: { id: number; username: string; role: string; display_name: string }
}

type SessionUser = { id: number; username: string; role: string; display_name: string }

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()

app.use('/api/*', cors())
app.use(renderer)

// ====== ユーティリティ ======
async function sha256(text: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(text)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}

function getSessionSecret(c: any): string | null {
  const secret = String(c.env?.SESSION_SECRET || '').trim()
  return secret.length >= 32 ? secret : null
}

async function makeSessionToken(user: SessionUser, secret: string): Promise<string> {
  const payload = JSON.stringify({ ...user, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 })
  const b64 = btoa(unescape(encodeURIComponent(payload)))
  const sig = await sha256(b64 + secret)
  return `${b64}.${sig}`
}

async function verifySessionToken(token: string, secret: string): Promise<SessionUser | null> {
  try {
    const parts = token.split('.')
    if (parts.length !== 2) return null
    const [b64, sig] = parts
    const expectedSig = await sha256(b64 + secret)
    if (sig.length !== expectedSig.length) return null

    let diff = 0
    for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expectedSig.charCodeAt(i)
    if (diff !== 0) return null

    const payload = JSON.parse(decodeURIComponent(escape(atob(b64))))
    if (payload.exp && payload.exp < Date.now()) return null
    return {
      id: payload.id,
      username: payload.username,
      role: payload.role,
      display_name: payload.display_name,
    }
  } catch {
    return null
  }
}

function normalizeResult(value: any): string {
  return ['受注', '失注', '未定'].includes(String(value)) ? String(value) : '未定'
}

function normalizeLostReason(result: string, value: any): string | null {
  if (result !== '失注') return null
  const text = String(value || '').trim()
  return text || null
}

function parsePositiveInt(value: any, fallback: number): number {
  const n = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

// 認証ミドルウェア
async function authMiddleware(c: any, next: any) {
  const secret = getSessionSecret(c)
  if (!secret) return c.json({ error: 'サーバー設定エラーです' }, 500)

  const authHeader = c.req.header('Authorization')
  const token = authHeader?.replace('Bearer ', '') || ''
  if (!token) return c.json({ error: '認証が必要です' }, 401)

  const user = await verifySessionToken(token, secret)
  if (!user) return c.json({ error: 'セッションが無効です' }, 401)
  c.set('user', user)
  await next()
}

async function adminMiddleware(c: any, next: any) {
  const user = c.get('user')
  if (!user || user.role !== 'admin') return c.json({ error: '管理者権限が必要です' }, 403)
  await next()
}

// ====== 認証API ======
app.post('/api/login', async (c) => {
  let body: any
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'リクエスト形式が不正です (JSONとして読み取れません)' }, 400)
  }

  const { username, password } = body
  if (!username || !password) return c.json({ error: 'ユーザー名とパスワードを入力してください' }, 400)

  const secret = getSessionSecret(c)
  if (!secret) return c.json({ error: 'サーバー設定エラーです' }, 500)

  if (!c.env.DB) return c.json({ error: 'データベースに接続できません' }, 500)

  let result: any = null
  try {
    result = await c.env.DB.prepare(
      'SELECT id, username, password_hash, display_name, role FROM users WHERE username = ?'
    ).bind(username).first<any>()
  } catch (err: any) {
    const msg = err?.message || String(err)
    if (msg.includes('no such table')) return c.json({ error: 'データベースの初期化が必要です' }, 500)
    return c.json({ error: 'データベースエラー' }, 500)
  }

  if (!result) return c.json({ error: 'ユーザー名またはパスワードが違います' }, 401)

  const passwordHash = await sha256(String(password))
  if (result.password_hash !== passwordHash) {
    return c.json({ error: 'ユーザー名またはパスワードが違います' }, 401)
  }

  const userInfo: SessionUser = {
    id: result.id,
    username: result.username,
    role: result.role,
    display_name: result.display_name,
  }

  const token = await makeSessionToken(userInfo, secret)
  return c.json({ token, user: userInfo })
})

// 外部公開してもDB構造やユーザー件数を返さない最小ヘルスチェック
app.get('/api/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }))

app.get('/api/me', authMiddleware, async (c) => c.json({ user: c.get('user') }))

// ====== 見積データAPI ======
function buildEstimateFilters(q: Record<string, string>) {
  const conditions: string[] = []
  const params: any[] = []

  if (q.date_from) { conditions.push('estimate_date >= ?'); params.push(q.date_from) }
  if (q.date_to) { conditions.push('estimate_date <= ?'); params.push(q.date_to) }
  if (q.client_name) { conditions.push('client_name LIKE ?'); params.push(`%${q.client_name.trim()}%`) }
  if (q.structure && q.structure.trim()) { conditions.push('structure LIKE ?'); params.push(`%${q.structure.trim()}%`) }
  if (q.building_use && q.building_use.trim()) { conditions.push('building_use LIKE ?'); params.push(`%${q.building_use.trim()}%`) }
  if (q.material_type) { conditions.push('material_type = ?'); params.push(q.material_type) }
  if (q.result) { conditions.push('result = ?'); params.push(q.result) }
  if (q.estimator) { conditions.push('estimator = ?'); params.push(q.estimator) }
  if (q.lost_reason) { conditions.push('lost_reason = ?'); params.push(q.lost_reason) }
  if (q.search) {
    conditions.push('(estimate_no LIKE ? OR site_name LIKE ? OR client_name LIKE ? OR remarks LIKE ?)')
    const s = `%${q.search.trim()}%`
    params.push(s, s, s, s)
  }
  if (q.price_min) { conditions.push('unit_price >= ?'); params.push(Number(q.price_min)) }
  if (q.price_max) { conditions.push('unit_price <= ?'); params.push(Number(q.price_max)) }

  return {
    where: conditions.length ? 'WHERE ' + conditions.join(' AND ') : '',
    params,
  }
}

app.get('/api/estimates', authMiddleware, async (c) => {
  const q = c.req.query()
  const { where, params } = buildEstimateFilters(q)
  const sortField = q.sort || 'estimate_date'
  const sortOrder = (q.order || 'desc').toUpperCase() === 'ASC' ? 'ASC' : 'DESC'
  const allowedSort = ['estimate_date', 'estimate_no', 'client_name', 'site_name', 'structure', 'rebar_quantity', 'estimate_amount', 'unit_price', 'result']
  const safeSortField = allowedSort.includes(sortField) ? sortField : 'estimate_date'

  const hasPaging = q.limit !== undefined && q.limit !== ''
  const limit = hasPaging ? Math.min(Math.max(parsePositiveInt(q.limit, 30), 1), 100) : null
  const offset = hasPaging ? parsePositiveInt(q.offset, 0) : 0

  let totalCount: number | null = null
  if (hasPaging) {
    const total = await c.env.DB.prepare(`SELECT COUNT(*) AS count FROM estimates ${where}`).bind(...params).first<any>()
    totalCount = Number(total?.count || 0)
  }

  let sql = `SELECT * FROM estimates ${where} ORDER BY ${safeSortField} ${sortOrder}, id DESC`
  const queryParams = [...params]
  if (limit !== null) {
    sql += ' LIMIT ? OFFSET ?'
    queryParams.push(limit, offset)
  }

  const { results } = await c.env.DB.prepare(sql).bind(...queryParams).all()
  const effectiveTotal = totalCount ?? results.length
  return c.json({
    estimates: results,
    total_count: effectiveTotal,
    has_more: limit !== null ? offset + results.length < effectiveTotal : false,
  })
})

app.get('/api/estimates/:id', authMiddleware, async (c) => {
  const id = c.req.param('id')
  const row = await c.env.DB.prepare('SELECT * FROM estimates WHERE id = ?').bind(id).first()
  if (!row) return c.json({ error: '見積データが見つかりません' }, 404)
  return c.json({ estimate: row })
})

function generateEstimateNo(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  const ss = String(now.getSeconds()).padStart(2, '0')
  const rand = String(Math.floor(Math.random() * 1000)).padStart(3, '0')
  return `EST-${y}${m}${d}-${hh}${mm}${ss}-${rand}`
}

app.post('/api/estimates', authMiddleware, async (c) => {
  const user = c.get('user')!
  const body = await c.req.json()
  const resultValue = normalizeResult(body.result)
  const lostReason = normalizeLostReason(resultValue, body.lost_reason)
  const estimateNo = (body.estimate_no && String(body.estimate_no).trim()) || generateEstimateNo()

  const sql = `INSERT INTO estimates (
    estimate_no, estimate_date, client_name, site_name, site_location, structure, building_use,
    rebar_quantity, estimate_amount, unit_price, material_type, estimator, result, lost_reason, order_date, remarks,
    competitor, expected_actual_unit_price, profit_estimate, construction_period, construction_start_date,
    processing_start_date, difficulty, site_manager, re_estimate, client_contact_name, client_contact_info, created_by
  ) VALUES (?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?,?, ?)`

  try {
    const result = await c.env.DB.prepare(sql).bind(
      estimateNo,
      body.estimate_date || new Date().toISOString().split('T')[0],
      body.client_name || '',
      body.site_name || '',
      body.site_location || null,
      body.structure || null,
      body.building_use || null,
      body.rebar_quantity ? Number(body.rebar_quantity) : null,
      body.estimate_amount ? Number(body.estimate_amount) : null,
      body.unit_price ? Number(body.unit_price) : null,
      body.material_type || null,
      body.estimator || null,
      resultValue,
      lostReason,
      body.order_date || null,
      body.remarks || null,
      body.competitor || null,
      body.expected_actual_unit_price ? Number(body.expected_actual_unit_price) : null,
      body.profit_estimate ? Number(body.profit_estimate) : null,
      body.construction_period || null,
      body.construction_start_date || null,
      body.processing_start_date || null,
      body.difficulty || null,
      body.site_manager || null,
      body.re_estimate ? 1 : 0,
      body.client_contact_name || null,
      body.client_contact_info || null,
      user.id
    ).run()

    return c.json({ id: result.meta.last_row_id, success: true })
  } catch (err: any) {
    if (String(err?.message || err).includes('UNIQUE constraint failed: estimates.estimate_no')) {
      return c.json({ error: '見積番号が重複しました。もう一度登録してください' }, 409)
    }
    throw err
  }
})

app.put('/api/estimates/:id', authMiddleware, async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json()

  const existing = await c.env.DB.prepare('SELECT estimate_no FROM estimates WHERE id = ?').bind(id).first<{ estimate_no: string }>()
  if (!existing) return c.json({ error: '見積データが見つかりません' }, 404)

  const estimateNo = body.estimate_no && String(body.estimate_no).trim()
    ? String(body.estimate_no).trim()
    : existing.estimate_no
  const resultValue = normalizeResult(body.result)
  const lostReason = normalizeLostReason(resultValue, body.lost_reason)

  const sql = `UPDATE estimates SET
    estimate_no=?, estimate_date=?, client_name=?, site_name=?, site_location=?, structure=?, building_use=?,
    rebar_quantity=?, estimate_amount=?, unit_price=?, material_type=?, estimator=?, result=?, lost_reason=?, order_date=?, remarks=?,
    competitor=?, expected_actual_unit_price=?, profit_estimate=?, construction_period=?, construction_start_date=?,
    processing_start_date=?, difficulty=?, site_manager=?, re_estimate=?, client_contact_name=?, client_contact_info=?,
    updated_at=CURRENT_TIMESTAMP
    WHERE id=?`

  try {
    await c.env.DB.prepare(sql).bind(
      estimateNo,
      body.estimate_date || '',
      body.client_name || '',
      body.site_name || '',
      body.site_location || null,
      body.structure || null,
      body.building_use || null,
      body.rebar_quantity ? Number(body.rebar_quantity) : null,
      body.estimate_amount ? Number(body.estimate_amount) : null,
      body.unit_price ? Number(body.unit_price) : null,
      body.material_type || null,
      body.estimator || null,
      resultValue,
      lostReason,
      body.order_date || null,
      body.remarks || null,
      body.competitor || null,
      body.expected_actual_unit_price ? Number(body.expected_actual_unit_price) : null,
      body.profit_estimate ? Number(body.profit_estimate) : null,
      body.construction_period || null,
      body.construction_start_date || null,
      body.processing_start_date || null,
      body.difficulty || null,
      body.site_manager || null,
      body.re_estimate ? 1 : 0,
      body.client_contact_name || null,
      body.client_contact_info || null,
      id
    ).run()
    return c.json({ success: true })
  } catch (err: any) {
    if (String(err?.message || err).includes('UNIQUE constraint failed: estimates.estimate_no')) {
      return c.json({ error: '見積番号が重複しています' }, 409)
    }
    throw err
  }
})

app.delete('/api/estimates/:id', authMiddleware, adminMiddleware, async (c) => {
  const id = c.req.param('id')
  const result = await c.env.DB.prepare('DELETE FROM estimates WHERE id = ?').bind(id).run()
  if (!result.meta.changes) return c.json({ error: '見積データが見つかりません' }, 404)
  return c.json({ success: true })
})

// ====== 集計API ======
app.get('/api/stats', authMiddleware, async (c) => {
  const q = c.req.query()
  const { where, params } = buildEstimateFilters(q)

  const overall = await c.env.DB.prepare(`
    SELECT
      COUNT(*) AS total_count,
      SUM(CASE WHEN result='受注' THEN 1 ELSE 0 END) AS won_count,
      SUM(CASE WHEN result='失注' THEN 1 ELSE 0 END) AS lost_count,
      SUM(CASE WHEN result='未定' THEN 1 ELSE 0 END) AS pending_count,
      SUM(estimate_amount) AS total_amount,
      SUM(CASE WHEN result='受注' THEN estimate_amount ELSE 0 END) AS won_amount,
      AVG(unit_price) AS avg_unit_price,
      AVG(rebar_quantity) AS avg_quantity
    FROM estimates ${where}
  `).bind(...params).first<any>()

  const { results: byClient } = await c.env.DB.prepare(`
    SELECT
      client_name,
      COUNT(*) AS total_count,
      SUM(CASE WHEN result='受注' THEN 1 ELSE 0 END) AS won_count,
      SUM(CASE WHEN result='失注' THEN 1 ELSE 0 END) AS lost_count,
      SUM(CASE WHEN result='未定' THEN 1 ELSE 0 END) AS pending_count,
      SUM(estimate_amount) AS total_amount,
      SUM(CASE WHEN result='受注' THEN estimate_amount ELSE 0 END) AS won_amount,
      AVG(unit_price) AS avg_unit_price,
      AVG(rebar_quantity) AS avg_quantity
    FROM estimates ${where}
    GROUP BY client_name
    ORDER BY total_amount DESC
  `).bind(...params).all()

  const { results: byStructure } = await c.env.DB.prepare(`
    SELECT
      COALESCE(structure, '(未設定)') AS structure,
      COUNT(*) AS total_count,
      SUM(CASE WHEN result='受注' THEN 1 ELSE 0 END) AS won_count,
      SUM(CASE WHEN result='失注' THEN 1 ELSE 0 END) AS lost_count,
      SUM(CASE WHEN result='未定' THEN 1 ELSE 0 END) AS pending_count,
      SUM(estimate_amount) AS total_amount,
      AVG(unit_price) AS avg_unit_price,
      AVG(rebar_quantity) AS avg_quantity
    FROM estimates ${where}
    GROUP BY structure
    ORDER BY total_count DESC
  `).bind(...params).all()

  const { results: byPrice } = await c.env.DB.prepare(`
    SELECT
      CASE
        WHEN unit_price IS NULL THEN '不明'
        WHEN unit_price <= 80 THEN '〜80円/kg'
        WHEN unit_price <= 90 THEN '81〜90円/kg'
        WHEN unit_price <= 100 THEN '91〜100円/kg'
        WHEN unit_price <= 110 THEN '101〜110円/kg'
        ELSE '111円/kg〜'
      END AS price_range,
      COUNT(*) AS total_count,
      SUM(CASE WHEN result='受注' THEN 1 ELSE 0 END) AS won_count,
      SUM(CASE WHEN result='失注' THEN 1 ELSE 0 END) AS lost_count,
      SUM(CASE WHEN result='未定' THEN 1 ELSE 0 END) AS pending_count,
      SUM(estimate_amount) AS total_amount,
      AVG(rebar_quantity) AS avg_quantity
    FROM estimates ${where}
    GROUP BY price_range
    ORDER BY MIN(unit_price)
  `).bind(...params).all()

  const { results: byLostReason } = await c.env.DB.prepare(`
    SELECT
      COALESCE(NULLIF(TRIM(lost_reason), ''), '不明') AS lost_reason,
      COUNT(*) AS count
    FROM estimates ${where ? where + ' AND ' : 'WHERE '} result='失注'
    GROUP BY COALESCE(NULLIF(TRIM(lost_reason), ''), '不明')
    ORDER BY count DESC
  `).bind(...params).all()

  const { results: byMonth } = await c.env.DB.prepare(`
    SELECT
      substr(estimate_date, 1, 7) AS month,
      COUNT(*) AS total_count,
      SUM(CASE WHEN result='受注' THEN 1 ELSE 0 END) AS won_count,
      SUM(CASE WHEN result='失注' THEN 1 ELSE 0 END) AS lost_count,
      SUM(CASE WHEN result='未定' THEN 1 ELSE 0 END) AS pending_count,
      COALESCE(SUM(estimate_amount), 0) AS total_amount,
      COALESCE(SUM(CASE WHEN result='受注' THEN estimate_amount ELSE 0 END), 0) AS won_amount
    FROM estimates ${where}
    GROUP BY month
    ORDER BY month
  `).bind(...params).all()

  return c.json({
    overall,
    by_client: byClient,
    by_structure: byStructure,
    by_price: byPrice,
    by_lost_reason: byLostReason,
    by_month: byMonth,
  })
})

// ====== 静的ファイル ======
app.use('/static/*', serveStatic({ root: './public' }))
app.use('/favicon.ico', serveStatic({ path: './public/favicon.ico' }))

// ====== フロントエンド (SPA) ======
const renderApp = (c: any) => c.render(
  <div id="app">
    <div class="text-center py-20 text-gray-400">
      <i class="fas fa-spinner fa-spin text-4xl"></i>
      <p class="mt-4">読み込み中...</p>
    </div>
  </div>
)

app.get('/', renderApp)
app.get('/login', renderApp)
app.get('/dashboard', renderApp)
app.get('/estimates', renderApp)
app.get('/estimates/new', renderApp)
app.get('/estimates/:id', renderApp)
app.get('/stats/*', renderApp)

export default app
