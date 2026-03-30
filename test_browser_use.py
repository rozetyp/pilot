"""
Test: Pilot + Browser Use integration.

Runs a Browser Use agent that navigates to htsapi.dev, tries to classify
a product, hits the hCaptcha, and calls request_human_help.

Prerequisites:
    pip install browser-use httpx
    node proxy/pilot/server.js   # Pilot server running on :3001

    Set OPENAI_API_KEY or ANTHROPIC_API_KEY in your environment.

Run:
    python test_browser_use.py
"""

import asyncio
import os

from dotenv import load_dotenv
load_dotenv("/Users/antonzaytsev/Documents/trash-2/.env")

from browser_use import Agent, Browser
from browser_use.llm import ChatOpenAI
from browser_use_plugin import create_pilot_tools


async def main():
    # Self-hosted Pilot (free)
    tools = create_pilot_tools(pilot_url="http://localhost:3001")

    llm = ChatOpenAI(model="gpt-4o")
    browser = Browser()

    agent = Agent(
        task=(
            "Go to https://htsapi.dev and classify 'men cotton t-shirt' from China. "
            "Click the Classify button. An hCaptcha will appear. "
            "IMPORTANT: You CANNOT solve CAPTCHAs yourself. Do NOT attempt to click CAPTCHA checkboxes or solve image challenges. "
            "Instead, IMMEDIATELY use the request_human_help tool when you see any CAPTCHA. "
            "A human will solve it for you."
        ),
        llm=llm,
        browser=browser,
        tools=tools,
        max_failures=5,
    )

    print("Starting Browser Use agent with Pilot rescue...")
    print("If the agent hits a CAPTCHA, a rescue link will appear.")
    print("Open it in your browser, solve the CAPTCHA, click Done.\n")

    result = await agent.run(max_steps=20)

    print("\n=== Agent finished ===")
    print(f"Visited URLs: {result.visited_urls()}")
    print(f"Errors: {result.errors()}")
    print(f"Actions: {result.action_names()}")

    await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
