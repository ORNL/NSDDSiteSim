#!/usr/bin/env python3
"""Generate the persisted RPM-only configuration used by the systemd installer."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPOSITORY_ROOT))

from models import RPMConfig  # noqa: E402


def build_config(count: int, base_port: int) -> dict[str, dict[str, object]]:
    if count < 1:
        raise ValueError("count must be at least 1")
    if not 1 <= base_port <= 65535:
        raise ValueError("base port must be between 1 and 65535")
    if base_port + count - 1 > 65535:
        raise ValueError("the requested RPM port range exceeds 65535")

    width = max(2, len(str(count)))
    result: dict[str, dict[str, object]] = {}
    for index in range(1, count + 1):
        suffix = f"{index:0{width}d}"
        config = RPMConfig(name=f"RPM {suffix}", port=base_port + index - 1)
        result[f"rpm-{suffix}"] = {
            "config": config.model_dump(mode="json"),
            "running": True,
        }
    return result


def write_config(output: Path, config: dict[str, dict[str, object]], replace: bool) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists() and not replace:
        raise FileExistsError(
            f"{output} already exists; pass --replace only after preserving the existing configuration"
        )

    temporary = output.with_name(f".{output.name}.tmp-{os.getpid()}")
    try:
        with temporary.open("x", encoding="utf-8") as stream:
            json.dump(config, stream, indent=4)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, output)
        directory_fd = os.open(output.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        temporary.unlink(missing_ok=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--count", type=int, default=50)
    parser.add_argument("--base-port", type=int, default=10001)
    parser.add_argument("--replace", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        config = build_config(args.count, args.base_port)
        write_config(args.output, config, args.replace)
    except (OSError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    print(
        f"Wrote {len(config)} running RPMs to {args.output} "
        f"on ports {args.base_port}-{args.base_port + args.count - 1}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
