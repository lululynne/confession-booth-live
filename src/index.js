/**
 * 告解室 · 后端
 *
 * 只干三件事：
 *   1. 挡住乱来的请求（输入校验 + 限流 + 每日预算）
 *   2. 拿着 API key 去问 kimi 要内容（key 只活在这里，前端永远看不到）
 *   3. 把结果缓存起来，同一个主题第二个人来白嫖缓存，不再花钱
 *
 * 前端在 public/index.html，由 Workers Assets 直接托管，不经过这里。
 */

const MAX_THEME_LEN = 24;

// 输入闸：这些不生成。不是道德审查，是别让这个小玩具变成麻烦。
const BLOCKED = [
  "习近平", "共产党", "六四", "法轮功", "台独", "港独", "疆独",
  "自杀", "自残", "儿童", "幼女", "萝莉", "未成年",
  "强奸", "迷奸", "毒品", "冰毒", "枪支", "炸弹", "制毒",
];

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

function normalizeTheme(s) {
  return (s || "").trim().replace(/\s+/g, " ").slice(0, MAX_THEME_LEN);
}

/** 简单计数器限流：给 key 加一，超过 limit 返回 false */
async function bump(env, key, limit, ttlSec) {
  const cur = parseInt((await env.CACHE.get(key)) || "0", 10);
  if (cur >= limit) return false;
  // 首次写入才设 TTL，后续续写保持原窗口（够用，不追求毫秒级精确）
  await env.CACHE.put(key, String(cur + 1), { expirationTtl: ttlSec });
  return true;
}

async function handleGenerate(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "请求格式不对" }, 400);
  }

  const theme = normalizeTheme(body.theme);

  // —— 输入校验 ——
  if (!theme) return json({ error: "先写个主题" }, 400);
  if (theme.length < 1) return json({ error: "主题太短了" }, 400);
  for (const w of BLOCKED) {
    if (theme.includes(w)) {
      return json({ error: "这个主题换一个吧，这里只收生活里的小罪过。" }, 400);
    }
  }

  // —— 缓存命中就直接给，不花钱 ——
  const cacheKey = "theme:" + theme;
  const cached = await env.CACHE.get(cacheKey, { type: "json" });
  if (cached && Array.isArray(cached) && cached.length) {
    return json({ theme, entries: cached, cached: true });
  }

  // —— 限流：单 IP / 小时 ——
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const hourBucket = Math.floor(Date.now() / 3600000);
  const okIp = await bump(
    env, `rl:${ip}:${hourBucket}`, parseInt(env.IP_LIMIT_PER_HOUR, 10), 3700
  );
  if (!okIp) {
    return json({ error: "你这一小时玩得有点凶，歇会儿再来。已经生成过的主题还能直接看。" }, 429);
  }

  // —— 每日总预算：防止有人写脚本刷爆 ——
  const dayBucket = new Date().toISOString().slice(0, 10);
  const okDay = await bump(
    env, `budget:${dayBucket}`, parseInt(env.DAILY_BUDGET, 10), 90000
  );
  if (!okDay) {
    return json({ error: "今天的生成额度用完了，明天再来。已经有人生成过的主题还能玩。" }, 429);
  }

  // —— 去问 kimi ——
  let upstream;
  try {
    upstream = await fetch(env.KIMI_BASE + "/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + env.KIMI_API_KEY,
      },
      body: JSON.stringify({
        model: env.KIMI_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: "主题：" + theme },
        ],
        temperature: 0.9,
        max_tokens: 4000,
      }),
    });
  } catch (e) {
    return json({ error: "生成服务连不上，等会儿再试。" }, 502);
  }

  if (!upstream.ok) {
    // 不把上游的错误原文吐给用户（可能带内部信息）
    console.log("upstream error", upstream.status, await upstream.text().catch(() => ""));
    return json({ error: "生成失败了，等会儿再试。" }, 502);
  }

  let text;
  try {
    const data = await upstream.json();
    text = data?.choices?.[0]?.message?.content || "";
  } catch {
    return json({ error: "生成结果读不出来。" }, 502);
  }

  // —— 解析：模型偶尔会包代码块或加前言，捞出第一个 JSON 数组 ——
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

  if (entries.length < 6) {
    return json({ error: "这次生成得太少了，再试一次。" }, 502);
  }

  // —— 存缓存，下一个人白嫖 ——
  await env.CACHE.put(cacheKey, JSON.stringify(entries), {
    expirationTtl: parseInt(env.CACHE_TTL_SEC, 10),
  });

  return json({ theme, entries, cached: false });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/generate") {
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
      try {
        return await handleGenerate(request, env);
      } catch (e) {
        console.log("unhandled", e && e.stack);
        return json({ error: "出了点问题，等会儿再试。" }, 500);
      }
    }

    // 其余全部交给静态资源（public/index.html）
    return env.ASSETS.fetch(request);
  },
};
