import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

export interface ArenaEvent {
  text: string;
  type: 'score' | 'win' | 'info' | 'battle' | 'streak';
  city: string;
}

export async function getCpaInsight(stats: { activeMatches: number, totalXpGiven: number, newPlayersToday: number }): Promise<string> {
  const prompt = `You are an AI analyst for a competitive "Hand Cricket" digital arena.
  Analyze the following real-time stats and generate ONE short, punchy, exciting sentence (max 12 words) summarizing the sentiment.
  Stats: ${stats.activeMatches} active matches, ${stats.totalXpGiven} XP distributed, ${stats.newPlayersToday} total accounts.
  Example styles: "The arena is smoking hot right now!", "Massive XP drops happening on the pitch!"`;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: prompt,
    });
    return response.text?.replace(/["\n]/g, '').trim() || "The arena is buzzing with energy!";
  } catch (error) {
    return "The community is grinding hard today!";
  }
}

export async function getArenaUpdate(): Promise<ArenaEvent> {
  const cities = ['Bengaluru', 'Chennai', 'Kolkata', 'Hyderabad', 'Mumbai', 'Delhi'];
  const city = cities[Math.floor(Math.random() * cities.length)];

  const prompt = `You are a sports commentator for a fast-paced "Hand Cricket" digital arena called hushh Arena.
  Generate one short, punchy live update (max 10 words) about a fictional player's action in ${city}.
  The action should be one of these types: [score, win, info, battle, streak].
  Return EXACTLY a JSON object in this format: {"text": "...", "type": "...", "city": "${city}"}.
  Examples:
  - {"text": "Mumbai Scout just hammered a massive 6!", "type": "score", "city": "Mumbai"}
  - {"text": "Hyderabad Pro enters a 5-win God Mode streak!", "type": "streak", "city": "Hyderabad"}
  - {"text": "A rookie in Delhi just stunned hushh bot!", "type": "battle", "city": "Delhi"}`;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: prompt,
    });

    const text = response.text || "";
    const jsonMatch = text.match(/\{.*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (error: any) {
    // Graceful fallback for 429 Resource Exhausted or other API errors
    console.warn("Gemini API unavailable, using local arena fallback:", error?.message);
  }

  const fallbackActions = [
    { text: `A scout in ${city} just pulled off a miracle 6!`, type: 'score' },
    { text: `${city} Elite just secured a dominant 5-match win streak!`, type: 'streak' },
    { text: `New Challenger in ${city} is climbing the ranks fast!`, type: 'info' },
    { text: `Epic showdown: ${city} Legend vs hushh bot!`, type: 'battle' },
    { text: `Stadium Roars! ${city} player wins a nail-biter!`, type: 'win' }
  ];

  const fallback = fallbackActions[Math.floor(Math.random() * fallbackActions.length)];
  return {
    ...fallback,
    city
  } as ArenaEvent;
}
