// orchestrator/src/replyOrchestrator.js
import fetch from "node-fetch";
import OpenAI from "openai";
import { getContext } from "./context.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function composeMessage(state, reqCtx) {
  const appCtx = getContext();
  const transcript = (reqCtx?.transcript || "").trim();
  const mood = reqCtx?.mood || { state, confidence: 0 };
  const prosody = reqCtx?.prosody || null;

  // ——— deterministic orientation Qs ———
  const t = transcript.toLowerCase();
  const asksDay   = /\b(what|which)\s+day(\s+is\s+it)?(\s+today)?\b/.test(t);
  const asksDate  = /\b(what('?s)?\s+the\s+date|what\s+date\s+is\s+it)\b/.test(t);
  const asksTime  = /\b(what('?s)?\s+the\s+time|what\s+time\s+is\s+it)\b/.test(t);
  const asksWho   = /\b(who\s+are\s+you|what\s+are\s+you)\b/.test(t);
  const asksWhere = /\bwhere\s+am\s+i\b/.test(t);

  const reassure = (extra = "") => {
    const gentle =
      (mood.state === "anxious" || mood.state === "concerned")
        ? " You’re safe, and I’m here with you by voice. Let’s take one slow breath."
        : " You’re safe, and I’m here with you by voice.";
    return (extra ? ` ${extra}` : "") + gentle;
  };

  if (asksDay || asksDate || asksTime || asksWho || asksWhere) {
    const now = new Date();
    if (asksDay) {
      const dayStr = now.toLocaleDateString(undefined, { weekday: "long" });
      return `It’s ${dayStr}, Alex.${reassure()}`;
    }
    if (asksDate) {
      const dateStr = now.toLocaleDateString(undefined, { month: "long", day: "numeric" });
      return `It’s ${dateStr}.${reassure()}`;
    }
    if (asksTime) {
      const timeStr = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      return `It’s ${timeStr}.${reassure()}`;
    }
    if (asksWho)  return `I’m NeuroCare, your voice companion.${reassure()}`;
    if (asksWhere) return `You’re safe, Alex.${reassure("If you’d like, I can check your routine.")}`;
  }
  // ————————————————————————————————

  const caregiverLine = (() => {
    const cg = appCtx.caregiver || {};
    if (cg.status === "with_patient") return `${cg.name} is here with you.`;
    if (cg.status === "away_at_work")
      return cg.return_info ? `${cg.name} is at work and may be back ${cg.return_info}.`
                            : `${cg.name} is at work right now.`;
    if (cg.status === "unavailable")  return `${cg.name} is unavailable right now.`;
    return `${cg.name || "Your caregiver"} might not be reachable at the moment.`;
  })();

  const system = `
You are NeuroCare, a calm voice companion for people with Alzheimer’s and Parkinson’s.
Speak in 1–2 short sentences. Warm, steady, simple words. You are present only “by voice”.

DO
- Respond to what the user said.
- If anxious/tense, acknowledge and suggest ONE gentle step (e.g., slow breath).
- If confused, gently orient with a simple fact (who you are, safety, caregiver).
- If calm, suggest a familiar routine (favorite music, tea, short rest).

DON’T
- Don’t mention day/date/time unless the user asked (those are handled by code).
- No medical advice or promises. No speculation. No "we/together" unless literally true.

CONTEXT
- Patient: ${appCtx.patient?.name || "Alex"}
- Caregiver: ${caregiverLine}
- Mood: ${mood.state || "unknown"} (conf=${mood.confidence ?? "?"})
- Prosody: ${prosody ? `duration=${prosody.duration_ms ?? "?"}ms, avg_rms=${prosody.avg_rms ?? "?"}, max_rms=${prosody.max_rms ?? "?"}` : "n/a"}
- Transcript: "${transcript || "(empty)"}"
`;

  const userMsg = transcript || "Respond briefly and kindly based on the context above.";

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: system },
      { role: "user",   content: userMsg }
    ],
    max_tokens: 80,
    temperature: 0.25
  });

  return (resp.choices[0]?.message?.content || "").replace(/\s{2,}/g, " ").trim();
}

export async function ttsElevenLabs(text, voiceId, apiKey) {
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      voice_settings: { stability: 0.6, similarity_boost: 0.85, style: 0.4 },
      optimize_streaming_latency: 3
    })
  });
  if (!r.ok) throw new Error(`ElevenLabs TTS failed: ${r.status} ${await r.text()}`);
  return Buffer.from(await r.arrayBuffer());
}
