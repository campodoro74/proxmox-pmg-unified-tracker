from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Query, Request, status
from fastapi.responses import FileResponse, JSONResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from fastapi.staticfiles import StaticFiles

from .config import APP_PASSWORD, APP_USERNAME, CACHE_TTL_SECONDS, load_nodes
from .pmg_client import TtlCache, get_detail, search_all


app = FastAPI(title="Unified PMG Tracking Center")
security = HTTPBasic(auto_error=False)
nodes = load_nodes()
node_by_name = {node.name: node for node in nodes}
cache = TtlCache(CACHE_TTL_SECONDS)
static_dir = Path(__file__).resolve().parent.parent / "static"


def require_auth(credentials: Annotated[HTTPBasicCredentials | None, Depends(security)]) -> None:
    if not APP_USERNAME and not APP_PASSWORD:
        return

    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            headers={"WWW-Authenticate": "Basic"},
        )

    valid_username = secrets_equal(credentials.username, APP_USERNAME)
    valid_password = secrets_equal(credentials.password, APP_PASSWORD)
    if not (valid_username and valid_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            headers={"WWW-Authenticate": "Basic"},
        )


def secrets_equal(left: str, right: str) -> bool:
    return hashlib.sha256(left.encode()).digest() == hashlib.sha256(right.encode()).digest()


def query_params(
    starttime: int = Query(..., ge=0),
    endtime: int = Query(..., ge=1),
    from_: str | None = Query(None, alias="from"),
    target: str | None = None,
    xfilter: str | None = None,
    greylist: bool = False,
    ndr: bool = False,
    status: list[str] | None = Query(None),
    node: list[str] | None = Query(None),
    errors_only: bool = False,
    client: str | None = None,
    qid: str | None = None,
    msgid: str | None = None,
    min_size: int | None = Query(None, ge=0),
    max_size: int | None = Query(None, ge=0),
) -> dict[str, object]:
    if endtime <= starttime:
        raise HTTPException(status_code=400, detail="endtime must be after starttime")
    if min_size is not None and max_size is not None and max_size < min_size:
        raise HTTPException(status_code=400, detail="max_size must be >= min_size")

    params: dict[str, object] = {
        "starttime": starttime,
        "endtime": endtime,
        "greylist": int(greylist),
        "ndr": int(ndr),
    }
    if from_:
        params["from"] = from_
    if target:
        params["target"] = target
    if xfilter:
        params["xfilter"] = xfilter
    if status:
        params["status"] = status
    if node:
        params["node"] = node
    if errors_only:
        params["errors_only"] = True
    if client:
        params["client"] = client
    if qid:
        params["qid"] = qid
    if msgid:
        params["msgid"] = msgid
    if min_size is not None:
        params["min_size"] = min_size
    if max_size is not None:
        params["max_size"] = max_size
    return params


@app.get("/api/search")
async def search(
    _: Annotated[None, Depends(require_auth)],
    params: Annotated[dict[str, object], Depends(query_params)],
    limit: int = Query(500, ge=1, le=5000),
    offset: int = Query(0, ge=0),
) -> dict[str, object]:
    key = cache_key("search", params)
    cached = await cache.get(key)
    result = cached

    if result is None:
        pmg_params = dict(params)
        requested_statuses = pmg_params.pop("status", None)
        requested_nodes = pmg_params.pop("node", None)
        errors_only = bool(pmg_params.pop("errors_only", False))
        client_filter = str(pmg_params.pop("client", "") or "").strip().lower()
        qid_filter = str(pmg_params.pop("qid", "") or "").strip().lower()
        msgid_filter = str(pmg_params.pop("msgid", "") or "").strip().lower()
        min_size = pmg_params.pop("min_size", None)
        max_size = pmg_params.pop("max_size", None)

        result = await search_all(nodes, pmg_params)
        rows = result["rows"]

        if requested_nodes:
            wanted_nodes = {str(n).strip().lower() for n in requested_nodes if str(n).strip()}
            if wanted_nodes:
                rows = [row for row in rows if str(row.get("node") or "").lower() in wanted_nodes]

        if requested_statuses:
            wanted = {str(s).strip().lower() for s in requested_statuses if str(s).strip()}
            if wanted:
                rows = [row for row in rows if str(row.get("status") or "").lower() in wanted]

        if errors_only:
            ok_statuses = {"accepted/delivered", "relayed"}
            rows = [row for row in rows if str(row.get("status") or "").lower() not in ok_statuses]

        if client_filter:
            rows = [row for row in rows if client_filter in str(row.get("client") or "").lower()]
        if qid_filter:
            rows = [row for row in rows if qid_filter in str(row.get("qid") or "").lower()]
        if msgid_filter:
            rows = [row for row in rows if msgid_filter in str(row.get("msgid") or "").lower()]

        if min_size is not None:
            try:
                min_v = int(min_size)
                rows = [row for row in rows if int(row.get("size") or 0) >= min_v]
            except Exception:
                pass
        if max_size is not None:
            try:
                max_v = int(max_size)
                rows = [row for row in rows if int(row.get("size") or 0) <= max_v]
            except Exception:
                pass

        result = {"rows": rows, "errors": result["errors"]}
        await cache.set(key, result)

    rows = result["rows"]
    return {
        "rows": rows[offset : offset + limit],
        "total": len(rows),
        "offset": offset,
        "limit": limit,
        "errors": result["errors"],
        "nodes": [node.name for node in nodes],
    }


@app.get("/api/detail/{node_name}/{mail_id}")
async def detail(
    node_name: str,
    mail_id: str,
    _: Annotated[None, Depends(require_auth)],
    params: Annotated[dict[str, object], Depends(query_params)],
) -> dict[str, object]:
    node = node_by_name.get(node_name)
    if node is None:
        raise HTTPException(status_code=404, detail=f"Unknown PMG node: {node_name}")

    detail_params = {
        "starttime": params["starttime"],
        "endtime": params["endtime"],
    }
    key = cache_key("detail", {"node": node_name, "id": mail_id, **detail_params})
    cached = await cache.get(key)
    if cached is not None:
        return cached

    result = await get_detail(node, decode_mail_id(mail_id), detail_params)
    await cache.set(key, result)
    return result


@app.get("/api/health")
async def health(_: Annotated[None, Depends(require_auth)]) -> dict[str, object]:
    return {"ok": True, "nodes": [node.name for node in nodes]}


@app.get("/")
async def index(_: Annotated[None, Depends(require_auth)]) -> FileResponse:
    return FileResponse(static_dir / "index.html")


@app.exception_handler(Exception)
async def error_handler(_: Request, exc: Exception) -> JSONResponse:
    return JSONResponse(status_code=500, content={"detail": str(exc)})


def cache_key(prefix: str, payload: dict[str, object]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return f"{prefix}:{hashlib.sha256(encoded.encode()).hexdigest()}"


def decode_mail_id(value: str) -> str:
    # Accept either raw IDs or URL-safe base64 from the UI.
    try:
        normalized = value.replace("-", "+").replace("_", "/")
        normalized += "=" * ((4 - (len(normalized) % 4)) % 4)
        return base64.b64decode(normalized.encode()).decode()
    except Exception:
        return value


app.mount("/static", StaticFiles(directory=static_dir), name="static")
