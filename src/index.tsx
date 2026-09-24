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

function calculateUnitPrice(quantityValue: any, netAmountValue: any): number | null {
  const quantity = Number(quantityValue)
  const netAmount = Number(netAmountValue)
  if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(netAmount) || netAmount < 0) return null
  return netAmount / quantity / 1000
}

function normalizeEstimateItems(value: any): any[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item: any, index: number) => ({
      item_code: String(item?.item_code || '').trim() || null,
      category: String(item?.category || '').trim() || null,
      description: String(item?.description || '').trim() || null,
      specification: String(item?.specification || '').trim() || null,
      quantity: item?.quantity === null || item?.quantity === '' || item?.quantity === undefined ? null : Number(item.quantity),
      unit: String(item?.unit || '').trim() || null,
      unit_price: item?.unit_price === null || item?.unit_price === '' || item?.unit_price === undefined ? null : Number(item.unit_price),
      amount: item?.amount === null || item?.amount === '' || item?.amount === undefined ? null : Number(item.amount),
      remarks: String(item?.remarks || '').trim() || null,
      sort_order: Number.isFinite(Number(item?.sort_order)) ? Number(item.sort_order) : index,
    }))
    .filter((item: any) =>
      item.item_code || item.category || item.description || item.specification || item.quantity !== null ||
      item.unit_price !== null || item.amount !== null || item.remarks
    )
}

async function replaceEstimateItems(db: D1Database, estimateId: number | string, items: any[]) {
  const statements = [
    db.prepare('DELETE FROM estimate_items WHERE estimate_id = ?').bind(estimateId),
    ...items.map((item) =>
      db.prepare(`INSERT INTO estimate_items
        (estimate_id, item_code, category, description, specification, quantity, unit, unit_price, amount, remarks, sort_order)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(
          estimateId,
          item.item_code,
          item.category,
          item.description,
          item.specification,
          item.quantity,
          item.unit,
          item.unit_price,
          item.amount,
          item.remarks,
          item.sort_order
        )
    ),
  ]
  await db.batch(statements)
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
  if (q.construction_start_from) { conditions.push('construction_start_date >= ?'); params.push(q.construction_start_from) }
  if (q.construction_start_to) { conditions.push('construction_start_date <= ?'); params.push(q.construction_start_to) }
  if (q.client_name) { conditions.push('client_name LIKE ?'); params.push(`%${q.client_name.trim()}%`) }
  if (q.structure && q.structure.trim()) { conditions.push('structure LIKE ?'); params.push(`%${q.structure.trim()}%`) }
  if (q.building_use && q.building_use.trim()) { conditions.push('building_use LIKE ?'); params.push(`%${q.building_use.trim()}%`) }
  if (q.material_type) { conditions.push('material_type = ?'); params.push(q.material_type) }
  if (q.result) { conditions.push('result = ?'); params.push(q.result) }
  if (q.lost_reason) { conditions.push('lost_reason = ?'); params.push(q.lost_reason) }
  if (q.search) {
    conditions.push('(estimate_no LIKE ? OR site_name LIKE ? OR client_name LIKE ? OR remarks LIKE ?)')
    const s = `%${q.search.trim()}%`
    params.push(s, s, s, s)
  }
  if (q.price_min) { conditions.push('unit_price >= ?'); params.push(Number(q.price_min)) }
  if (q.price_max) { conditions.push('unit_price <= ?'); params.push(Number(q.price_max)) }
  if (q.quantity_min) { conditions.push('rebar_quantity >= ?'); params.push(Number(q.quantity_min)) }
  if (q.quantity_max) { conditions.push('rebar_quantity <= ?'); params.push(Number(q.quantity_max)) }
  if (q.floors_min) { conditions.push('above_ground_floors >= ?'); params.push(Number(q.floors_min)) }
  if (q.floors_max) { conditions.push('above_ground_floors <= ?'); params.push(Number(q.floors_max)) }
  if (q.area_min) { conditions.push('total_floor_area >= ?'); params.push(Number(q.area_min)) }
  if (q.area_max) { conditions.push('total_floor_area <= ?'); params.push(Number(q.area_max)) }
  if (q.client_ordered === '1' || q.client_ordered === '2' || q.client_ordered === '0') {
    conditions.push('client_ordered = ?')
    params.push(Number(q.client_ordered))
  }

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

// 条件指定による類似案件検索
app.get('/api/similar-search', authMiddleware, async (c) => {
  const q = c.req.query()
  const hasCondition = ['structure','building_use','above_ground_floors','basement_floors','rebar_quantity','total_floor_area','material_type','client_ordered']
    .some(key => String(q[key] || '').trim() !== '')
  if (!hasCondition) return c.json({ error: '検索条件を1つ以上指定してください' }, 400)

  const { results } = await c.env.DB.prepare(
    'SELECT * FROM estimates ORDER BY estimate_date DESC, id DESC LIMIT 500'
  ).all<any>()

  const ratioScore = (targetValue: any, rowValue: any, tolerance: number) => {
    if (targetValue === '' || targetValue === null || targetValue === undefined || rowValue === '' || rowValue === null || rowValue === undefined) return null
    const a = Number(targetValue), b = Number(rowValue)
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < 0) return null
    if (a === 0 && b === 0) return 1
    if (a <= 0 || b <= 0) return 0
    return Math.max(0, 1 - Math.abs(a - b) / (Math.max(a, b) * tolerance))
  }

  const candidates = (results || []).map((row: any) => {
    let score = 0
    let weight = 0
    const add = (value: number | null, w: number) => {
      if (value === null) return
      score += value * w
      weight += w
    }

    if (q.structure) add(row.structure && String(row.structure).trim() === String(q.structure).trim() ? 1 : 0, 30)
    if (q.building_use) add(row.building_use && String(row.building_use).trim() === String(q.building_use).trim() ? 1 : 0, 15)
    if (q.material_type) add(row.material_type === q.material_type ? 1 : 0, 10)
    if (q.client_ordered !== undefined && q.client_ordered !== '') add(Number(row.client_ordered) === Number(q.client_ordered) ? 1 : 0, 5)

    add(ratioScore(q.above_ground_floors, row.above_ground_floors, 0.5), 15)
    add(ratioScore(q.basement_floors, row.basement_floors, 1.0), 5)
    add(ratioScore(q.rebar_quantity, row.rebar_quantity, 0.6), 15)
    add(ratioScore(q.total_floor_area, row.total_floor_area, 0.6), 10)

    return { ...row, similarity_score: weight ? Math.round((score / weight) * 100) : 0 }
  })
    .filter((row: any) => row.similarity_score > 0)
    .sort((a: any, b: any) => b.similarity_score - a.similarity_score || String(b.estimate_date || '').localeCompare(String(a.estimate_date || '')))
    .slice(0, 50)

  return c.json({ candidates })
})

// 見積明細テンプレート
app.get('/api/estimate-item-templates', authMiddleware, async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, name, items_json, created_at, updated_at FROM estimate_item_templates ORDER BY name COLLATE NOCASE, id'
  ).all<any>()
  return c.json({ templates: (results || []).map((row: any) => {
    let items: any[] = []
    try { items = JSON.parse(String(row.items_json || '[]')) } catch {}
    return { id: row.id, name: row.name, items, created_at: row.created_at, updated_at: row.updated_at }
  }) })
})

app.post('/api/estimate-item-templates', authMiddleware, async (c) => {
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'リクエスト形式が不正です' }, 400) }
  const name = String(body?.name || '').trim()
  const items = normalizeEstimateItems(body?.items)
  if (!name) return c.json({ error: 'テンプレート名を入力してください' }, 400)
  if (name.length > 100) return c.json({ error: 'テンプレート名は100文字以内で入力してください' }, 400)
  if (!items.length) return c.json({ error: '保存する見積明細がありません' }, 400)
  try {
    const result = await c.env.DB.prepare(
      'INSERT INTO estimate_item_templates (name, items_json) VALUES (?, ?)'
    ).bind(name, JSON.stringify(items)).run()
    return c.json({ id: result.meta.last_row_id, name, items }, 201)
  } catch (err: any) {
    if (String(err?.message || '').includes('UNIQUE')) return c.json({ error: '同じ名前のテンプレートがすでにあります' }, 409)
    throw err
  }
})

app.delete('/api/estimate-item-templates/:id', authMiddleware, async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isFinite(id)) return c.json({ error: 'テンプレートIDが不正です' }, 400)
  const result = await c.env.DB.prepare('DELETE FROM estimate_item_templates WHERE id = ?').bind(id).run()
  if (!result.meta.changes) return c.json({ error: 'テンプレートが見つかりません' }, 404)
  return c.json({ success: true })
})

// 明細コピー用の過去見積一覧（明細がある案件のみ）
app.get('/api/estimate-item-copy-sources', authMiddleware, async (c) => {
  const search = String(c.req.query('search') || '').trim()
  const params: any[] = []
  let searchSql = ''
  if (search) {
    searchSql = 'AND (e.site_name LIKE ? OR e.client_name LIKE ? OR e.estimate_no LIKE ?)'
    const q = `%${search}%`
    params.push(q, q, q)
  }
  const { results } = await c.env.DB.prepare(`
    SELECT e.id, e.estimate_date, e.estimate_no, e.client_name, e.site_name, e.structure,
           e.building_use, e.rebar_quantity, e.net_amount, COUNT(i.id) AS item_count
    FROM estimates e
    JOIN estimate_items i ON i.estimate_id = e.id
    WHERE 1=1 ${searchSql}
    GROUP BY e.id
    ORDER BY e.estimate_date DESC, e.id DESC
    LIMIT 50
  `).bind(...params).all<any>()
  return c.json({ estimates: results || [] })
})

// 見積明細のユーザー追加比較項目
app.get('/api/estimate-item-codes', authMiddleware, async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT code, label FROM estimate_item_codes ORDER BY label COLLATE NOCASE, id'
  ).all<any>()
  return c.json({ items: results || [] })
})

app.post('/api/estimate-item-codes', authMiddleware, async (c) => {
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'リクエスト形式が不正です' }, 400) }
  const label = String(body?.label || '').trim()
  if (!label) return c.json({ error: '比較項目名を入力してください' }, 400)
  if (label.length > 100) return c.json({ error: '比較項目名は100文字以内で入力してください' }, 400)

  const existing = await c.env.DB.prepare('SELECT code, label FROM estimate_item_codes WHERE label = ? COLLATE NOCASE').bind(label).first<any>()
  if (existing) return c.json({ item: existing, already_exists: true })

  const code = 'CUSTOM_' + crypto.randomUUID().replace(/-/g, '').toUpperCase()
  await c.env.DB.prepare('INSERT INTO estimate_item_codes (code, label) VALUES (?, ?)').bind(code, label).run()
  return c.json({ item: { code, label }, already_exists: false }, 201)
})

app.get('/api/estimates/:id', authMiddleware, async (c) => {
  const id = c.req.param('id')
  const row = await c.env.DB.prepare('SELECT * FROM estimates WHERE id = ?').bind(id).first()
  if (!row) return c.json({ error: '見積データが見つかりません' }, 404)
  const { results: items } = await c.env.DB.prepare(
    'SELECT * FROM estimate_items WHERE estimate_id = ? ORDER BY sort_order, id'
  ).bind(id).all()
  return c.json({ estimate: row, items: items || [] })
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

// 類似案件検索
app.get('/api/estimates/:id/similar', authMiddleware, async (c) => {
  const id = c.req.param('id')
  const target = await c.env.DB.prepare('SELECT * FROM estimates WHERE id = ?').bind(id).first<any>()
  if (!target) return c.json({ error: '見積データが見つかりません' }, 404)

  const { results } = await c.env.DB.prepare('SELECT * FROM estimates WHERE id <> ? ORDER BY estimate_date DESC, id DESC LIMIT 200').bind(id).all<any>()
  const ratioScore = (a: any, b: any, tolerance: number) => {
    const av = Number(a), bv = Number(b)
    if (!Number.isFinite(av) || !Number.isFinite(bv) || av <= 0 || bv <= 0) return 0
    return Math.max(0, 1 - Math.abs(av - bv) / (Math.max(av, bv) * tolerance))
  }
  const candidates = (results || []).map((row: any) => {
    let score = 0
    let weight = 0
    const add = (matched: number, w: number) => { score += matched * w; weight += w }

    if (target.structure && row.structure) add(target.structure === row.structure ? 1 : 0, 30)
    if (target.building_use && row.building_use) add(target.building_use === row.building_use ? 1 : 0, 15)

    const hasTargetFloors = target.above_ground_floors !== null && target.above_ground_floors !== undefined && target.above_ground_floors !== ''
    const hasRowFloors = row.above_ground_floors !== null && row.above_ground_floors !== undefined && row.above_ground_floors !== ''
    const tf = Number(target.above_ground_floors), rf = Number(row.above_ground_floors)
    if (hasTargetFloors && hasRowFloors && Number.isFinite(tf) && Number.isFinite(rf)) {
      add(Math.max(0, 1 - Math.abs(tf - rf) / Math.max(3, tf || 1)), 20)
    }

    if (target.rebar_quantity && row.rebar_quantity) add(ratioScore(target.rebar_quantity, row.rebar_quantity, 0.6), 20)
    if (target.total_floor_area && row.total_floor_area) add(ratioScore(target.total_floor_area, row.total_floor_area, 0.6), 15)

    return { ...row, similarity_score: weight ? Math.round((score / weight) * 100) : 0 }
  }).sort((a: any, b: any) => b.similarity_score - a.similarity_score).slice(0, 20)

  return c.json({ target, candidates })
})

// 選択案件の見積明細比較
app.get('/api/estimates/:id/compare', authMiddleware, async (c) => {
  const targetId = Number(c.req.param('id'))
  const ids = String(c.req.query('ids') || '').split(',').map(v => Number(v)).filter(v => Number.isInteger(v) && v > 0 && v !== targetId).slice(0, 5)
  const projectIds = [targetId, ...ids]
  if (!ids.length) return c.json({ error: '比較する案件を選択してください' }, 400)

  const placeholders = projectIds.map(() => '?').join(',')
  const { results: projectsRaw } = await c.env.DB.prepare(`SELECT * FROM estimates WHERE id IN (${placeholders})`).bind(...projectIds).all<any>()
  const projectMap = new Map((projectsRaw || []).map((p: any) => [Number(p.id), p]))
  const projects = projectIds.map(pid => projectMap.get(pid)).filter(Boolean)
  if (!projectMap.has(targetId)) return c.json({ error: '基準案件が見つかりません' }, 404)

  const { results: itemsRaw } = await c.env.DB.prepare(
    `SELECT * FROM estimate_items WHERE estimate_id IN (${placeholders}) ORDER BY sort_order, id`
  ).bind(...projectIds).all<any>()
  const { results: customCodes } = await c.env.DB.prepare('SELECT code, label FROM estimate_item_codes').all<any>()

  const codeLabels: Record<string, string> = {
    REBAR_D10:'異形鉄筋 D10', REBAR_D13:'異形鉄筋 D13', REBAR_D16:'異形鉄筋 D16', REBAR_D19:'異形鉄筋 D19',
    REBAR_D22:'異形鉄筋 D22', REBAR_D25:'異形鉄筋 D25', REBAR_D29:'異形鉄筋 D29', REBAR_D32:'異形鉄筋 D32', REBAR_D35:'異形鉄筋 D35',
    ANCHOR_REBAR:'定着板鉄筋', SPECIAL_REBAR:'溶接閉鎖筋・特殊鉄筋', PROCESSING:'加工費', SPACER:'スペーサー費',
    ASSEMBLY_TRANSPORT:'組立・運搬費', GAS_D19:'ガス圧接 D19', GAS_D22:'ガス圧接 D22', GAS_D25:'ガス圧接 D25',
    GAS_D29:'ガス圧接 D29', GAS_D32:'ガス圧接 D32', GAS_D35:'ガス圧接 D35', GAS_DAILY:'圧接常用費',
    GAS_TEST:'圧接試験費', STAND:'梁架台費', WELFARE:'法定福利費', EXPENSE:'諸経費', OTHER:'その他'
  }
  for (const item of (customCodes || [])) codeLabels[String(item.code)] = String(item.label)

  const metricFor = (item: any, project: any) => {
    const code = String(item.item_code || '')
    const hasAmount = item.amount !== null && item.amount !== undefined && item.amount !== ''
    const hasQty = item.quantity !== null && item.quantity !== undefined && item.quantity !== ''
    const hasUnitPrice = item.unit_price !== null && item.unit_price !== undefined && item.unit_price !== ''
    const hasRebarQuantity = project?.rebar_quantity !== null && project?.rebar_quantity !== undefined && project?.rebar_quantity !== ''
    const hasNet = project?.net_amount !== null && project?.net_amount !== undefined && project?.net_amount !== ''
    const amount = hasAmount ? Number(item.amount) : null
    const qty = hasQty ? Number(item.quantity) : null
    const unitPrice = hasUnitPrice ? Number(item.unit_price) : null
    const rebarKg = hasRebarQuantity ? Number(project.rebar_quantity) * 1000 : null
    const net = hasNet ? Number(project.net_amount) : null

    if (code === 'PROCESSING' || code === 'SPACER' || code === 'ASSEMBLY_TRANSPORT') {
      if (unitPrice !== null && Number.isFinite(unitPrice) && unitPrice >= 0) return { value: unitPrice, label: '円/kg' }
      return { value: rebarKg !== null && rebarKg > 0 && amount !== null && Number.isFinite(amount) ? amount / rebarKg : null, label: '円/kg' }
    }
    if (code.startsWith('GAS_') && code !== 'GAS_DAILY' && code !== 'GAS_TEST') {
      if (unitPrice !== null && Number.isFinite(unitPrice) && unitPrice >= 0) return { value: unitPrice, label: '円/箇所' }
      return { value: qty !== null && qty > 0 && amount !== null && Number.isFinite(amount) ? amount / qty : null, label: '円/箇所' }
    }
    if (code === 'STAND') return { value: hasRebarQuantity && Number(project.rebar_quantity) > 0 && amount !== null && Number.isFinite(amount) ? amount / Number(project.rebar_quantity) : null, label: '円/t' }
    if (code === 'WELFARE' || code === 'EXPENSE') return { value: net !== null && net > 0 && amount !== null && Number.isFinite(amount) ? amount / net * 100 : null, label: 'NET比 %' }
    if (unitPrice !== null && Number.isFinite(unitPrice) && unitPrice >= 0) return { value: unitPrice, label: item.unit ? `円/${item.unit}` : '単価' }
    return { value: amount !== null && Number.isFinite(amount) ? amount : null, label: '金額(円)' }
  }

  const groups = new Map<string, any>()
  for (const item of (itemsRaw || [])) {
    const code = String(item.item_code || '').trim() || `TEXT:${String(item.description || item.category || 'その他').trim()}`
    if (!groups.has(code)) groups.set(code, { code, label: codeLabels[code] || item.description || item.category || 'その他', values: {}, metric_label: '' })
    const row = groups.get(code)
    const metric = metricFor(item, projectMap.get(Number(item.estimate_id)))
    if (metric.value != null) {
      row.values[Number(item.estimate_id)] = metric.value
      row.metric_label = metric.label
    }
  }

  const items = Array.from(groups.values()).map((row: any) => {
    const targetValue = row.values[targetId]
    const pastValues = ids.map(pid => row.values[pid]).filter((v: any) => Number.isFinite(Number(v))).map(Number)
    const pastAverage = pastValues.length ? pastValues.reduce((a: number,b: number)=>a+b,0) / pastValues.length : null
    const difference = targetValue != null && pastAverage != null ? Number(targetValue) - pastAverage : null
    const differenceRate = difference != null && pastAverage !== 0 ? difference / pastAverage * 100 : null
    return { ...row, past_average: pastAverage, difference, difference_rate: differenceRate }
  })

  return c.json({ projects, items })
})

app.post('/api/estimates', authMiddleware, async (c) => {
  const user = c.get('user')!
  const body = await c.req.json()
  const resultValue = normalizeResult(body.result)
  const lostReason = normalizeLostReason(resultValue, body.lost_reason)
  const estimateNo = (body.estimate_no && String(body.estimate_no).trim()) || generateEstimateNo()
  const unitPrice = calculateUnitPrice(body.rebar_quantity, body.net_amount)
  const items = normalizeEstimateItems(body.items)

  // estimator カラムは画面から削除されたため INSERT の列リストから除外する
  // (DB カラムと既存データは保持。新規レコードでは NULL のまま挿入される)
  const sql = `INSERT INTO estimates (
    estimate_no, estimate_date, client_name, site_name, site_location, structure, building_use,
    above_ground_floors, basement_floors, total_floor_area, rebar_quantity, estimate_amount, net_amount, unit_price, material_type, result, lost_reason, order_date, remarks,
    competitor, expected_actual_unit_price, profit_estimate, construction_period, construction_start_date,
    processing_start_date, difficulty, site_manager, re_estimate, client_ordered, client_contact_name, client_contact_info, created_by
  ) VALUES (?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?,?,?, ?)`

  try {
    const result = await c.env.DB.prepare(sql).bind(
      estimateNo,
      body.estimate_date || new Date().toISOString().split('T')[0],
      body.client_name || '',
      body.site_name || '',
      body.site_location || null,
      body.structure || null,
      body.building_use || null,
      body.above_ground_floors !== undefined && body.above_ground_floors !== '' ? Number(body.above_ground_floors) : null,
      body.basement_floors !== undefined && body.basement_floors !== '' ? Number(body.basement_floors) : null,
      body.total_floor_area !== undefined && body.total_floor_area !== '' ? Number(body.total_floor_area) : null,
      body.rebar_quantity ? Number(body.rebar_quantity) : null,
      body.estimate_amount ? Number(body.estimate_amount) : null,
      body.net_amount !== undefined && body.net_amount !== '' ? Number(body.net_amount) : null,
      unitPrice,
      body.material_type || null,
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
      [0, 1, 2].includes(Number(body.client_ordered)) ? Number(body.client_ordered) : 0,
      body.client_contact_name || null,
      body.client_contact_info || null,
      user.id
    ).run()

    const estimateId = Number(result.meta.last_row_id)
    if (items.length) await replaceEstimateItems(c.env.DB, estimateId, items)
    return c.json({ id: estimateId, success: true })
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
  const unitPrice = calculateUnitPrice(body.rebar_quantity, body.net_amount)
  const items = normalizeEstimateItems(body.items)

  // estimator は SET 対象から除外し、既存レコードの値を保持する
  // (画面から入力欄が削除されたため送信されない。DB上の既存値は不変)
  const sql = `UPDATE estimates SET
    estimate_no=?, estimate_date=?, client_name=?, site_name=?, site_location=?, structure=?, building_use=?,
    above_ground_floors=?, basement_floors=?, total_floor_area=?, rebar_quantity=?, estimate_amount=?, net_amount=?, unit_price=?, material_type=?, result=?, lost_reason=?, order_date=?, remarks=?,
    competitor=?, expected_actual_unit_price=?, profit_estimate=?, construction_period=?, construction_start_date=?,
    processing_start_date=?, difficulty=?, site_manager=?, re_estimate=?, client_ordered=?, client_contact_name=?, client_contact_info=?,
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
      body.above_ground_floors !== undefined && body.above_ground_floors !== '' ? Number(body.above_ground_floors) : null,
      body.basement_floors !== undefined && body.basement_floors !== '' ? Number(body.basement_floors) : null,
      body.total_floor_area !== undefined && body.total_floor_area !== '' ? Number(body.total_floor_area) : null,
      body.rebar_quantity ? Number(body.rebar_quantity) : null,
      body.estimate_amount ? Number(body.estimate_amount) : null,
      body.net_amount !== undefined && body.net_amount !== '' ? Number(body.net_amount) : null,
      unitPrice,
      body.material_type || null,
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
      [0, 1, 2].includes(Number(body.client_ordered)) ? Number(body.client_ordered) : 0,
      body.client_contact_name || null,
      body.client_contact_info || null,
      id
    ).run()
    await replaceEstimateItems(c.env.DB, id, items)
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
  await c.env.DB.prepare('DELETE FROM estimate_items WHERE estimate_id = ?').bind(id).run()
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
app.get('/similar-search', renderApp)
app.get('/estimates/new', renderApp)
app.get('/estimates/:id/detail', renderApp)
app.get('/estimates/:id', renderApp)
app.get('/stats/*', renderApp)

export default app
