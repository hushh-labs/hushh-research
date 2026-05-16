import asyncio

from hushh_mcp.agents.kai.debate_engine import InvestmentDebateEngine


async def main():
    engine = InvestmentDebateEngine()
    result = await engine.start_debate("NVDA")
    import json
    print(json.dumps(result, indent=2))

if __name__ == "__main__":
    asyncio.run(main())
