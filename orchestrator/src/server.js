// orchestrator/src/server.js
// Final server: OpenAI STT (/stt), LLM reply (/respond), email alerts (/notify), context R/W

import "dotenv/config";
import express from "express";
import cors from "cors";
import nodemailer from "nodemailer";
import multer from "multer";
import OpenAI from "openai";
import { File as NodeFile } from "node:buffer";

import { composeMessage, ttsElevenLabs } from "./replyOrchestrator.js";
import { getContext, updateContext } from "./context.js";

const app = express();
const upload = multer();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- Middleware & health ----------
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.get("/", (_req, res) => res.type("text/plain").send("NeuroCare Orchestrator OK"));

// ---------- Context ----------
app.get("/context", (_req, res) => res.json(getContext()));
app.post("/context", (req, res) => res.json(updateContext(req.body || {})));

// ---------- OpenAI STT ----------
// Client posts multipart/form-data with field "audio" (wav/mp3/m4a…)
// Optional query: ?model=gpt-4o-mini-transcribe|whisper-1 (default: gpt-4o-mini-transcribe)
app.post("/stt", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "no audio file 'audio' provided" });

    const model = String(req.query.model || "gpt-4o-mini-transcribe");
    const file = new NodeFile([req.file.buffer], req.file.originalname || "utterance.wav", {
      type: req.file.mimetype || "audio/wav",
      lastModified: Date.now()
    });

    const tr = await openai.audio.transcriptions.create({ file, model });
    res.json({ text: (tr?.text || "").trim() });
  } catch (e) {
    console.error("[/stt] error:", e);
    res.status(500).json({ error: String(e?.message || e), text: "" });
  }
});

// ---------- Respond (LLM + optional TTS) ----------
// Body: { mood:{state,confidence}, prosody: {...}|null, transcript6s:"", patient:{name} }
app.post("/respond", async (req, res) => {
  try {
    const {
      mood = {},
      prosody = null,
      transcript6s = "",
      patient = {}
    } = req.body || {};

    const text = await composeMessage(mood?.state, {
      patientName: patient?.name || "Alex",
      transcript: transcript6s || "",
      mood,
      prosody
    });

    let audioBase64 = "";
    try {
      if (process.env.ELEVEN_API_KEY && process.env.ELEVEN_VOICE_ID) {
        const audioBuf = await ttsElevenLabs(
          text,
          process.env.ELEVEN_VOICE_ID,
          process.env.ELEVEN_API_KEY
        );
        if (audioBuf?.length) audioBase64 = audioBuf.toString("base64");
      }
    } catch (e) {
      console.warn("[/respond] TTS failed:", e?.message || e);
    }

    res.json({ text, audioBase64 });
  } catch (e) {
    console.error("[/respond] error:", e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// ---------- Email alerts (SMTP) ----------
let mailer = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  console.log("✅ SMTP mailer configured.");
} else {
  console.log("⚠️  SMTP not configured (set SMTP_HOST/USER/PASS in .env to enable /notify).");
}

// Body: { mood:{state,confidence}, transcript:"", source:"webclient" }
app.post("/notify", async (req, res) => {
  try {
    if (!mailer) return res.status(400).json({ error: "SMTP not configured" });

    const { mood = {}, transcript = "", source = "webclient" } = req.body || {};
    const to = process.env.ALERT_TO || process.env.SMTP_USER;
    const fromAddr = process.env.SMTP_FROM || process.env.SMTP_USER;

    await mailer.sendMail({
      from: `"NeuroCare" <${fromAddr}>`,
      to,
      subject: `NeuroCare alert: ${mood?.state ?? "unknown"} (conf ${mood?.confidence ?? "?"})`,
      text:
`Patient: ${getContext().patient?.name || "Alex"}
Mood: ${JSON.stringify(mood)}
Transcript: "${transcript || ""}"
Source: ${source}
Time: ${new Date().toString()}`
    });

    res.json({ ok: true });
  } catch (e) {
    console.error("[/notify] error:", e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// ---------- Start ----------
const PORT = Number(process.env.PORT || 8081);
app.listen(PORT, () => {
  console.log(`✅ Orchestrator running: http://localhost:${PORT}`);
  console.log("Routes:");
  console.log(" GET  /                (health)");
  console.log(" GET  /context         (read app context)");
  console.log(" POST /context         (update app context)");
  console.log(" POST /stt             (OpenAI transcription)");
  console.log(" POST /respond         (LLM + optional TTS)");
  console.log(" POST /notify          (email alert)");
});
