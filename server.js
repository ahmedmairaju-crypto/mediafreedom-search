import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";

const app=express();
const upload=multer({dest:"tmp/",limits:{fileSize:80*1024*1024}});
const PORT=process.env.PORT||3000;
app.use(express.json());
app.use(express.static("public"));

const clean=p=>{try{fs.unlinkSync(p)}catch{}};
const title=t=>t?.english||t?.romaji||t?.native||"Unknown";

app.post("/api/anime-image",upload.single("image"),async(req,res)=>{
  if(!req.file)return res.status(400).json({error:"Choose an image."});
  try{
    const form=new FormData();
    form.append("image",new Blob([fs.readFileSync(req.file.path)]),req.file.originalname);
    const r=await fetch("https://api.trace.moe/search",{method:"POST",body:form});
    if(!r.ok)throw Error(`trace.moe: ${r.status}`);
    res.json(await r.json());
  }catch(e){res.status(500).json({error:e.message})}finally{clean(req.file.path)}
});

async function anilist(q){
  const query=`query($s:String){Page(perPage:20){media(search:$s,type:ANIME){id title{romaji english native}startDate{year}episodes genres averageScore coverImage{large}siteUrl}}}`;
  const r=await fetch("https://graphql.anilist.co",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({query,variables:{s:q}})});
  if(!r.ok)return[];
  const j=await r.json();
  return(j.data?.Page?.media||[]).map(x=>({id:x.id,title:title(x.title),year:x.startDate?.year,episodes:x.episodes,genres:x.genres?.slice(0,3),score:x.averageScore,image:x.coverImage?.large,url:x.siteUrl,type:"anime"}));
}

async function tmdb(q,language="all"){
  if(!process.env.TMDB_API_KEY)return{movies:[],tv:[]};
  const langMap={en:"en-US",hi:"hi-IN",ur:"ur-PK",ta:"ta-IN",te:"te-IN",ml:"ml-IN",bn:"bn-IN",pa:"pa-IN",mr:"mr-IN",kn:"kn-IN",gu:"gu-IN",ko:"ko-KR",ja:"ja-JP",zh:"zh-CN",ar:"ar-SA",es:"es-ES",fr:"fr-FR",de:"de-DE",pt:"pt-BR",tr:"tr-TR",th:"th-TH",id:"id-ID",ru:"ru-RU"};
  const displayLang=langMap[language]||"en-US";
  const r=await fetch(`https://api.themoviedb.org/3/search/multi?api_key=${encodeURIComponent(process.env.TMDB_API_KEY)}&query=${encodeURIComponent(q)}&include_adult=false&language=${encodeURIComponent(displayLang)}`);
  if(!r.ok)return{movies:[],tv:[]};
  const j=await r.json(),movies=[],tv=[];
  for(const x of(j.results||[]).slice(0,40)){
    if(language!=="all" && x.original_language!==language)continue;
    const v={id:x.id,title:x.title||x.name,year:(x.release_date||x.first_air_date||"").slice(0,4),overview:x.overview||"",image:x.poster_path?`https://image.tmdb.org/t/p/w500${x.poster_path}`:null,type:x.media_type,originalLanguage:x.original_language||""};
    if(x.media_type==="movie")movies.push(v); else if(x.media_type==="tv")tv.push(v);
  }
  return{movies:movies.slice(0,20),tv:tv.slice(0,20)};
}

async function music(q,language="all"){
  const countryMap={en:"US",hi:"IN",ur:"PK",ta:"IN",te:"IN",ml:"IN",bn:"IN",pa:"IN",mr:"IN",kn:"IN",gu:"IN",ko:"KR",ja:"JP",zh:"CN",ar:"SA",es:"ES",fr:"FR",de:"DE",pt:"BR",tr:"TR",th:"TH",id:"ID",ru:"RU"};
  const country=countryMap[language]||"US";
  const r=await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&entity=song&limit=20&country=${country}`);
  if(!r.ok)return[];
  const j=await r.json();
  return(j.results||[]).map(x=>({
    id:x.trackId,title:x.trackName||"Unknown track",artist:x.artistName||"Unknown artist",album:x.collectionName||"Unknown album",
    image:(x.artworkUrl100||"").replace("100x100","600x600"),preview:x.previewUrl||"",url:x.trackViewUrl||"",year:x.releaseDate?x.releaseDate.slice(0,4):""
  }));
}

app.get("/api/music",async(req,res)=>{
  const q=String(req.query.q||"").trim();
  const language=String(req.query.lang||"all").toLowerCase();
  if(!q)return res.status(400).json({error:"Enter a search."});
  try{
    const tracks=await music(q,language);
    res.json({query:q,tracks});
  }catch(e){res.status(500).json({error:e.message});}
});

app.get("/api/search",async(req,res)=>{
  const q=String(req.query.q||"").trim();
  const language=String(req.query.lang||"all").toLowerCase();
  const adult=String(req.query.adult||"0")==="1";
  if(!q)return res.status(400).json({error:"Enter a search."});
  const [a,t,m]=await Promise.all([
    anilist(q).catch(()=>[]),
    tmdb(q,language).catch(()=>({movies:[],tv:[]})),
    music(q,language).catch(()=>[])
  ]);
  const queryText=language!=="all"?`${q} ${language}`:q;
  const e=encodeURIComponent(queryText);
  const safe=adult?"off":"active";
  const siteQ=adult?`${q} 18+`:q;
  const se=encodeURIComponent(siteQ);
  res.json({
    query:q,anime:a,movies:t.movies,tv:t.tv,music:m,
    shortcuts:[
      ["Google",`https://www.google.com/search?q=${e}&safe=${safe}`],
      ["Google Images",`https://www.google.com/search?tbm=isch&q=${e}&safe=${safe}`],
      ["Bing",`https://www.bing.com/search?q=${e}&adlt=${adult?"off":"strict"}`],
      ["DuckDuckGo",`https://duckduckgo.com/?q=${e}&kp=${adult?"-2":"1"}`],
      ["YouTube",`https://www.youtube.com/results?search_query=${e}`],
      ["Reddit",`https://www.reddit.com/search/?q=${e}&include_over_18=${adult?"1":"0"}`],
      ["IMDb",`https://www.imdb.com/find/?q=${e}`],
      ["MyAnimeList",`https://myanimelist.net/search/all?q=${e}`],
    ]
  });
});

// Video workflow: extracts up to 8 JPEG frames if ffmpeg is installed, then the UI
// can send each frame to the anime recognizer. This keeps the server free-first.
app.post("/api/video-info",upload.single("video"),async(req,res)=>{
  if(!req.file)return res.status(400).json({error:"Choose a video."});
  const outDir=path.join("tmp",`frames-${Date.now()}`);
  fs.mkdirSync(outDir,{recursive:true});
  const pattern=path.join(outDir,"frame-%02d.jpg");
  const args=["-i",req.file.path,"-vf","fps=1/15,scale=960:-2","-frames:v","8","-q:v","4",pattern];
  const p=spawn("ffmpeg",args);
  let err="";
  p.stderr.on("data",d=>err+=d);
  p.on("close",code=>{
    const frames=fs.readdirSync(outDir).filter(x=>x.endsWith(".jpg")).sort().map(x=>`/tmpframes/${path.basename(outDir)}/${x}`);
    res.json({ok:code===0,frames,error:code===0?null:"FFmpeg is not installed or the video could not be read."});
    // keep frames briefly for the browser; cleanup after 10 minutes
    setTimeout(()=>{fs.rm(outDir,{recursive:true,force:true},()=>{});clean(req.file.path)},600000);
  });
});

app.use("/tmpframes",express.static("tmp"));

function validHttpUrl(value){
  try{const u=new URL(value); return u.protocol==='http:'||u.protocol==='https:' ? u.toString().replace(/\/$/,'') : null;}catch{return null;}
}

app.get("/api/domain-info",(req,res)=>{
  const host=String(req.get("host")||"");
  const proto=String(req.get("x-forwarded-proto")||req.protocol||"http").split(",")[0].trim();
  const current=validHttpUrl(process.env.PUBLIC_URL||`${proto}://${host}`)||`${proto}://${host}`;
  const primary=validHttpUrl(process.env.PRIMARY_URL||current)||current;
  const backups=String(process.env.BACKUP_URLS||"").split(",").map(x=>validHttpUrl(x.trim())).filter(Boolean).filter(x=>x!==current&&x!==primary);
  res.json({current,primary,backups,bookmarkable:true,configured:!!process.env.PRIMARY_URL||backups.length>0});
});

app.get("/api/health",(req,res)=>res.json({ok:true,tmdb:!!process.env.TMDB_API_KEY}));

app.listen(PORT,"0.0.0.0",()=>console.log(`MediaFreedom Search → http://mediafreedom.localhost:${PORT}`));
