require("dotenv").config();
const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());

const LELAPA_TOKEN = process.env.LELAPA_TOKEN;
const VAPI_SECRET  = process.env.VAPI_SECRET;
const PORT         = process.env.PORT || 3000;

const LANG_CODES = {
  zulu:   "zul_Latn",
  xhosa:  "xho_Latn",
  tswana: "tsn_Latn",
};

// ── Translate via Lelapa AI ────────────────────────────────────────────────
async function translate(text, targetLang) {
  const res = await axios.post(
    "https://api.lelapa.ai/v1/translate/process",
    { input_text: text, source_lang: "eng_Latn", target_lang: targetLang },
    { headers: { "Content-Type": "application/json", "X-CLIENT-TOKEN": LELAPA_TOKEN } }
  );
  return res.data?.translation?.[0]?.translated_text || text;
}

// ── Build translated system prompt ────────────────────────────────────────
async function buildTranslatedSystemPrompt(langKey) {
  const langCode = LANG_CODES[langKey];
  if (!langCode) throw new Error(`Unsupported language: ${langKey}`);

  const lines = [
    "Hi, this is Cindy calling from Jem Mobile. I am calling regarding your mobile contract. Is this a good time to talk?",
    "Thank you. The reason for my call is to set up a payment arrangement on your account so we can keep your service active. We have a full settlement option or structured monthly payments. Would you like to hear the settlement amount or the installment options?",
    "The full settlement amount is {{fullSettlement}} Rand as a once off payment. That clears the account immediately. Would you like to proceed with that?",
    "We can spread the balance over time. Option one is 12 months at {{twelveMonths}} Rand per month with no data access. Option two is 24 months at {{twentyFourMonths}} Rand per month with no data access. There is also the option to continue your contract at {{continueWithData}} Rand per month with full services. Which option works best for you?",
    "I understand. We do need to put something in place to avoid suspension. Let us look at the lowest installment option. Would that help?",
    "I understand. Even selecting a structured option now helps protect your account. Would you like to hear the lowest monthly amount?",
    "I understand. We only attempt contact three times before the service is suspended. It may help to secure an option now. It will only take a minute. Settlement or installments?",
    "I can send the agreement once we confirm your preferred option. Which option would you like me to prepare?",
    "I understand. Please note the service will be suspended if no arrangement is selected. Our goal is to avoid that. Would you reconsider one of the options?",
    "Alright. Thank you for that. I have secured the {{chosenOption}} option for you. You will receive a WhatsApp within 48 hours with the agreement. Please sign it and accept the debit order mandate immediately to keep the service active.",
    "Thank you for your time.",
  ];

  const translated = await Promise.all(lines.map(l => translate(l, langCode)));

  return `
You are Cindy, a payment arrangement agent calling from Jem Mobile in South Africa.
You are calm, respectful, empathetic but firm.
You ask one question at a time and wait for a response before continuing.
You never threaten. You say "Rand" not "R". Maximum three contact attempts.
Acknowledge emotion first, then policy, then solution.
The customer speaks ${langKey}. Respond ONLY in ${langKey}.

Use these translated script lines as your guide:
${translated.map((t, i) => `${i + 1}. ${t}`).join("\n")}
`.trim();
}

// ── Health check ──────────────────────────────────────────────────────────
app.get("/", (_, res) => res.json({ status: "ok", service: "Jem Mobile Cindy Webhook" }));
app.get("/health", (_, res) => res.json({ status: "ok" }));

// ── Main Vapi webhook ─────────────────────────────────────────────────────
app.post("/vapi-tool", async (req, res) => {
  // Verify secret
  const secret = req.headers["x-vapi-secret"];
  if (VAPI_SECRET && secret !== VAPI_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { message } = req.body;

  // assistant-request: inject translated system prompt at call start
  if (message?.type === "assistant-request") {
    const language = message?.call?.metadata?.language || "english";

    if (language === "english" || !LANG_CODES[language]) {
      return res.json({}); // use default assistant config
    }

    try {
      const systemPrompt = await buildTranslatedSystemPrompt(language);
      return res.json({
        assistant: {
          model: {
            provider: "anthropic",
            model: "claude-sonnet-4-20250514",
            systemPrompt,
          },
          voice: {
            provider: "11labs",
            voiceId: process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM",
            model: "eleven_turbo_v2_5",
            stability: 0.5,
            similarityBoost: 0.75,
          },
        },
      });
    } catch (err) {
      console.error("assistant-request error:", err.message);
      return res.json({});
    }
  }

  // tool-calls: real-time translation mid-call
  if (message?.type === "tool-calls") {
    const results = [];

    for (const toolCall of message.toolCalls || []) {
      if (toolCall.function?.name === "translate_response") {
        const { text, language } = toolCall.function.arguments;
        const langCode = LANG_CODES[language?.toLowerCase()];

        if (!langCode) {
          results.push({ toolCallId: toolCall.id, result: text });
          continue;
        }

        try {
          const translated = await translate(text, langCode);
          results.push({ toolCallId: toolCall.id, result: translated });
        } catch (err) {
          console.error("Translation error:", err.message);
          results.push({ toolCallId: toolCall.id, result: text }); // fallback
        }
      }
    }

    return res.json({ results });
  }

  res.json({ received: true });
});

app.listen(PORT, () => {
  console.log(`✅ Cindy webhook server running on port ${PORT}`);
});
