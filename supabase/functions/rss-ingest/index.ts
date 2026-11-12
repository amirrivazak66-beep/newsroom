import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { publicSourceFetch, limitedBody } from "../_shared/public-fetch.ts";
import { authorizeWebAdmin } from "../_shared/auth.ts";
import { recordDiagnostic } from "../_shared/diagnostics.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
function tag(block: string, name: string): string {
  const re = new RegExp("<(?:[\\w.-]+:)?" + name + "\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?" + name + "\\s*>", "i");
  return decodeXml(block.match(re)?.[1] || "");
}
function parseItems(xml: string, limit: number) {
  const blocks = [...xml.matchAll(/<(?:item|entry)\b[^>]*>[\s\S]*?<\/(?:item|entry)\s*>/gi)].slice(0, limit);
  return blocks.map((m) => {
    const b = m[0];
    const title = tag(b, "title");
    let link = tag(b, "link");
    if (!link) link = b.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*\/?\s*>/i)?.[1] || "";
    const description = tag(b, "encoded") || tag(b, "description") || tag(b, "summary") || tag(b, "content");
    const dateText = tag(b, "pubDate") || tag(b, "published") || tag(b, "updated") || tag(b, "date");
    // RSS image extraction: enclosure, media:content/thumbnail, Atom links,
    // then HTML inside description/content:encoded (including CDATA).
    const rawImage = b.match(/<enclosure\b[^>]*url=["']([^"']+)["']/i)?.[1]
      || b.match(/<enclosure\b[^>]*url=["']([^"']+)["']/i)?.[1]
      || b.match(/<(?:media:content|media:thumbnail|media:group)\b[^>]*url=["']([^"']+)["']/i)?.[1]
      || b.match(/<link\b[^>]*rel=["']enclosure["'][^>]*href=["']([^"']+)["']/i)?.[1]
      || b.match(/<img\b[^>]*src=["']([^"']+)["']/i)?.[1]
      || b.match(/<img\b[^>]*srcset=["']([^"']+)["']/i)?.[1]?.split(/[ ,]/)[0]
      || b.match(/&lt;img\b[^&]*?src=["']([^"']+)["']/i)?.[1] || "";
    let safeLink = "";
    let safeImage = "";
    try { const u = new URL(link); if (u.protocol === "https:" || u.protocol === "http:") safeLink = u.toString(); } catch {}
    try { const u = new URL(rawImage); if (u.protocol === "https:" || u.protocol === "http:") safeImage = u.toString(); } catch {}
    const parsedDate = dateText ? new Date(dateText) : new Date();
    return { title: title.slice(0, 500), link: safeLink, summary: description.slice(0, 4000), image: safeImage || null, pubDate: Number.isNaN(parsedDate.getTime()) ? new Date().toISOString() : parsedDate.toISOString() };
  }).filter((x) => x.title && x.link);
}
function hostOf(url: string) { try { return new URL(url).hostname.replace(/^www\./, "").slice(0, 200); } catch { return "منبع خبری"; } }

function decodeJwtClaims(token: string): Record<string, unknown> {
  try {
    const encoded = token.split(".")[1];
    if (!encoded) return {};
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(encoded.length / 4) * 4, "=");
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch { return {}; }
}

function hasAdminMfa(claims: Record<string, unknown>): boolean {
  return claims.aal === "aal2";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "POST required" }), { status: 405, headers: cors });
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  if (!supabaseUrl || !serviceKey) return new Response(JSON.stringify({ error: "Server configuration missing" }), { status: 500, headers: cors });
  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  // Use the same Vault-backed verifier as the automation runner and publisher.
  // A service-role bearer token alone must never authorize a cron request.
  const cronCandidate = req.headers.get("x-radin-cron-secret") || "";
  let cronAuthorized = false;
  if (cronCandidate) {
    const { data: authorized, error: cronError } = await db.rpc("verify_radin_cron_secret", { candidate: cronCandidate });
    if (cronError) return new Response(JSON.stringify({ error: "Cron authorization unavailable" }), { status: 503, headers: cors });
    cronAuthorized = authorized === true;
  }

  if (!cronAuthorized) {
    const authorized=await authorizeWebAdmin(db,req.headers.get("authorization")||"");
    if(!authorized.ok)return new Response(JSON.stringify({error:authorized.error}),{status:authorized.status,headers:cors});
  }

  const { data: feeds, error: feedsError } = await db.from("rss_feeds")
    .select("id,category,url,item_count,include_media,update_interval_minutes,last_fetched_at")
    .eq("enabled", true).order("created_at").limit(100);
  if (feedsError) return new Response(JSON.stringify({ error: "Could not load feeds", detail: feedsError.message }), { status: 500, headers: cors });

  const reports: Array<Record<string, unknown>> = [];
  let totalFetched = 0, totalUpserted = 0;
  for (const feed of feeds || []) {
    if(cronAuthorized&&feed.last_fetched_at&&Date.now()-Date.parse(feed.last_fetched_at)<Math.max(5,Number(feed.update_interval_minutes)||15)*60000){reports.push({feed:hostOf(feed.url),ok:true,skipped:"interval_not_due"});continue;}
    try {
      const url = new URL(feed.url);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("Unsupported feed protocol");
      const response = await publicSourceFetch(url.toString(), { headers: { "User-Agent": "KhabarRadinBot/1.0 (+https://khabarradin.ir)", "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5" }, signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error("Feed HTTP " + response.status);
      const xml = new TextDecoder().decode(await limitedBody(response,4_000_000));
      if (xml.length > 4_000_000) throw new Error("Feed response too large");
      const parsed = parseItems(xml, Math.min(50, Math.max(1, Number(feed.item_count) || 10)));
      const rows = parsed.map((item) => ({
        feed_id: feed.id, category: feed.category || "عمومی", title: item.title,
        summary: item.summary, image_url: feed.include_media === false ? null : item.image,
        source_url: item.link, source_name: hostOf(feed.url), pub_date: item.pubDate,
        published: false, review_status: "pending",
      }));
      const recent=rows.filter(row=>Date.parse(row.pub_date)>=Date.now()-48*60*60*1000);
      const uniqueRows=[...new Map(recent.map(row=>[row.source_url.replace(/([?&])utm_[^&]+/g,"$1").replace(/[?&]$/,""),row])).values()];
      const batch=await db.rpc("ingest_rss_batch",{p_rows:uniqueRows});
      if(batch.error)throw batch.error;
      const newCount=Number(batch.data?.inserted||0);
      await db.from("rss_feeds").update({ last_fetched_at: new Date().toISOString(), last_error: null }).eq("id", feed.id);
      totalFetched += parsed.length; totalUpserted += newCount;
      reports.push({ feed: hostOf(feed.url), fetched: parsed.length, newItems: newCount, ok: true });
    } catch (e) {
      // PostgREST errors are plain objects, not instances of Error.
      const message = (e && typeof e === "object" && "message" in e && typeof e.message === "string"
        ? e.message : "Unknown feed error").slice(0, 500);
      await db.from("rss_feeds").update({ last_fetched_at: new Date().toISOString(), last_error: message }).eq("id", feed.id);
      await recordDiagnostic(db,{component:"rss",operation:"ingest",error_code:"feed_failed",error_message:message});
      reports.push({ feed: hostOf(feed.url), fetched: 0, ok: false, error: message });
    }
  }
  return new Response(JSON.stringify({ ok: reports.every((r) => r.ok), feeds: reports.length, totalFetched, totalUpserted, reports, note: "RSS stories are saved as pending review and are not published automatically." }), { status: 200, headers: cors });
});
