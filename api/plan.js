// Vercel serverless function: POST /api/plan
// Keeps GEMINI_API_KEY on the server. No dependencies.

const TYPES = ["wedding", "birthday", "community"];
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const str = (v, max) => String(v ?? "").trim().slice(0, max);
const num = (v, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : null;
};

const SHAPE = `{
  "title": "short plan title",
  "summary": "2 sentence overview of the approach",
  "budget": {
    "currency": "ISO code, same as input",
    "total": number,
    "items": [{ "category": "string", "amount": number, "note": "one short line" }]
  },
  "timeline": [{ "when": "e.g. 8 weeks before", "tasks": ["short task"] }],
  "vendors": [{ "category": "string", "estimatedCost": number, "checklist": ["thing to confirm or book"] }],
  "ideas": {
    "theme": ["string"],
    "menu": ["string"],
    "activities": ["string"],
    "personalTouches": ["string"]
  }
}`;

function buildPrompt({ type, name, guests, budget, currency, date, city, vibe, daysLeft, previousPlan, tweak }) {
  const lines = [
    `Event type: ${type}`,
    name && `Occasion / who it's for: ${name}`,
    guests && `Guests: ${guests}`,
    budget && `Total budget: ${budget} ${currency}`,
    date && `Date: ${date}${daysLeft !== null ? ` (${daysLeft} days from today)` : ""}`,
    city && `City: ${city}`,
    vibe && `Vibe / preferences: ${vibe}`,
  ].filter(Boolean);

  let prompt = `Create a practical event plan.\n\n${lines.join("\n")}\n\n`;
  prompt += `Rules:
- Budget items must add up to at most the total budget. Use realistic local prices for the city, in ${currency}.
- Timeline phases must fit the time available${daysLeft !== null ? ` (${daysLeft} days)` : ""}. If there is little time, compress it and say what to do first.
- Include 4-6 timeline phases, 6-10 budget categories, 5-8 vendor categories with 3-5 checklist items each.
- Ideas must be specific to this event, city and vibe, not generic. 4-6 items per list.
- Keep every string short. No markdown.
- Return ONLY valid JSON matching this shape:\n${SHAPE}`;

  if (previousPlan && tweak) {
    prompt += `\n\nHere is the current plan:\n${JSON.stringify(previousPlan)}\n\nRevise it using this request: "${tweak}". Return the full updated plan in the same JSON shape.`;
  }
  return prompt;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: "Server is missing GEMINI_API_KEY." });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const type = str(body.type, 20).toLowerCase();
  if (!TYPES.includes(type)) return res.status(400).json({ error: "Pick wedding, birthday or community." });

  const date = str(body.date, 10);
  let daysLeft = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    daysLeft = Math.ceil((new Date(date).getTime() - Date.now()) / 864e5);
  }

  const inputs = {
    type,
    name: str(body.name, 80),
    guests: num(body.guests, 1, 5000),
    budget: num(body.budget, 0, 1e9),
    currency: str(body.currency, 3).toUpperCase() || "INR",
    date,
    city: str(body.city, 60),
    vibe: str(body.vibe, 400),
    daysLeft,
    previousPlan: body.previousPlan && typeof body.previousPlan === "object" ? body.previousPlan : null,
    tweak: str(body.tweak, 300),
  };

  const generationConfig = { responseMimeType: "application/json", temperature: 0.8 };
  if (MODEL.includes("2.5-flash")) generationConfig.thinkingConfig = { thinkingBudget: 0 };

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: "You are a warm, experienced event planner who gives concrete, budget-aware plans. You reply with JSON only." }],
          },
          contents: [{ role: "user", parts: [{ text: buildPrompt(inputs) }] }],
          generationConfig,
        }),
      }
    );

    const data = await r.json();
    if (!r.ok) {
      return res.status(502).json({ error: data?.error?.message || "Gemini request failed." });
    }

    const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
    const clean = text.replace(/```json|```/g, "").trim();

    let plan;
    try { plan = JSON.parse(clean); } catch { return res.status(502).json({ error: "Got a malformed plan. Try again." }); }

    return res.status(200).json({ plan });
  } catch (e) {
    return res.status(502).json({ error: "Could not reach Gemini. Try again." });
  }
};
