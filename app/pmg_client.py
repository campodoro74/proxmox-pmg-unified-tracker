from __future__ import annotations

import asyncio
import time
from dataclasses import asdict, dataclass
from typing import Any

import httpx

from .config import PmgNode, REQUEST_TIMEOUT_SECONDS


@dataclass(frozen=True)
class NodeError:
    node: str
    error: str


class TtlCache:
    def __init__(self, ttl_seconds: int) -> None:
        self.ttl_seconds = ttl_seconds
        self._items: dict[str, tuple[float, Any]] = {}
        self._lock = asyncio.Lock()

    async def get(self, key: str) -> Any | None:
        async with self._lock:
            entry = self._items.get(key)
            if entry is None:
                return None
            expires_at, value = entry
            if expires_at < time.monotonic():
                self._items.pop(key, None)
                return None
            return value

    async def set(self, key: str, value: Any) -> None:
        async with self._lock:
            self._items[key] = (time.monotonic() + self.ttl_seconds, value)


class TicketCache:
    def __init__(self) -> None:
        self._items: dict[str, tuple[float, str]] = {}
        self._lock = asyncio.Lock()

    async def get(self, node_name: str) -> str | None:
        async with self._lock:
            entry = self._items.get(node_name)
            if not entry:
                return None
            expires_at, ticket = entry
            if expires_at < time.monotonic():
                self._items.pop(node_name, None)
                return None
            return ticket

    async def set(self, node_name: str, ticket: str, ttl_seconds: int) -> None:
        async with self._lock:
            self._items[node_name] = (time.monotonic() + ttl_seconds, ticket)


_ticket_cache = TicketCache()


def _headers(node: PmgNode) -> dict[str, str]:
    if node.token:
        return {"Authorization": f"PVEAPIToken={node.token}"}
    return {}


async def _get_ticket(node: PmgNode, client: httpx.AsyncClient) -> str:
    if not (node.username and node.password):
        raise RuntimeError(f"Node {node.name} has no username/password configured")

    cached = await _ticket_cache.get(node.name)
    if cached:
        return cached

    # PMG uses ticket auth with cookie PMGAuthCookie.
    # Endpoint schema is intentionally under-documented in the API viewer, but matches Proxmox semantics.
    resp = await client.post(
        "/api2/json/access/ticket",
        data={"username": node.username, "password": node.password},
    )
    resp.raise_for_status()
    payload = resp.json()
    data = payload.get("data") or {}
    ticket = data.get("ticket")
    if not ticket:
        raise RuntimeError("PMG did not return a ticket (check credentials/realm)")

    # Tickets are typically valid for ~2h; we cache a bit less.
    await _ticket_cache.set(node.name, ticket, ttl_seconds=60 * 60)
    return ticket


async def _get_json(node: PmgNode, path: str, params: dict[str, Any]) -> Any:
    async with httpx.AsyncClient(
        base_url=node.base_url,
        headers=_headers(node),
        timeout=REQUEST_TIMEOUT_SECONDS,
        verify=node.verify_tls,
    ) as client:
        cookies: dict[str, str] | None = None
        if not node.token:
            ticket = await _get_ticket(node, client)
            cookies = {"PMGAuthCookie": ticket}

        response = await client.get(path, params=params, cookies=cookies)
        response.raise_for_status()
        payload = response.json()
        return payload.get("data")


async def search_node(node: PmgNode, params: dict[str, Any]) -> tuple[list[dict[str, Any]], NodeError | None]:
    try:
        data = await _get_json(node, f"/api2/json/nodes/{node.name}/tracker", params)
        rows = []
        for row in data or []:
            normalized = dict(row)
            normalized["node"] = node.name
            normalized["status"] = delivery_status(row.get("dstatus"), row.get("rstatus"))
            rows.append(normalized)
        return rows, None
    except Exception as exc:
        return [], NodeError(node=node.name, error=str(exc))


async def search_all(nodes: list[PmgNode], params: dict[str, Any]) -> dict[str, Any]:
    results = await asyncio.gather(*(search_node(node, params) for node in nodes))
    rows: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []

    for node_rows, error in results:
        rows.extend(node_rows)
        if error is not None:
            errors.append(asdict(error))

    rows.sort(key=lambda row: int(row.get("time") or 0), reverse=True)
    return {"rows": rows, "errors": errors}


async def get_detail(node: PmgNode, mail_id: str, params: dict[str, Any]) -> dict[str, Any]:
    data = await _get_json(node, f"/api2/json/nodes/{node.name}/tracker/{mail_id}", params)
    if not data:
        raise httpx.HTTPStatusError(
            "PMG returned no detail data",
            request=httpx.Request("GET", node.base_url),
            response=httpx.Response(404),
        )
    detail = dict(data)
    detail["node"] = node.name
    detail["status"] = delivery_status(data.get("dstatus"), data.get("rstatus"))
    return detail


def delivery_status(dstatus: str | None, rstatus: str | None) -> str:
    status = (rstatus or dstatus or "").lower()
    if status == "a":
        return "accepted/delivered"
    if status == "b":
        return "blocked"
    if status == "n":
        # Seen in practice for RBL/spamhaus blocks (policy reject).
        return "blocked (rbl)"
    if status == "d":
        return "deferred"
    if status == "4":
        # Seen in practice for SMTP 4xx temporary failures (shown as "deferred" in logs).
        return "deferred"
    if status == "g":
        return "greylisted"
    if status == "2":
        # Seen in practice for messages relayed to an external server.
        return "relayed"
    if status == "5":
        # Seen in practice for invalid recipient / user unknown.
        return "recipient unknown"
    if status == "q":
        return "quarantined"
    if status == "r":
        return "rejected"
    return status or "unknown"
