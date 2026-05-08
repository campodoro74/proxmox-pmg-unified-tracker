from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class PmgNode:
    name: str
    base_url: str
    token: str | None
    username: str | None
    password: str | None
    verify_tls: bool


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def load_nodes() -> list[PmgNode]:
    nodes: list[PmgNode] = []
    raw_nodes = os.getenv("PMG_NODES", "")
    default_verify_tls = _env_bool("PMG_VERIFY_TLS", True)

    for node_name in [part.strip() for part in raw_nodes.split(",") if part.strip()]:
        key = node_name.upper().replace("-", "_")
        base_url = os.getenv(f"PMG_{key}_URL")
        token = os.getenv(f"PMG_{key}_TOKEN") or None
        username = os.getenv(f"PMG_{key}_USERNAME") or None
        password = os.getenv(f"PMG_{key}_PASSWORD") or None
        verify_tls = _env_bool(f"PMG_{key}_VERIFY_TLS", default_verify_tls)

        if not base_url:
            raise RuntimeError(
                f"Missing PMG_{key}_URL for node {node_name!r}"
            )

        if not token and not (username and password):
            raise RuntimeError(
                f"Missing credentials for node {node_name!r}: set PMG_{key}_TOKEN or PMG_{key}_USERNAME + PMG_{key}_PASSWORD"
            )

        nodes.append(
            PmgNode(
                name=node_name,
                base_url=base_url.rstrip("/"),
                token=token,
                username=username,
                password=password,
                verify_tls=verify_tls,
            )
        )

    if not nodes:
        raise RuntimeError("PMG_NODES must contain at least one PMG node name")

    return nodes


APP_USERNAME = os.getenv("APP_USERNAME", "")
APP_PASSWORD = os.getenv("APP_PASSWORD", "")
CACHE_TTL_SECONDS = int(os.getenv("CACHE_TTL_SECONDS", "10"))
REQUEST_TIMEOUT_SECONDS = float(os.getenv("REQUEST_TIMEOUT_SECONDS", "20"))
