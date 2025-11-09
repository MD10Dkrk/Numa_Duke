// ============================
// NeuroCare webclient / app.js (final)
// ============================

// Debug
window.__NC_VERBOSE = true;
const VERBOSE = () => window.__NC_VERBOSE === true;
const T = () => new Date().toISOString().split('T')[1].replace('Z','');
const log = {
  info:  (tag, ...a) => console.info(`[${T()}] ${tag}`, ...a),
  warn:  (tag, ...a) => console.warn(`[${T()}] ${tag}`, ...a),
  error: (tag, ...a) => console.error(`[${T()}] ${tag}`, ...a),
  debug: (tag, ...a) => { if (VERBOSE()) console.debug(`[${T()}] ${tag}`, ...a); },
  group: (name) => VERBOSE() && console.groupCollapsed(name),
  groupEnd: () => VERBOSE() && console.groupEnd()
};

// Endpoints
const PROSODY_WS  = "ws://localhost:8001/stream-prosody";
const FUSION_WS   = "ws://localhost:8003/mood";
const RESPOND_API = "http://localhost:8081/respond";
const NOTIFY_API  = "http://localhost:8081/notify";
const STT_API     = "http://localhost:8081/stt";

// Email mode
// "on_reply" → send email after agent replies
// "on_fusion" → legacy fusion-based email
// "off" → no emails
const EMAIL_MODE = "on_reply";

// UI
const $ = id => document.getElementById(id);
const startBtn = $("startBtn"), stopBtn = $("stopBtn");
const micBadge = $("micBadge"), prosodyBadge = $("prosodyBadge");
const fusionBadge = $("fusionBadge"), orchBadge = $("orchBadge");
const replyEl = $("replyBubble"), vu = $("vu"), agentSpeakEl = $("agentSpeaking");
const setBadge = (el, s)=>{ el.classList.remove("ok","warn","err"); if(s) el.classList.add(s); };

// State
let audioCtx, stream, srcNode, worklet, spNode, muteTap;
let prosodyWS, fusionWS;
let prosodyPingTimer = null, prosodyReconnectTimer = null, prosodyRetry = 0;
let fusionReconnectTimer = null, fusionRetry = 0;
let prosodyShouldRun = false, fusionShouldRun = false;
let speakingAgent = false;
let lastChunkTs = 0, silenceMs = 0;
let debounceUntil = 0;
let audioQueue = Promise.resolve();
let currentMood = { state: "unknown", confidence: 0 };
let serverProsody = null;
let utteranceStartTs = 0;
let rmsSum = 0, rmsCount = 0, rmsMax = 0;
const PCM_SR = 16000;
let pcmChunks = [];
let utterSeq = 0;
let lastHeard = "";
let lastNotifiedText = "";
let lastNotifyTs = 0;

// VAD params
const RMS_SPEECH = 0.010;
const MIN_SILENCE_MS = 1200;
const MIN_UTTER_MS   = 600;
const REPLY_DEBOUNCE_MS = 1500;
const SPEAK_TAIL_HOLD_MS = 700;
const MAX_UTTER_MS   = 9000;
const STALL_GAP_MS   = 1400;
let vadWatchTimer = null;

// VU
const ctx = vu.getContext("2d");
function drawVU(level){
  const w = vu.width = vu.clientWidth * devicePixelRatio;
  const h = vu.height = vu.clientHeight * devicePixelRatio;
  ctx.clearRect(0,0,w,h);
  ctx.fillStyle = "#2a9d8f";
  ctx.fillRect(0,0,Math.max(0, Math.min(1, level))*w,h);
}

function resetUtteranceStats(){
  rmsSum = 0; rmsCount = 0; rmsMax = 0; utteranceStartTs = 0; silenceMs = 0;
  pcmChunks = [];
}
function finalizeClientFeatures(durationMs){
  const avgRms = rmsCount ? (rmsSum / rmsCount) : 0;
  return { duration_ms: Math.round(durationMs), avg_rms: +avgRms.toFixed(4), max_rms: +rmsMax.toFixed(4) };
}

function pauseStreaming(){
  speakingAgent = true;
  agentSpeakEl.textContent = "Speaking";
  if (audioCtx && audioCtx.state === "running") audioCtx.suspend().catch(()=>{});
  resetUtteranceStats();
  log.info("[AUDIO] Mic suspended for TTS");
}
function resumeStreaming(){
  speakingAgent = false;
  agentSpeakEl.textContent = "No";
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume().catch(()=>{});
  log.info("[AUDIO] Mic resumed after TTS");
}

function moodFromSpeech(t){
  if (!t) return null;
  t = t.toLowerCase();
  if (/\b(nervous|anxious|scared|afraid|panick?ing|worried)\b/.test(t)) return { state: "anxious", confidence: 0.9 };
  if (/\b(confused|lost|disoriented|where am i)\b/.test(t)) return { state: "concerned", confidence: 0.75 };
  if (/\b(calm|okay|feeling fine|i'?m fine)\b/.test(t)) return { state: "calm", confidence: 0.7 };
  return null;
}

function encodeWav(int16, sampleRate){
  const n = int16.length, bps = 2, block = bps, rate = sampleRate * block;
  const buf = new ArrayBuffer(44 + n*bps), view = new DataView(buf);
  let p = 0; const wStr=s=>{for(let i=0;i<s.length;i++)view.setUint8(p++,s.charCodeAt(i));};
  const w32=v=>{view.setUint32(p,v,true);p+=4;}, w16=v=>{view.setUint16(p,v,true);p+=2;};
  wStr("RIFF"); w32(36 + n*bps); wStr("WAVE");
  wStr("fmt "); w32(16); w16(1); w16(1); w32(sampleRate); w32(rate); w16(block); w16(16);
  wStr("data"); w32(n*bps);
  new Int16Array(buf,44).set(int16);
  return new Blob([buf], {type:"audio/wav"});
}

async function transcribeBlob(wavBlob, meta){
  const fd = new FormData(); fd.append("audio", wavBlob, "utterance.wav");
  const t0 = performance.now();
  log.group(`[STT] #${meta.utterId} POST ${STT_API}`);
  const ab = await wavBlob.arrayBuffer(); log.info("[STT] payload", { size_bytes: ab.byteLength });
  try{
    const r = await fetch(STT_API, { method:"POST", body: fd });
    const t1 = performance.now(); log.info("[STT] HTTP", { status:r.status, duration_ms:Math.round(t1-t0) });
    if (!r.ok) throw new Error(`STT HTTP ${r.status}`);
    const j = await r.json(); const text = (j.text||"").trim();
    log.info("[STT] transcript", { text }); return text;
  }catch(e){ log.error("[STT] error", e); throw e; } finally { log.groupEnd(); }
}

// ---- finalize helper
function finalizeUtterance(reasonTag){
  const now = performance.now();
  if (!utteranceStartTs) { log.debug("[VAD] finalize ignored", { reason: reasonTag }); return; }
  const durationMs = now - utteranceStartTs;
  const features = finalizeClientFeatures(durationMs);
  const chunks = pcmChunks.slice(0);
  const sampleCount = chunks.reduce((a,c)=>a+c.length,0);
  log.group(`[VAD] finalize → ${reasonTag}`);
  log.info("[VAD] utterance", { duration_ms:Math.round(durationMs), rms_max:+rmsMax.toFixed(4), chunks:chunks.length, samples_16k:sampleCount });
  log.groupEnd();
  resetUtteranceStats();
  if (durationMs < MIN_UTTER_MS) { log.warn("[VAD] discard short", { duration_ms:Math.round(durationMs), reason:reasonTag }); return; }
  maybeTriggerTranscribeAndRespond(chunks, features);
}

// ---- audio frame handler
function handlePcmFrame(int16buf){
  if (speakingAgent) return;
  let sum = 0; for (let i=0;i<int16buf.length;i++){ const s = int16buf[i]/32768; sum += s*s; }
  const rms = Math.sqrt(sum / int16buf.length);
  rmsSum += rms; rmsCount += 1; if (rms > rmsMax) rmsMax = rms;
  drawVU(Math.min(1, rms*12));
  const now = performance.now(); const dt = now - (lastChunkTs || now); lastChunkTs = now;

  if (rms > RMS_SPEECH) {
    if (utteranceStartTs === 0) { utteranceStartTs = now; log.info("[VAD] speech start", { rms:+rms.toFixed(4) }); }
    pcmChunks.push(int16buf); silenceMs = 0;
  } else if (utteranceStartTs !== 0) {
    pcmChunks.push(int16buf); silenceMs += dt;
  }

  if (prosodyWS?.readyState === 1) prosodyWS.send(int16buf.buffer);
  if (utteranceStartTs !== 0 && silenceMs > MIN_SILENCE_MS) finalizeUtterance("silence");
}

// ---- audio init
async function startAudio(){
  audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
  await audioCtx.resume();
  try{
    stream = await navigator.mediaDevices.getUserMedia({ audio:{ echoCancellation:true, noiseSuppression:true, autoGainControl:true }, video:false });
    setBadge(micBadge,"ok"); log.info("[AUDIO] mic ready");
  }catch(e){
    setBadge(micBadge,"err"); log.error("[AUDIO] getUserMedia failed", e); alert("Mic permission denied or unavailable."); throw e;
  }
  srcNode = audioCtx.createMediaStreamSource(stream);

  try{
    await audioCtx.audioWorklet.addModule("./pcm-worklet.js");
    worklet = new AudioWorkletNode(audioCtx, "pcm-downsampler");
    const gain = audioCtx.createGain(); gain.gain.value = 0.0; muteTap = gain;
    srcNode.connect(worklet); worklet.connect(gain); gain.connect(audioCtx.destination);
    resetUtteranceStats();
    let gotFirst = false;
    const wd = setTimeout(()=>{ if(!gotFirst){ log.warn("[AUDIO] worklet no data; fallback"); fallbackToScriptProcessor(); } }, 1000);
    worklet.port.onmessage = (e)=>{ gotFirst = true; clearTimeout(wd); handlePcmFrame(new Int16Array(e.data)); };
    log.info("[AUDIO] AudioWorklet active"); return;
  }catch(e){ log.warn("[AUDIO] worklet load failed", e); }

  fallbackToScriptProcessor();
}
function fallbackToScriptProcessor(){
  try{
    const bufferSize = 2048;
    spNode = audioCtx.createScriptProcessor(bufferSize, 1, 1);
    const downRatio = audioCtx.sampleRate / PCM_SR;
    srcNode.connect(spNode);
    const gain = audioCtx.createGain(); gain.gain.value = 0.0; spNode.connect(gain); gain.connect(audioCtx.destination);
    resetUtteranceStats();
    spNode.onaudioprocess = (ev)=>{
      if (speakingAgent) return;
      const ch = ev.inputBuffer.getChannelData(0);
      const outLen = Math.floor(ch.length / downRatio);
      const out = new Int16Array(outLen);
      let o = 0; for (let i=0; i<ch.length; i+=downRatio){ const s = Math.max(-1, Math.min(1, ch[Math.floor(i)])); out[o++] = (s*32767)|0; }
      handlePcmFrame(out);
    };
    log.info("[AUDIO] ScriptProcessor active");
  }catch(e){
    setBadge(micBadge,"err"); log.error("[AUDIO] ScriptProcessor failed", e); alert("Audio pipeline could not start.");
  }
}

// ---- services
function startProsody(){
  if (!prosodyShouldRun) return;
  if (prosodyWS && prosodyWS.readyState === 1) return;
  log.info("[WS:PROSODY] opening", { url: PROSODY_WS });
  prosodyWS = new WebSocket(PROSODY_WS); prosodyWS.binaryType = "arraybuffer";

  prosodyWS.onopen = () => {
    setBadge(prosodyBadge,"ok"); prosodyRetry = 0; log.info("[WS:PROSODY] open");
    if (prosodyPingTimer) clearInterval(prosodyPingTimer);
    prosodyPingTimer = setInterval(()=>{ try{ if (prosodyWS?.readyState===1) prosodyWS.send("ping"); }catch{} }, 15000);
  };
  prosodyWS.onmessage = (ev)=>{
    if (typeof ev.data !== "string") return;
    try{
      const msg = JSON.parse(ev.data);
      if (msg.type === "prosody") {
        serverProsody = {
          avg_rms: Number(msg.rms ?? 0), f0_mean: Number(msg.f0_mean ?? 0),
          f0_std: Number(msg.f0_std ?? 0), zcr: Number(msg.zcr ?? 0), ts: msg.ts
        };
        log.debug("[WS:PROSODY] prosody", serverProsody);
      }
    }catch(e){ log.warn("[WS:PROSODY] parse error", e); }
  };
  prosodyWS.onclose = (e)=>{
    setBadge(prosodyBadge,"err"); if (prosodyPingTimer){ clearInterval(prosodyPingTimer); prosodyPingTimer=null; }
    log.warn("[WS:PROSODY] close", { code:e.code, reason:e.reason });
    if (prosodyShouldRun){
      const delay = Math.min(5000, 300 * Math.pow(2, ++prosodyRetry));
      log.info("[WS:PROSODY] reconnect in", { delay_ms: delay, retry: prosodyRetry });
      if (prosodyReconnectTimer) clearTimeout(prosodyReconnectTimer);
      prosodyReconnectTimer = setTimeout(()=>{ prosodyReconnectTimer=null; startProsody(); }, delay);
    }
  };
  prosodyWS.onerror = (e)=>{ log.warn("[WS:PROSODY] error", e); try{ prosodyWS.close(); }catch{} };
}
function stopProsody(){
  prosodyShouldRun=false;
  if (prosodyReconnectTimer){ clearTimeout(prosodyReconnectTimer); prosodyReconnectTimer=null; }
  if (prosodyPingTimer){ clearInterval(prosodyPingTimer); prosodyPingTimer=null; }
  if (prosodyWS){ try{ prosodyWS.onopen=prosodyWS.onmessage=prosodyWS.onclose=prosodyWS.onerror=null; prosodyWS.close(1000,"client stop"); }catch{} prosodyWS=null; }
  setBadge(prosodyBadge,""); log.info("[WS:PROSODY] stopped");
}

function startFusion(){
  if (!fusionShouldRun) return;
  if (fusionWS && fusionWS.readyState === 1) return;
  log.info("[WS:FUSION] opening", { url: FUSION_WS });
  fusionWS = new WebSocket(FUSION_WS);
  fusionWS.onopen = ()=>{ setBadge(fusionBadge,"ok"); fusionRetry=0; log.info("[WS:FUSION] open"); };
  fusionWS.onmessage = (ev)=>{
    try{
      const m = JSON.parse(ev.data);
      currentMood = { state: m.state ?? "unknown", confidence: Number(m.confidence ?? 0) };
      log.debug("[WS:FUSION] mood", currentMood);

      // legacy: only if explicitly enabled
      if (EMAIL_MODE === "on_fusion") {
        const now = Date.now();
        const shouldEmail = lastHeard && lastHeard !== lastNotifiedText && (now - lastNotifyTs > 8000);
        if (shouldEmail) {
          const speechMood = moodFromSpeech(lastHeard);
          const moodToSend = speechMood ? { state:speechMood.state, confidence:Math.max(currentMood.confidence||0, speechMood.confidence) } : currentMood;
          fetch(NOTIFY_API, {
            method:"POST", headers:{ "Content-Type":"application/json" },
            body: JSON.stringify({ trigger:"fusion", mood:moodToSend, transcript:lastHeard, source:"webclient", ts: Date.now() })
          }).catch(()=>{});
          lastNotifiedText = lastHeard; lastNotifyTs = now;
          log.info("[WS:FUSION] sent NOTIFY (fusion)", { mood:moodToSend });
        }
      }
    }catch(e){ log.warn("[WS:FUSION] parse error", e); }
  };
  fusionWS.onclose = (e)=>{
    setBadge(fusionBadge,"err"); log.warn("[WS:FUSION] close", { code:e.code, reason:e.reason });
    if (fusionShouldRun){
      const delay = Math.min(5000, 300 * Math.pow(2, ++fusionRetry));
      log.info("[WS:FUSION] reconnect in", { delay_ms: delay, retry: fusionRetry });
      if (fusionReconnectTimer) clearTimeout(fusionReconnectTimer);
      fusionReconnectTimer = setTimeout(()=>{ fusionReconnectTimer=null; startFusion(); }, delay);
    }
  };
  fusionWS.onerror = (e)=>{ log.warn("[WS:FUSION] error", e); try{ fusionWS.close(); }catch{} };
}
function stopFusion(){
  fusionShouldRun=false;
  if (fusionReconnectTimer){ clearTimeout(fusionReconnectTimer); fusionReconnectTimer=null; }
  if (fusionWS){ try{ fusionWS.onopen=fusionWS.onmessage=fusionWS.onclose=fusionWS.onerror=null; fusionWS.close(1000,"client stop"); }catch{} fusionWS=null; }
  setBadge(fusionBadge,""); log.info("[WS:FUSION] stopped");
}

// ---- respond flow
function maybeTriggerTranscribeAndRespond(chunks, clientProsodyFeatures){
  const now = performance.now();
  if (now < debounceUntil) { log.debug("[RESPOND] debounced", { until_ms:Math.round(debounceUntil-now) }); return; }
  debounceUntil = now + REPLY_DEBOUNCE_MS;
  transcribeAndRespond(chunks, clientProsodyFeatures);
}

async function transcribeAndRespond(chunks, clientProsodyFeatures){
  const utterId = ++utterSeq;
  const total = chunks.reduce((a,c)=>a+c.length,0);
  const buf = new Int16Array(total); let off=0; for (const c of chunks){ buf.set(c,off); off+=c.length; }
  const wav = encodeWav(buf, PCM_SR);

  try{
    log.group(`[FLOW] #${utterId} STT→RESPOND`);
    log.info("[FLOW] utter meta", { utterId, samples: total, bytes: total*2, clientProsodyFeatures });
    const text = await transcribeBlob(wav, { utterId }); lastHeard = text;
    if (!text) { log.warn("[FLOW] empty transcript; unlocking debounce"); debounceUntil = performance.now(); }
    await triggerRespond(clientProsodyFeatures, utterId);
  }catch(e){ log.error("[FLOW] stt/respond error", e); debounceUntil = performance.now(); } finally { log.groupEnd(); }
}

async function triggerRespond(clientProsodyFeatures, utterId){
  try{
    setBadge(orchBadge,"warn");
    const prosodyForLLM = serverProsody ? { ...clientProsodyFeatures,
      avg_rms: serverProsody.avg_rms ?? clientProsodyFeatures?.avg_rms,
      f0_mean: serverProsody.f0_mean, f0_std: serverProsody.f0_std, zcr: serverProsody.zcr, ts: serverProsody.ts
    } : clientProsodyFeatures;

    const speechMood = moodFromSpeech(lastHeard);
    const moodForLLM = speechMood
      ? ( currentMood ? { state:speechMood.state, confidence:Math.max(currentMood.confidence||0, speechMood.confidence) } : speechMood )
      : ( currentMood && currentMood.state !== "unknown" ? currentMood : { state:"calm", confidence:0 });

    const reqBody = { mood:moodForLLM, prosody:prosodyForLLM, transcript6s:lastHeard||"", patient:{ name:"Alex" } };

    log.group(`[RESPOND] #${utterId} POST ${RESPOND_API}`);
    log.info("[RESPOND] request", { transcript_len:(lastHeard||"").length, mood:moodForLLM, prosody_keys:Object.keys(prosodyForLLM||{}) });

    const t0 = performance.now();
    const res = await fetch(RESPOND_API, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(reqBody) });
    const t1 = performance.now(); log.info("[RESPOND] HTTP", { status: res.status, duration_ms: Math.round(t1-t0) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json(); setBadge(orchBadge,"ok");

    replyEl.textContent = data.text || "…";
    log.info("[RESPOND] response", { text_len:(data.text||"").length, audio_b64_len: data.audioBase64 ? data.audioBase64.length : 0, mime: data.mime || "audio/mpeg" });
    log.groupEnd();

    // ===== EMAIL ON REPLY =====
    if (EMAIL_MODE === "on_reply") {
      const finalMood = moodForLLM;
      const payload = {
        trigger: "agent_reply",
        transcript: lastHeard || "",
        replyText: data.text || "",
        mood: finalMood,
        source: "webclient",
        ts: Date.now()
      };
      fetch(NOTIFY_API, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(payload) })
        .then(()=> log.info("[NOTIFY] sent (agent_reply)", { transcript_len: payload.transcript.length, reply_len: payload.replyText.length }))
        .catch((e)=> log.warn("[NOTIFY] failed (agent_reply)", e));
    }
    // ==========================

    if (data.audioBase64 && data.audioBase64.length > 32) {
      audioQueue = audioQueue.then(()=> playAudioBase64(data.audioBase64, data.mime || "audio/mpeg", utterId))
                             .catch((e)=> log.error("[AUDIO] queue error", e));
    } else if (data.text) {
      log.warn("[AUDIO] no audioBase64; fallback TTS");
      audioQueue = audioQueue.then(()=> speakWithBrowserTTS(data.text, utterId))
                             .catch((e)=> log.error("[TTS] fallback error", e));
    } else {
      log.warn("[AUDIO] no text and no audioBase64 in /respond");
    }
  }catch(e){ setBadge(orchBadge,"err"); log.error("[RESPOND] error", e); }
}

// ---- audio playback helpers
async function ensureAudioContextRunning(){ if (!audioCtx) return; if (audioCtx.state!=="running"){ try{ await audioCtx.resume(); log.info("[AUDIO] AudioContext resumed"); }catch(e){ log.warn("[AUDIO] resume failed", e); } } }
async function playAudioBase64(b64, mime="audio/mpeg", utterId=null){
  await ensureAudioContextRunning(); pauseStreaming();
  log.group(`[AUDIO] play base64 ${mime} #${utterId ?? "?"}`);
  const bin = atob(b64), len = bin.length, bytes = new Uint8Array(len); for(let i=0;i<len;i++) bytes[i]=bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], {type:mime})); log.info("[AUDIO] buffer", { size_bytes: len });
  try{ await playWithHTMLAudio(url, utterId); log.info("[AUDIO] HTMLAudio success"); URL.revokeObjectURL(url); }
  catch(e){ log.warn("[AUDIO] HTMLAudio failed -> WebAudio", e); URL.revokeObjectURL(url);
    try{ await playWithWebAudio(bytes.buffer, mime, utterId); log.info("[AUDIO] WebAudio success"); }
    catch(e2){ log.error("[AUDIO] WebAudio decode failed; fallback TTS", e2); await speakWithBrowserTTS("I'm here with you.", utterId); }
  } finally { await new Promise(r=>setTimeout(r,SPEAK_TAIL_HOLD_MS)); resumeStreaming(); log.groupEnd(); }
}
function playWithHTMLAudio(url, utterId){
  return new Promise((resolve,reject)=>{
    const a = new Audio(); a.src=url; a.preload="auto"; const tag=`[AUDIO/HTML] #${utterId ?? "?"}`;
    const done=()=>{ cleanup(); resolve(); }, fail=(err)=>{ cleanup(); reject(err||new Error("audio play failed")); }, cleanup=()=>{ a.onended=a.onerror=a.onpause=null; };
    const wd=setTimeout(()=>{ try{a.pause();}catch{} log.warn(tag,"watchdog"); fail(new Error("watchdog")); }, 25000);
    a.onended=()=>{ clearTimeout(wd); log.info(tag,"ended"); done(); };
    a.onerror=e=>{ clearTimeout(wd); log.warn(tag,"error",e); fail(new Error("error")); };
    a.play().then(()=> log.debug(tag,"play() resolved")).catch(err=>{ clearTimeout(wd); log.warn(tag,"play() rejected",err); fail(err); });
  });
}
async function playWithWebAudio(arrayBuffer, mime, utterId){
  await ensureAudioContextRunning();
  const tag=`[AUDIO/WA] #${utterId ?? "?"}`, ab=arrayBuffer instanceof ArrayBuffer?arrayBuffer:arrayBuffer.buffer;
  const t0=performance.now(); const buf=await audioCtx.decodeAudioData(new Uint8Array(ab).buffer.slice(0)); const t1=performance.now();
  log.info(tag,"decoded",{ duration_ms:Math.round(t1-t0), channels:buf.numberOfChannels, length:buf.length, sampleRate:buf.sampleRate });
  const src=audioCtx.createBufferSource(); src.buffer=buf; src.connect(audioCtx.destination);
  await new Promise(res=>{ src.onended=()=>{ log.info(tag,"ended"); res(); }; try{ src.start(); }catch(e){ log.warn(tag,"start() failed",e); res(); } });
}
function speakWithBrowserTTS(text, utterId){
  return new Promise((resolve)=>{
    try{ const tag=`[TTS] #${utterId ?? "?"}`, u=new SpeechSynthesisUtterance(text); u.onend=()=>{ log.info(tag,"ended"); resolve(); };
      speechSynthesis.speak(u); log.info(tag,"speak()",{ text_len:(text||"").length });
    }catch(e){ log.warn("[TTS] speak failed", e); resolve(); }
  });
}

// ---- UI
startBtn.onclick = async ()=>{
  startBtn.disabled = true; stopBtn.disabled = false;
  try{
    log.info("[UI] Start clicked");
    await startAudio();
    if (vadWatchTimer) clearInterval(vadWatchTimer);
    vadWatchTimer = setInterval(()=>{
      const now = performance.now();
      if (!utteranceStartTs) return;
      const sinceLastFrame = now - lastChunkTs;
      const utterDur = now - utteranceStartTs;
      if (sinceLastFrame > STALL_GAP_MS) { log.warn("[VAD] stall watchdog finalize", { sinceLastFrame:Math.round(sinceLastFrame) }); finalizeUtterance("stall"); return; }
      if (utterDur > MAX_UTTER_MS) { log.warn("[VAD] max-utterance finalize", { utterDur:Math.round(utterDur) }); finalizeUtterance("max"); }
    }, 200);

    prosodyShouldRun = true; fusionShouldRun = true;
    startProsody(); startFusion();
  }catch(e){
    setBadge(micBadge,"err"); log.error("[UI] Mic init failed", e); startBtn.disabled=false; stopBtn.disabled=true;
  }
};

stopBtn.onclick = ()=>{
  log.info("[UI] Stop clicked");
  finalizeUtterance("stop");
  stopBtn.disabled = true; startBtn.disabled = false;
  try{ spNode && spNode.disconnect(); worklet?.disconnect(); muteTap?.disconnect(); srcNode?.disconnect(); }catch{}
  try{ stream?.getTracks().forEach(t=>t.stop()); }catch{}
  stopProsody(); stopFusion();
  if (vadWatchTimer) { clearInterval(vadWatchTimer); vadWatchTimer = null; }
  setBadge(micBadge,"warn"); setBadge(orchBadge,"");
};
