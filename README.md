# NUMA — AI Companion for Cognitive Disorders

## Problem
Individuals living with Alzheimer’s and Parkinson’s often struggle with memory lapses, confusion, and disrupted daily routines.  
Caregivers face the constant challenge of providing reminders, emotional reassurance, and medical consistency — often across long distances or busy schedules.  

Existing tools tend to be transactional (like reminder apps or health trackers) and lack the warmth, adaptability, and context awareness needed for cognitive care.

---

## Solution
We built NUMA, an AI-powered companion that combines emotional intelligence with everyday assistance.  
NUMA acts as a supportive presence for patients while keeping families informed through subtle behavioral insights.  

It is designed as a modular system composed of three specialized agents:

- **Memory Agent** – Detects repeating questions and tracks short-term memory decline patterns.  
- **Routine Agent** – Provides warm, human-sounding voice reminders for meals, medications, and appointments.  
- **Mood Agent** – Analyzes tone of voice to detect anxiety or confusion and triggers reassurance messages or caregiver notifications.  

Our current prototype demonstrates all three agents.  
The long-term vision is to integrate NUMA into wearables, enabling continuous, context-aware care throughout the day.

---

## Tech Stack

| Layer | Tools & Technologies |
|-------|----------------------|
| **AI Models** | OpenAI GPT, Whisper API, and ElevenLabs TTS for natural conversational tone, real-time transcription, and emotionally expressive voice generation. |
| **Automation & Logic** | n8n for orchestrating workflows between agents, scheduling reminders, handling emotion detection, and connecting APIs. |
| **Backend** | Node.js with Express.js for managing API routes (`/stt`, `/respond`, `/notify`), WebSocket servers for prosody and emotion analysis, and Nodemailer for caregiver notifications. |
| **Frontend** | Next.js 14 and HTML/CSS/JavaScript (deployed on Vercel) for the UI featuring a talking, glowing avatar with live audio playback and emotional feedback. |
| **Integrations** | Webhooks and WebSocket communication between front-end, backend, and agent layers for seamless, low-latency interaction. |
| **Voice Processing** | Prosody analysis and Fusion model for tone and mood detection, enabling emotionally adaptive responses. |

This multi-platform approach lets us experiment independently with each agent while maintaining an interconnected ecosystem.

---

## Live Demo Interface

Here’s the **NeuroCare — Live** dashboard used to test and visualize NUMA’s behavior:

![NUMA Project Screenshot](https://github.com/MD10Dkrk/Numa_Duke/blob/main/NUMA.png)

**Key Controls:**
- **Start / Stop:** Activates live microphone input and analysis.  
- **Mic / Prosody / Wearables / Orchestrator:** Toggles each agent component in real time.  
- **Input Level Monitor:** Displays live voice activity detection levels.  
- **Last Reply:** Shows the most recent AI response and emotional context.  

---

## Challenges
- Synchronizing voice output and UI animation timing between n8n and the front-end.  
- Managing CORS and MIME-type issues while streaming audio dynamically from n8n to the browser.  
- Crafting reminders that sound empathetic rather than robotic, striking the right emotional balance for cognitive users.  
- Integrating cross-platform data flows (speech, text, and emotion analysis) without latency.  

---

## Accomplishments
- Built and deployed three functional AI agents across different platforms in under 40 hours.  
- Designed a working front-end that plays live AI-generated audio reminders with synchronized visual feedback.  
- Successfully created a modular system architecture that could scale into a wearable device prototype.  
- Demonstrated how conversational AI and behavioral analysis can coexist in a single human-centered system.  

---

## What We Learned
- AI can bridge emotional gaps in healthcare if designed with empathy first — tone and pacing matter as much as accuracy.  
- Seamless cross-platform integration is more achievable through lightweight workflows and webhooks than large monolithic apps.  
- Prototyping fast with real data and human voices helps validate emotional resonance early, not just functionality.  
- Designing for cognitive users requires simplicity, consistency, and warmth — more conversation, less command.  

---

## In Essence
NUMA isn’t just a medical tool — it’s a companion.  
It represents a step toward emotionally intelligent AI that can support patients and caregivers alike through small, meaningful interactions.

---

## Project Summary
- **Hackathon:** Duke AI Hackathon 2025  
- **Category:** Health & Wellness  
- **Build Time:** 40 hours  
- **Team:** NeuroCare Project Team  
- **Deployed On:** Vercel + Local Node.js Environment  
