import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import os from "os";
import { spawn } from "child_process";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const TMP_DIR = process.env.RAILWAY_ENVIRONMENT || process.env.VERCEL ? path.join(os.tmpdir(), "mediafreedom") : path.join(process.cwd(), "tmp");
fs.mkdirSync(TMP_DIR, { recursive: true });
const upload = multer({ dest: TMP_DIR, limits: { fileSize: 80 * 1024 * 1024 } });

app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(process.cwd(), "public")));

const clean = (p) => { try { fs.unlinkSync(p); } catch {} };
const title = (t) => t?.english || t?.romaji || t?.native || "Unknown";

async function fetchWithTimeout(url, options = {}, ms = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function jsonFetch(url, options = {}, ms = 9000) {
  const r = await fetchWithTimeout(url, options, ms);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

app.post("/api/anime-image", upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Choose an image." });
  try {
    const form = new FormData();
    form.append("image", new Blob([fs.readFileSync(req.file.path)]), req.file.originalname);
    const j = await jsonFetch("https://api.trace.moe/search", { method: "POST", body: form }, 15000);
    res.json(j);
  } catch (e) {
    res.status(502).json({ error: e.name === "AbortError" ? "Image recognition timed out. Please try again." : `Image recognition failed: ${e.message}` });
  } finally { clean(req.file.path); }
});

async function anilist(q) {
  const query = `query($s:String){Page(perPage:20){media(search:$s,type:ANIME){id title{romaji english native}startDate{year}episodes genres averageScore coverImage{large}siteUrl}}}`;
  const j = await jsonFetch("https://graphql.anilist.co", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({query,variables:{s:q}}) }, 9000);
  return (j.data?.Page?.media || []).map(x => ({id:x.id,title:title(x.title),year:x.startDate?.year,episodes:x.episodes,genres:x.genres?.slice(0,3),score:x.averageScore,image:x.coverImage?.large,url:x.siteUrl,type:"anime"}));
}

async function jikan(q) {
  const j = await jsonFetch(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(q)}&limit=20`, {}, 12000);
  return (j.data || []).map(x => ({id:x.mal_id,title:x.title_english||x.title||"Unknown",year:x.year||x.aired?.prop?.from?.year,episodes:x.episodes,genres:(x.genres||[]).slice(0,3).map(g=>g.name),score:x.score?Math.round(x.score*10):null,image:x.images?.jpg?.large_image_url||x.images?.jpg?.image_url||null,url:x.url,type:"anime"}));
}

async function animeSearch(q) {
  try {
    const a = await anilist(q);
    if (a.length) return {items:a,provider:"AniList"};
  } catch {}
  const a = await jikan(q);
  return {items:a,provider:"Jikan fallback"};
}

async function tmdb(q, language = "all") {
  if (!process.env.TMDB_API_KEY) return { movies: [], tv: [], unavailable: true };
  const langMap = { en:"en-US",hi:"hi-IN",ur:"ur-PK",ta:"ta-IN",te:"te-IN",ml:"ml-IN",bn:"bn-IN",pa:"pa-IN",mr:"mr-IN",kn:"kn-IN",gu:"gu-IN",ko:"ko-KR",ja:"ja-JP",zh:"zh-CN",ar:"ar-SA",es:"es-ES",fr:"fr-FR",de:"de-DE",pt:"pt-BR",tr:"tr-TR",th:"th-TH",id:"id-ID",ru:"ru-RU" };
  const displayLang = langMap[language] || "en-US";
  const url = `https://api.themoviedb.org/3/search/multi?api_key=${encodeURIComponent(process.env.TMDB_API_KEY)}&query=${encodeURIComponent(q)}&include_adult=false&language=${encodeURIComponent(displayLang)}`;
  const j = await jsonFetch(url, {}, 9000);
  const movies = [], tv = [];
  for (const x of (j.results || []).slice(0, 40)) {
    if (language !== "all" && x.original_language !== language) continue;
    const v = { id:x.id,title:x.title||x.name,year:(x.release_date||x.first_air_date||"").slice(0,4),overview:x.overview||"",image:x.poster_path?`https://image.tmdb.org/t/p/w500${x.poster_path}`:null,type:x.media_type,originalLanguage:x.original_language||"" };
    if (x.media_type === "movie") movies.push(v); else if (x.media_type === "tv") tv.push(v);
  }
  return { movies: movies.slice(0,20), tv: tv.slice(0,20) };
}

async function music(q, language = "all") {
  const countryMap = { en:"US",hi:"IN",ur:"PK",ta:"IN",te:"IN",ml:"IN",bn:"IN",pa:"IN",mr:"IN",kn:"IN",gu:"IN",ko:"KR",ja:"JP",zh:"CN",ar:"SA",es:"ES",fr:"FR",de:"DE",pt:"BR",tr:"TR",th:"TH",id:"ID",ru:"RU" };
  const country = countryMap[language] || "US";
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&entity=song&limit=20&country=${country}`;
  const j = await jsonFetch(url, {}, 9000);
  return (j.results || []).map(x => ({
    id:x.trackId,title:x.trackName||"Unknown track",artist:x.artistName||"Unknown artist",album:x.collectionName||"Unknown album",
    image:(x.artworkUrl100||"").replace("100x100","600x600"),preview:x.previewUrl||"",url:x.trackViewUrl||"",year:x.releaseDate?x.releaseDate.slice(0,4):""
  }));
}

app.get("/api/music", async (req, res) => {
  const q = String(req.query.q || "").trim();
  const language = String(req.query.lang || "all").toLowerCase();
  if (!q) return res.status(400).json({ error: "Enter a search." });
  try { res.json({ query:q, tracks:await music(q,language) }); }
  catch (e) { res.status(502).json({ error: e.name === "AbortError" ? "Music search timed out." : `Music search failed: ${e.message}` }); }
});

app.get("/api/search", async (req, res) => {
  const q = String(req.query.q || "").trim();
  const language = String(req.query.lang || "all").toLowerCase();
  const adult = String(req.query.adult || "0") === "1";
  if (!q) return res.status(400).json({ error: "Enter a search." });

  const results = await Promise.allSettled([
    animeSearch(q),
    tmdb(q, language),
    music(q, language)
  ]);
  const [ar, tr, mr] = results;
  const errors = {};
  const animePack = ar.status === "fulfilled" ? ar.value : (errors.anime = "Anime services unavailable", {items:[],provider:"Unavailable"});
  const anime = animePack.items || [];
  const tm = tr.status === "fulfilled" ? tr.value : (errors.tmdb = "Movie/TV service unavailable", {movies:[],tv:[]});
  const mus = mr.status === "fulfilled" ? mr.value : (errors.music = "Music service unavailable", []);
  if (tm.unavailable) errors.tmdb = "TMDB key not configured; TV fallback will be used";
  if (!tm.unavailable && !tm.movies.length && !tm.tv.length) errors.tmdb = "No movie/TV matches from TMDB";

  const queryText = language !== "all" ? `${q} ${language}` : q;
  const e = encodeURIComponent(queryText);
  const safe = adult ? "off" : "active";
  let tv = tm.tv || [];
  if (tv.length === 0) {
    try {
      const tj = await jsonFetch(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(q)}`, {}, 9000);
      tv = (tj || []).slice(0,20).map(x=>({id:x.show?.id,title:x.show?.name||"Unknown",year:(x.show?.premiered||"").slice(0,4),overview:(x.show?.summary||"").replace(/<[^>]+>/g,""),image:x.show?.image?.medium||x.show?.image?.original||null,type:"tv",url:x.show?.url,originalLanguage:x.show?.language||""}));
      if (tv.length) delete errors.tmdb;
    } catch { if (!errors.tmdb) errors.tmdb="TV service unavailable"; }
  }
  res.json({
    query:q, anime, animeProvider:animePack.provider, movies:tm.movies || [], tv, music:mus, errors,
    shortcuts:[
      ["Google",`https://www.google.com/search?q=${e}&safe=${safe}`],
      ["Google Images",`https://www.google.com/search?tbm=isch&q=${e}&safe=${safe}`],
      ["Bing",`https://www.bing.com/search?q=${e}&adlt=${adult?"off":"strict"}`],
      ["DuckDuckGo",`https://duckduckgo.com/?q=${e}&kp=${adult?"-2":"1"}`],
      ["YouTube",`https://www.youtube.com/results?search_query=${e}`],
      ["Reddit",`https://www.reddit.com/search/?q=${e}&include_over_18=${adult?"1":"0"}`],
      ["IMDb",`https://www.imdb.com/find/?q=${e}`],
      ["MyAnimeList",`https://myanimelist.net/search/all?q=${e}`]
    ]
  });
});

app.post("/api/video-info", upload.single("video"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error:"Choose a video." });
  const outDir = path.join(TMP_DIR, `frames-${Date.now()}`);
  fs.mkdirSync(outDir, { recursive:true });
  const pattern = path.join(outDir, "frame-%02d.jpg");
  const args = ["-i",req.file.path,"-vf","fps=1/15,scale=960:-2","-frames:v","8","-q:v","4",pattern];
  const p = spawn("ffmpeg", args);
  let err = "";
  p.stderr.on("data", d => err += d);
  p.on("error", () => res.json({ok:false,frames:[],error:"FFmpeg is not installed on this server. The search engine itself is working."}));
  p.on("close", code => {
    if (code === null) return;
    const frames = code === 0 ? fs.readdirSync(outDir).filter(x=>x.endsWith(".jpg")).sort().map(x=>`/tmpframes/${path.basename(outDir)}/${x}`) : [];
    res.json({ok:code===0,frames,error:code===0?null:"FFmpeg is not installed or the video could not be read."});
    setTimeout(()=>{fs.rm(outDir,{recursive:true,force:true},()=>{});clean(req.file.path)},600000);
  });
});

app.use("/tmpframes", express.static(TMP_DIR));

function validHttpUrl(value){try{const u=new URL(value);return u.protocol==='http:'||u.protocol==='https:'?u.toString().replace(/\/$/,""):null}catch{return null}}
app.get("/api/domain-info",(req,res)=>{
  const host=String(req.get("host")||"");
  const proto=String(req.get("x-forwarded-proto")||req.protocol||"http").split(",")[0].trim();
  const current=validHttpUrl(process.env.PUBLIC_URL||`${proto}://${host}`)||`${proto}://${host}`;
  const primary=validHttpUrl(process.env.PRIMARY_URL||current)||current;
  const backups=String(process.env.BACKUP_URLS||"").split(",").map(x=>validHttpUrl(x.trim())).filter(Boolean).filter(x=>x!==current&&x!==primary);
  res.json({current,primary,backups,bookmarkable:true,configured:!!process.env.PRIMARY_URL||backups.length>0});
});

app.get("/api/health",(req,res)=>res.json({ok:true,tmdb:!!process.env.TMDB_API_KEY,port:PORT,node:process.version}));

if (!process.env.VERCEL) app.listen(PORT,"0.0.0.0",()=>console.log(`MediaFreedom Search → http://localhost:${PORT}`));
export default app;
