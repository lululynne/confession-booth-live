/**
 * 告解室 · 后端（Vercel Serverless Function · Node runtime）
 *
 * 为什么不是 Edge Runtime：
 *   Edge 在 Hobby 计划上只有 ~25 秒墙钟，而 kimi 生成 14 条告解要跑几十秒，必然超时。
 *   Node runtime 可以把 maxDuration 拉到 60 秒。
 *   （Cloudflare Worker 版备份在 src/index.worker.js.bak，那边没有这个限制。）
 *
 * 环境变量：
 *   KIMI_API_KEY   ← 必填
 *   KIMI_BASE      ← 可选，默认 https://api.kimi.com/coding/v1
 *   KIMI_MODEL     ← 可选，默认 kimi-k3
 *   DEBUG_UPSTREAM ← 可选，设成 1 时把上游错误透传给前端（排障用，平时别开）
 */

export const config = { maxDuration: 60 };

const MAX_THEME_LEN = 24;
const CACHE_TTL_MS = 24 * 3600 * 1000;
const IP_LIMIT_PER_HOUR = 5;
const DAILY_BUDGET = 300;

const BLOCKED = [
  "习近平", "共产党", "六四", "法轮功", "台独", "港独", "疆独",
  "自杀", "自残", "儿童", "幼女", "萝莉", "未成年",
  "强奸", "迷奸", "毒品", "冰毒", "枪支", "炸弹", "制毒",
];

// 内存态（同实例内有效）。将来接 KV 就替换这里。
const MEM = { cache: new Map(), rl: new Map(), day: { key: "", n: 0 } };

const SYSTEM_PROMPT = `你是一个互动网页的内容生成器。你只输出一个 JSON 对象，不输出任何解释、前言、代码块标记。格式：
{"entries": [12 条告解组成的数组]}

给定一个主题「X」，生成 12 条「告解」。每条格式严格如下：
{"c": "招供", "v": "戒律原文。<em>把戒律掰弯的诡辩</em>", "r": "（对方的反应）"}

写作规则（这是全部的机关，必须严格遵守）：
1. c = 第一人称招供一件明知故犯的事。具体、有画面、有细节，不要抽象。
2. v = 先引一条「戒律」（规章/教练的话/自己立的flag/说明书/长辈的叮嘱，看主题而定），然后用 <em> 标签包住诡辩——**用这条戒律本身的字面逻辑，为违规辩护**。越一本正经、越像法条解读，越好笑。诡辩必须站得住形式逻辑，不能耍赖。
3. r = 那个「被辜负的对象」的反应，一句，留白。**不要写对方生气、不要写对方说话，要写对方的一个小动作或一个细节。**
4. 12 条要有递进：从「只是小小破个例」一路走到彻底放飞，最后一条是转折收尾——不煽情，用一个细节收。
5. 中文，口语，机灵但不油腻。不要网络烂梗，不要 emoji，不要说教。
6. 幽默向，不涉政治、不涉未成年、不涉违法、不涉自伤。如果主题本身不适合，就往生活化的方向轻轻拐个弯。

只输出 JSON 对象 {"entries": [...]}，第一个字符必须是 {，最后一个字符必须是 }。`;

export default async function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // 临时排障后门（2026-07-27）：带对暗号的请求头也能看 detail，查完这条就删。
  const debug = process.env.DEBUG_UPSTREAM === "1"
    || req.headers["x-debug-token"] === "wz9k-temp-20260727";
  const body = typeof req.body === "string" ? safeParse(req.body) : (req.body || {});
  const theme = String(body.theme || "").trim().replace(/\s+/g, " ").slice(0, MAX_THEME_LEN);

  if (!theme) return res.status(400).json({ error: "先写个主题" });
  for (const w of BLOCKED) {
    if (theme.includes(w)) {
      return res.status(400).json({ error: "这个主题换一个吧，这里只收生活里的小罪过。" });
    }
  }

  // 缓存
  const hit = MEM.cache.get(theme);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return res.status(200).json({ theme, entries: hit.entries, cached: true });
  }

  // 单 IP 限流
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim()
    || req.headers["x-real-ip"] || "unknown";
  const hourKey = ip + ":" + Math.floor(Date.now() / 3600000);
  const used = MEM.rl.get(hourKey) || 0;
  if (used >= IP_LIMIT_PER_HOUR) {
    return res.status(429).json({ error: "你这一小时玩得有点凶，歇会儿再来。已经生成过的主题还能直接看。" });
  }

  // 每日总预算
  const dayKey = new Date().toISOString().slice(0, 10);
  if (MEM.day.key !== dayKey) MEM.day = { key: dayKey, n: 0 };
  if (MEM.day.n >= DAILY_BUDGET) {
    return res.status(429).json({ error: "今天的生成额度用完了，明天再来。已经有人生成过的主题还能玩。" });
  }
  MEM.rl.set(hourKey, used + 1);
  MEM.day.n += 1;

  const base = process.env.KIMI_BASE || "https://api.kimi.com/coding/v1";
  const model = process.env.KIMI_MODEL || "kimi-k3";
  const key = process.env.KIMI_API_KEY;

  if (!key) {
    return res.status(500).json({ error: "服务端没配密钥。", detail: debug ? "KIMI_API_KEY missing" : undefined });
  }

  let upstream, rawText;
  try {
    upstream = await fetch(base + "/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + key },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: "主题：" + theme },
        ],
        // kimi-k3 只接受 temperature=1（2026-07-27 实测：传 0.9 直接 400
        // invalid temperature: only 1 is allowed for this model）。索性不传，用模型默认。
        max_tokens: 3200,
        // temp 锁死在 1，裸写 JSON 偶尔会写坏（2026-07-27 线上三连败就是这个）。
        // JSON 模式实测 coding 端点支持，从根上按住手抖。
        response_format: { type: "json_object" },
      }),
    });
    rawText = await upstream.text();
  } catch (e) {
    return res.status(502).json({
      error: "生成服务连不上，等会儿再试。",
      detail: debug ? String(e).slice(0, 300) : undefined,
    });
  }

  if (!upstream.ok) {
    console.log("upstream", upstream.status, rawText.slice(0, 400));
    return res.status(502).json({
      error: "生成失败了，等会儿再试。",
      detail: debug ? `HTTP ${upstream.status} ${rawText.slice(0, 300)}` : undefined,
    });
  }

  let text;
  try {
    text = JSON.parse(rawText)?.choices?.[0]?.message?.content || "";
  } catch {
    return res.status(502).json({
      error: "生成结果读不出来。",
      detail: debug ? rawText.slice(0, 300) : undefined,
    });
  }

  // 解析三级梯子：JSON 模式整体解析 → 抠数组 → 逐条打捞。
  // temp 锁死在 1 时模型偶尔写坏一条，不能让一条坏的拖死整锅。
  let entries = null;
  try {
    const obj = JSON.parse(text);
    entries = Array.isArray(obj) ? obj : obj.entries;
  } catch {}
  if (!Array.isArray(entries)) {
    try {
      const m = text.match(/\[[\s\S]*\]/);
      if (m) entries = JSON.parse(m[0]);
    } catch {}
  }
  if (!Array.isArray(entries)) {
    entries = [];
    const one = /\{\s*"c"\s*:\s*"(?:[^"\\]|\\.)*"\s*,\s*"v"\s*:\s*"(?:[^"\\]|\\.)*"\s*,\s*"r"\s*:\s*"(?:[^"\\]|\\.)*"\s*\}/g;
    for (const m of text.match(one) || []) {
      try { entries.push(JSON.parse(m)); } catch {}
    }
  }
  if (!entries.length) {
    return res.status(502).json({
      error: "生成的内容格式不对，再试一次通常就好了。",
      detail: debug ? text.slice(0, 300) : undefined,
    });
  }

  entries = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && typeof e.c === "string" && typeof e.v === "string" && typeof e.r === "string")
    .slice(0, 20);

  if (entries.length < 6) {
    return res.status(502).json({
      error: "这次生成得太少了，再试一次。",
      detail: debug ? `parsed ${entries.length}` : undefined,
    });
  }

  MEM.cache.set(theme, { at: Date.now(), entries });
  return res.status(200).json({ theme, entries, cached: false });
}

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }
