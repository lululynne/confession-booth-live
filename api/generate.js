/**
 * 告解室 · 后端（Vercel Edge Function 版）
 *
 * 跟 Cloudflare Worker 版是同一套逻辑，只换了外壳：
 *   - Worker 版备份在 src/index.worker.js.bak，将来 Cloudflare 那个号修好了能搬回去
 *   - 这边用 Edge Runtime，fetch/Request/Response 都跟 Worker 一样，所以核心代码没动
 *
 * 差别只有一处：Vercel 免费版没有 KV，所以持久缓存和跨实例限流暂时不做，
 * 用内存缓存 + 内存限流顶着（同一个 edge 实例内有效）。
 * 上线跑通之后再接 Vercel KV 补上——那时候把下面 MEM 那两处换掉即可。
 *
 * 需要的环境变量（在 Vercel 项目设置里配）：
 *   KIMI_API_KEY   ← 必填，密钥
 *   KIMI_BASE      ← 可选，默认 https://api.kimi.com/coding/v1
 *   KIMI_MODEL     ← 可选，默认 kimi-k3
 */

export const config = { runtime: "edge" };

const MAX_THEME_LEN = 24;
const CACHE_TTL_MS = 24 * 3600 * 1000;
const IP_LIMIT_PER_HOUR = 5;
const DAILY_BUDGET = 300;

// 输入闸：这些不生成。不是道德审查，是别让这个小玩具变成麻烦。
const BLOCKED = [
  "习近平", "共产党", "六四", "法轮功", "台独", "港独", "疆独",
  "自杀", "自残", "儿童", "幼女", "萝莉", "未成年",
  "强奸", "迷奸", "毒品", "冰毒", "枪支", "炸弹", "制毒",
];

// —— 内存态（同一 edge 实例内有效，实例回收就清空。接 KV 后替换这两个） ——
const MEM = { cache: new Map(), rl: new Map(), day: { key: "", n: 0 } };

const SYSTEM_PROMPT = `你是一个互动网页的内容生成器。你只输出 JSON 数组，不输出任何解释、前言、代码块标记。

给定一个主题「X」，生成 14 条「告解」。每条格式严格如下：
{"c": "招供", "v": "戒律原文。<em>把戒律掰弯的诡辩</em>", "r": "（对方的反应）"}

写作规则（这是全部的机关，必须严格遵守）：
1. c = 第一人称招供一件明知故犯的事。具体、有画面、有细节，不要抽象。
2. v = 先引一条「戒律」（规章/教练的话/自己立的flag/说明书/长辈的叮嘱，看主题而定），然后用 <em> 标签包住诡辩——**用这条戒律本身的字面逻辑，为违规辩护**。越一本正经、越像法条解读，越好笑。诡辩必须站得住形式逻辑，不能耍赖。
3. r = 那个「被辜负的对象」的反应，一句，留白。**不要写对方生气、不要写对方说话，要写对方的一个小动作或一个细节。**
4. 14 条要有递进：从「只是小小破个例」一路走到彻底放飞，最后一条是转折收尾——不煽情，用一个细节收。
5. 中文，口语，机灵但不油腻。不要网络烂梗，不要 emoji，不要说教。
6. 幽默向，不涉政治、不涉未成年、不涉违法、不涉自伤。如果主题本身不适合，就往生活化的方向轻轻拐个弯。

只输出 JSON 数组，第一个字符必须是 [，最后一个字符必须是 ]。`;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json;charset=utf-8", "cache-control": "no-store" },
  });
}

export default async function handler(request) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: "请求格式不对" }, 400); }

  const theme = (body.theme || "").trim().replace(/\s+/g, " ").slice(0, MAX_THEME_LEN);
  if (!theme) return json({ error: "先写个主题" }, 400);
  for (const w of BLOCKED) {
    if (theme.includes(w)) return json({ error: "这个主题换一个吧，这里只收生活里的小罪过。" }, 400);
  }

  // —— 缓存命中就直接给，不花钱 ——
  const hit = MEM.cache.get(theme);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return json({ theme, entries: hit.entries, cached: true });
  }

  // —— 单 IP 限流 ——
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip") || "unknown";
  const hourKey = ip + ":" + Math.floor(Date.now() / 3600000);
  const used = MEM.rl.get(hourKey) || 0;
  if (used >= IP_LIMIT_PER_HOUR) {
    return json({ error: "你这一小时玩得有点凶，歇会儿再来。已经生成过的主题还能直接看。" }, 429);
  }

  // —— 每日总预算 ——
  const dayKey = new Date().toISOString().slice(0, 10);
  if (MEM.day.key !== dayKey) MEM.day = { key: dayKey, n: 0 };
  if (MEM.day.n >= DAILY_BUDGET) {
    return json({ error: "今天的生成额度用完了，明天再来。已经有人生成过的主题还能玩。" }, 429);
  }

  MEM.rl.set(hourKey, used + 1);
  MEM.day.n += 1;

  // —— 去问 kimi ——
  const base = process.env.KIMI_BASE || "https://api.kimi.com/coding/v1";
  const model = process.env.KIMI_MODEL || "kimi-k3";

  let upstream;
  try {
    upstream = await fetch(base + "/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + process.env.KIMI_API_KEY,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: "主题：" + theme },
        ],
        temperature: 0.9,
        max_tokens: 4000,
      }),
    });
  } catch {
    return json({ error: "生成服务连不上，等会儿再试。" }, 502);
  }

  if (!upstream.ok) {
    console.log("upstream", upstream.status, await upstream.text().catch(() => ""));
    return json({ error: "生成失败了，等会儿再试。" }, 502);
  }

  let text;
  try {
    const data = await upstream.json();
    text = data?.choices?.[0]?.message?.content || "";
  } catch { return json({ error: "生成结果读不出来。" }, 502); }

  let entries;
  try {
    const m = text.match(/\[[\s\S]*\]/);
    entries = JSON.parse(m ? m[0] : text);
  } catch {
    return json({ error: "生成的内容格式不对，再试一次通常就好了。" }, 502);
  }

  entries = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && typeof e.c === "string" && typeof e.v === "string" && typeof e.r === "string")
    .slice(0, 20);

  if (entries.length < 6) return json({ error: "这次生成得太少了，再试一次。" }, 502);

  MEM.cache.set(theme, { at: Date.now(), entries });
  return json({ theme, entries, cached: false });
}
