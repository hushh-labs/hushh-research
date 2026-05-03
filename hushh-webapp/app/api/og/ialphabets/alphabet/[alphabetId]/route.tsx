import { ImageResponse } from "next/og";
import { NextRequest } from "next/server";

import { getPythonApiUrl } from "@/app/api/_utils/backend";

export const runtime = "edge";

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const COLS = 6;

export async function GET(
  request: NextRequest,
  props: { params: Promise<{ alphabetId: string }> }
) {
  const { alphabetId } = await props.params;

  let picks: Record<string, { ticker: string; company_name?: string }> = {};

  try {
    const url = `${getPythonApiUrl()}/api/ialphabets/leagues/*/alphabet`;
    // For OG images we skip auth — read directly from snapshots or public data
    // This is a simplified version that renders placeholder data
  } catch {
    // fallback to empty
  }

  return new ImageResponse(
    (
      <div
        style={{
          width: "1200px",
          height: "630px",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(135deg, #0f172a 0%, #1e293b 100%)",
          fontFamily: "system-ui, sans-serif",
          color: "white",
          padding: "40px",
        }}
      >
        {/* Title */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            marginBottom: "30px",
            gap: "12px",
          }}
        >
          <div style={{ fontSize: "36px", fontWeight: "800" }}>iAlphabets</div>
          <div
            style={{
              fontSize: "14px",
              opacity: 0.6,
              background: "rgba(255,255,255,0.1)",
              padding: "4px 12px",
              borderRadius: "999px",
            }}
          >
            A-Z Stock Draft
          </div>
        </div>

        {/* Grid - 6 columns */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "8px",
            maxWidth: "720px",
            justifyContent: "center",
          }}
        >
          {LETTERS.map((letter) => {
            const pick = picks[letter];
            return (
              <div
                key={letter}
                style={{
                  width: "108px",
                  height: "72px",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: "12px",
                  border: pick
                    ? "2px solid rgba(99,102,241,0.6)"
                    : "2px dashed rgba(255,255,255,0.15)",
                  background: pick
                    ? "rgba(99,102,241,0.1)"
                    : "rgba(255,255,255,0.03)",
                }}
              >
                <div
                  style={{
                    fontSize: "18px",
                    fontWeight: "700",
                    color: pick ? "#818cf8" : "rgba(255,255,255,0.3)",
                  }}
                >
                  {letter}
                </div>
                {pick && (
                  <div
                    style={{
                      fontSize: "12px",
                      fontWeight: "600",
                      marginTop: "2px",
                      color: "white",
                    }}
                  >
                    {pick.ticker}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div
          style={{
            marginTop: "30px",
            fontSize: "14px",
            opacity: 0.4,
          }}
        >
          hushh.app/ialphabets
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
    }
  );
}
