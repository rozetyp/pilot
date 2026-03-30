"""
Pilot plugin for Browser Use — human rescue for AI browser agents.

Registers a `request_human_help` tool that the LLM agent calls when stuck.
Generates a rescue link, blocks until a human solves the problem via Pilot's
live browser stream, then returns control to the agent.

Usage (self-hosted, free):
    from browser_use import Agent, Browser
    from pilot_plugin import create_pilot_tools

    tools = create_pilot_tools()  # defaults to http://localhost:3001

    agent = Agent(
        task="Log into LinkedIn and find recent posts",
        llm=my_llm,
        browser=Browser(),
        tools=tools,
    )
    result = await agent.run()

Usage (hosted API):
    tools = create_pilot_tools(
        pilot_url="https://api.getpilot.dev",
        api_key="pk_live_...",
    )

When the agent hits a CAPTCHA, login wall, 2FA, or anything it can't handle,
it calls request_human_help. A rescue URL is generated. A human opens it,
solves the problem, clicks Done. The agent continues automatically.
"""

import asyncio
import logging
from typing import Optional

import httpx
from browser_use import ActionResult, BrowserSession, Tools

logger = logging.getLogger("pilot")


def create_pilot_tools(
    pilot_url: str = "http://localhost:3001",
    api_key: Optional[str] = None,
    timeout: int = 600,
    poll_interval: float = 1.0,
    on_rescue_url: Optional[callable] = None,
) -> Tools:
    """
    Create Browser Use tools that integrate with a Pilot server.

    Args:
        pilot_url: Base URL of the Pilot server.
                   Self-hosted: "http://localhost:3001" (default, free)
                   Hosted:      "https://api.getpilot.dev" (paid, public URLs + notifications)
        api_key:   API key for hosted Pilot. Not needed for self-hosted.
        timeout:   Max seconds to wait for human (default 600 = 10 min)
        poll_interval: Seconds between status polls (default 1.0)
        on_rescue_url: Optional callback(url, reason) for custom notifications.
                       Can be sync or async. Called with the rescue URL when generated.

    Returns:
        Tools instance to pass to Agent(tools=...)
    """
    tools = Tools()

    def _headers():
        h = {"Content-Type": "application/json"}
        if api_key:
            h["X-API-Key"] = api_key
        return h

    @tools.action(
        "Request human help when you are stuck. Use this when you encounter: "
        "CAPTCHAs, login forms requiring real credentials, two-factor authentication, "
        "unexpected modals or popups you cannot dismiss, cookie consent that blocks the page, "
        "or any situation where you have tried multiple approaches and cannot proceed. "
        "Describe clearly what you need the human to do."
    )
    async def request_human_help(
        reason: str,
        browser_session: BrowserSession,
    ) -> ActionResult:
        session_id = None

        try:
            cdp_url = _get_cdp_endpoint(browser_session)
            current_url = await browser_session.get_current_page_url()

            async with httpx.AsyncClient(timeout=30) as client:
                # 1. Create Pilot session
                create_body = {"context": reason}
                if cdp_url:
                    create_body["cdp_url"] = cdp_url
                    create_body["target_url"] = current_url
                else:
                    logger.warning("No CDP endpoint — Pilot will use a local browser (degraded mode)")
                    create_body["headless"] = True

                resp = await client.post(
                    f"{pilot_url}/sessions",
                    json=create_body,
                    headers=_headers(),
                )
                resp.raise_for_status()
                session_id = resp.json()["session_id"]

                # If no CDP, navigate Pilot's browser to the same URL
                if not cdp_url and current_url:
                    await client.post(
                        f"{pilot_url}/sessions/{session_id}/act",
                        json={"action": "navigate", "url": current_url},
                        headers=_headers(),
                    )

                # 2. Get rescue link
                resp = await client.post(
                    f"{pilot_url}/sessions/{session_id}/rescue",
                    json={"context": reason},
                    headers=_headers(),
                )
                resp.raise_for_status()
                data = resp.json()
                pilot_rescue_url = data["pilot_url"]
                rescue_token = data.get("token")

                print(f"\n  Pilot: agent needs help — \"{reason}\"")
                print(f"  {pilot_rescue_url}\n")

                # 3. Notify via callback
                if on_rescue_url:
                    try:
                        result = on_rescue_url(pilot_rescue_url, reason)
                        if asyncio.iscoroutine(result):
                            await result
                    except Exception:
                        pass

                # 4. Poll until human resolves or timeout
                deadline = asyncio.get_event_loop().time() + timeout
                consecutive_errors = 0

                while asyncio.get_event_loop().time() < deadline:
                    await asyncio.sleep(poll_interval)

                    try:
                        resp = await client.get(
                            f"{pilot_url}/sessions/{session_id}",
                            headers=_headers(),
                        )

                        if resp.status_code == 404:
                            return ActionResult(
                                extracted_content="Rescue session was lost. The Pilot server may have restarted.",
                                success=False,
                                include_in_memory=True,
                            )

                        status_data = resp.json()

                        if status_data["status"] == "RUNNING":
                            await _cleanup(client, pilot_url, session_id, _headers())
                            return ActionResult(
                                extracted_content=(
                                    f"Human resolved the issue: \"{reason}\". "
                                    f"The page may have changed. Take a screenshot to see "
                                    f"the current state and continue with your task."
                                ),
                                include_in_memory=True,
                            )

                        if status_data["status"] == "DEAD":
                            await _cleanup(client, pilot_url, session_id, _headers())
                            return ActionResult(
                                extracted_content="Browser connection was lost during human rescue.",
                                success=False,
                                include_in_memory=True,
                            )

                        consecutive_errors = 0

                    except httpx.RequestError:
                        consecutive_errors += 1
                        if consecutive_errors >= 10:
                            return ActionResult(
                                extracted_content="Lost connection to Pilot server.",
                                success=False,
                                include_in_memory=True,
                            )

                # Timeout
                await _cleanup(client, pilot_url, session_id, _headers())
                return ActionResult(
                    extracted_content=f"Timed out waiting for human help after {timeout}s.",
                    success=False,
                    include_in_memory=True,
                )

        except Exception as e:
            logger.error(f"Pilot rescue failed: {e}")
            if session_id:
                try:
                    async with httpx.AsyncClient(timeout=10) as client:
                        await _cleanup(client, pilot_url, session_id, _headers())
                except Exception:
                    pass
            return ActionResult(
                extracted_content=f"Failed to request human help: {str(e)}",
                success=False,
                include_in_memory=True,
            )

    return tools


def _get_cdp_endpoint(browser_session: BrowserSession) -> Optional[str]:
    """
    Extract the CDP WebSocket endpoint from a Browser Use BrowserSession.

    Browser Use wraps Playwright Chromium and exposes cdp_url as a property.
    Falls back to probing Playwright internals if that's not available.
    """
    try:
        # Path 1: Browser Use exposes cdp_url directly
        cdp = browser_session.cdp_url
        if cdp:
            return cdp
    except Exception:
        pass

    try:
        # Path 2: Playwright browser ws_endpoint
        page = browser_session.get_current_page()
        if page:
            browser = page.context.browser
            if browser:
                ws = getattr(browser, "ws_endpoint", None)
                if ws:
                    return ws
    except Exception as e:
        logger.debug(f"Could not extract CDP endpoint: {e}")

    return None


async def _cleanup(
    client: httpx.AsyncClient, pilot_url: str, session_id: str, headers: dict
):
    """Disconnect Pilot from the browser without closing it."""
    try:
        await client.delete(f"{pilot_url}/sessions/{session_id}", headers=headers)
    except Exception:
        pass
