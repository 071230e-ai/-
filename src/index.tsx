import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-workers'
import { renderer } from './renderer'

type Bindings = {
  DB: D1Database
}

type Variables = {
  user?: { id: number; username: string; role: string; display_name: string }
}

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

function generateToken(): string {
  const arr = new Uint8Array(32)
  crypto.getRandomValues(arr)
  return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('')
}

// シンプルなセッショントークン管理 (in-memory風、トークン=ユーザー情報をBase64エンコード)
async function makeSessionToken(user: { id: number; username: string; role: string; display_name: string }): Promise<string> {
  const payload = JSON.stringify({ ...user, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 })
  // Base64URLエンコード
  const b64 = btoa(unescape(encodeURIComponent(payload)))
  const sig = await sha256(b64 + 'murata-tekkin-secret-key-2024')
  return `${b64}.${sig.substring(0, 16)}`
}

async function verifySessionToken(token: string): Promise<{ id: number; username: string; role: string; display_name: string } | null> {
  try {
    const parts = token.split('.')
    if (parts.length !== 2) return null
    const [b64, sig] = parts
    const expectedSig = (await sha256(b64 + 'murata-tekkin-secret-key-2024')).substring(0, 16)
    if (sig !== expectedSig) return null
    const payload = JSON.parse(decodeURIComponent(escape(atob(b64))))
    if (payload.exp && payload.exp < Date.now()) return null
    return { id: payload.id, username: payload.username, role: payload.role, display_name: payload.display_name }
  } catch {
    return null
  }
}

// 認証ミドルウェア
async function authMiddleware(c: any, next: any) {
  const authHeader = c.req.header('Authorization')
  const token = authHeader?.replace('Bearer ', '') || ''
  if (!token) return c.json({ error: '認証が必要です' }, 401)
  const user = await verifySessionToken(token)
  if (!user) return c.json({ error: 'セッションが無効です' }, 401)
  c.set('user', user)
  await next()
}

// 管理者ミドルウェア
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
  if (!username || !password) {
    return c.json({ error: 'ユーザー名とパスワードを入力してください' }, 400)
  }

  // D1接続チェック
  if (!c.env.DB) {
    return c.json({
      error: 'データベースに接続できません (D1バインディング DB が見つかりません)',
      hint: 'wrangler.jsonc の d1_databases 設定を確認してください',
    }, 500)
  }

  // usersテーブルの存在確認 + ユーザー取得
  let result: any = null
  try {
    result = await c.env.DB.prepare(
      'SELECT id, username, password_hash, display_name, role FROM users WHERE username = ?'
    ).bind(username).first<any>()
  } catch (err: any) {
    const msg = err?.message || String(err)
    if (msg.includes('no such table')) {
      return c.json({
        error: 'usersテーブルが存在しません',
        hint: 'マイグレーション (wrangler d1 migrations apply) と seed の適用が必要です',
        detail: msg,
      }, 500)
    }
    return c.json({ error: 'データベースエラー', detail: msg }, 500)
  }

  if (!result) {
    return c.json({
      error: 'ユーザー名またはパスワードが違います',
      hint: `username='${username}' に該当するユーザーが見つかりません`,
    }, 401)
  }

  // 余分な空白や大文字小文字を考慮しつつハッシュ比較
  const passwordHash = await sha256(String(password))
  if (result.password_hash !== passwordHash) {
    return c.json({
      error: 'ユーザー名またはパスワードが違います',
      hint: 'パスワードのハッシュが一致しません',
    }, 401)
  }

  const userInfo = {
    id: result.id,
    username: result.username,
    role: result.role,
    display_name: result.display_name,
  }
  const token = await makeSessionToken(userInfo)
  return c.json({ token, user: userInfo })
})

// ====== ヘルスチェックAPI (デバッグ用) ======
app.get('/api/health', async (c) => {
  const health: any = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    db: { bound: !!c.env.DB, accessible: false, tables: [], users_count: null },
  }
  if (c.env.DB) {
    try {
      const { results } = await c.env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      ).all()
      health.db.accessible = true
      health.db.tables = (results || []).map((r: any) => r.name)
      try {
        const u = await c.env.DB.prepare('SELECT COUNT(*) AS c FROM users').first<any>()
        health.db.users_count = u?.c ?? 0
      } catch {}
    } catch (err: any) {
      health.db.error = err?.message || String(err)
    }
  }
  return c.json(health)
})

app.get('/api/me', authMiddleware, async (c) => {
  return c.json({ user: c.get('user') })
})

// ====== 見積データAPI ======

// 一覧取得 (フィルタ付き)
app.get('/api/estimates', authMiddleware, async (c) => {
  const q = c.req.query()
  const conditions: string[] = []
  const params: any[] = []

  if (q.date_from) { conditions.push('estimate_date >= ?'); params.push(q.date_from) }
  if (q.date_to) { conditions.push('estimate_date <= ?'); params.push(q.date_to) }
  if (q.client_name) { conditions.push('client_name LIKE ?'); params.push(`%${q.client_name}%`) }
  if (q.structure) { conditions.push('structure = ?'); params.push(q.structure) }
  if (q.building_use) { conditions.push('building_use = ?'); params.push(q.building_use) }
  if (q.material_type) { conditions.push('material_type = ?'); params.push(q.material_type) }
  if (q.result) { conditions.push('result = ?'); params.push(q.result) }
  if (q.estimator) { conditions.push('estimator = ?'); params.push(q.estimator) }
  if (q.lost_reason) { conditions.push('lost_reason = ?'); params.push(q.lost_reason) }
  if (q.search) {
    conditions.push('(estimate_no LIKE ? OR site_name LIKE ? OR client_name LIKE ? OR remarks LIKE ?)')
    const s = `%${q.search}%`
    params.push(s, s, s, s)
  }
  if (q.price_min) { conditions.push('unit_price >= ?'); params.push(parseFloat(q.price_min)) }
  if (q.price_max) { conditions.push('unit_price <= ?'); params.push(parseFloat(q.price_max)) }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''
  const sortField = q.sort || 'estimate_date'
  const sortOrder = (q.order || 'desc').toUpperCase() === 'ASC' ? 'ASC' : 'DESC'
  const allowedSort = ['estimate_date', 'estimate_no', 'client_name', 'site_name', 'structure', 'rebar_quantity', 'estimate_amount', 'unit_price', 'result']
  const safeSortField = allowedSort.includes(sortField) ? sortField : 'estimate_date'

  const sql = `SELECT * FROM estimates ${where} ORDER BY ${safeSortField} ${sortOrder}, id DESC`
  const { results } = await c.env.DB.prepare(sql).bind(...params).all()
  return c.json({ estimates: results })
})

// 単一取得
app.get('/api/estimates/:id', authMiddleware, async (c) => {
  const id = c.req.param('id')
  const row = await c.env.DB.prepare('SELECT * FROM estimates WHERE id = ?').bind(id).first()
  if (!row) return c.json({ error: '見積データが見つかりません' }, 404)
  return c.json({ estimate: row })
})

// 新規登録
app.post('/api/estimates', authMiddleware, async (c) => {
  const user = c.get('user')!
  const body = await c.req.json()

  const sql = `INSERT INTO estimates (
    estimate_no, estimate_date, client_name, site_name, site_location, structure, building_use,
    rebar_quantity, estimate_amount, unit_price, material_type, estimator, result, lost_reason, order_date, remarks,
    competitor, expected_actual_unit_price, profit_estimate, construction_period, construction_start_date,
    processing_start_date, difficulty, site_manager, re_estimate, client_contact_name, client_contact_info, created_by
  ) VALUES (?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?,?, ?)`

  const result = await c.env.DB.prepare(sql).bind(
    body.estimate_no || '',
    body.estimate_date || new Date().toISOString().split('T')[0],
    body.client_name || '',
    body.site_name || '',
    body.site_location || null,
    body.structure || null,
    body.building_use || null,
    body.rebar_quantity ? parseFloat(body.rebar_quantity) : null,
    body.estimate_amount ? parseFloat(body.estimate_amount) : null,
    body.unit_price ? parseFloat(body.unit_price) : null,
    body.material_type || null,
    body.estimator || null,
    body.result || '未定',
    body.lost_reason || null,
    body.order_date || null,
    body.remarks || null,
    body.competitor || null,
    body.expected_actual_unit_price ? parseFloat(body.expected_actual_unit_price) : null,
    body.profit_estimate ? parseFloat(body.profit_estimate) : null,
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
})

// 更新
app.put('/api/estimates/:id', authMiddleware, async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json()

  const sql = `UPDATE estimates SET
    estimate_no=?, estimate_date=?, client_name=?, site_name=?, site_location=?, structure=?, building_use=?,
    rebar_quantity=?, estimate_amount=?, unit_price=?, material_type=?, estimator=?, result=?, lost_reason=?, order_date=?, remarks=?,
    competitor=?, expected_actual_unit_price=?, profit_estimate=?, construction_period=?, construction_start_date=?,
    processing_start_date=?, difficulty=?, site_manager=?, re_estimate=?, client_contact_name=?, client_contact_info=?,
    updated_at=CURRENT_TIMESTAMP
    WHERE id=?`

  await c.env.DB.prepare(sql).bind(
    body.estimate_no || '',
    body.estimate_date || '',
    body.client_name || '',
    body.site_name || '',
    body.site_location || null,
    body.structure || null,
    body.building_use || null,
    body.rebar_quantity ? parseFloat(body.rebar_quantity) : null,
    body.estimate_amount ? parseFloat(body.estimate_amount) : null,
    body.unit_price ? parseFloat(body.unit_price) : null,
    body.material_type || null,
    body.estimator || null,
    body.result || '未定',
    body.lost_reason || null,
    body.order_date || null,
    body.remarks || null,
    body.competitor || null,
    body.expected_actual_unit_price ? parseFloat(body.expected_actual_unit_price) : null,
    body.profit_estimate ? parseFloat(body.profit_estimate) : null,
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
})

// 削除 (管理者のみ)
app.delete('/api/estimates/:id', authMiddleware, adminMiddleware, async (c) => {
  const id = c.req.param('id')
  await c.env.DB.prepare('DELETE FROM estimates WHERE id = ?').bind(id).run()
  return c.json({ success: true })
})

// ====== 集計API ======

// 全体集計＋元請け別＋構造別＋単価帯別＋失注理由別 (1リクエストでまとめて返す)
app.get('/api/stats', authMiddleware, async (c) => {
  const q = c.req.query()
  const conditions: string[] = []
  const params: any[] = []
  if (q.date_from) { conditions.push('estimate_date >= ?'); params.push(q.date_from) }
  if (q.date_to) { conditions.push('estimate_date <= ?'); params.push(q.date_to) }
  if (q.client_name) { conditions.push('client_name LIKE ?'); params.push(`%${q.client_name}%`) }
  if (q.structure) { conditions.push('structure = ?'); params.push(q.structure) }
  if (q.building_use) { conditions.push('building_use = ?'); params.push(q.building_use) }
  if (q.material_type) { conditions.push('material_type = ?'); params.push(q.material_type) }
  if (q.estimator) { conditions.push('estimator = ?'); params.push(q.estimator) }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''

  // 全体集計
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

  // 元請け別
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

  // 構造別
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

  // 単価帯別 (CASE文で分類)
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

  // 失注理由別
  const { results: byLostReason } = await c.env.DB.prepare(`
    SELECT
      COALESCE(lost_reason, '不明') AS lost_reason,
      COUNT(*) AS count
    FROM estimates ${where ? where + ' AND ' : 'WHERE '} result='失注'
    GROUP BY lost_reason
    ORDER BY count DESC
  `).bind(...params).all()

  // 月別集計 (年月をキーに)
  const { results: byMonth } = await c.env.DB.prepare(`
    SELECT
      substr(estimate_date, 1, 7) AS month,
      COUNT(*) AS total_count,
      SUM(CASE WHEN result='受注' THEN 1 ELSE 0 END) AS won_count,
      SUM(CASE WHEN result='失注' THEN 1 ELSE 0 END) AS lost_count,
      SUM(CASE WHEN result='未定' THEN 1 ELSE 0 END) AS pending_count
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
