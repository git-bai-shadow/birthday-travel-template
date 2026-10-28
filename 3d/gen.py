# -*- coding: utf-8 -*-
"""包装器：import 技能模块直接调用，绕过 Windows 32K 命令行长度限制。

为什么不用 subprocess：
  参考图的 base64 有 2.6MB，Windows 的 CreateProcess 命令行上限 32K，
  无论用 shell 还是 subprocess 都会报 "文件名或扩展名太长"（WinError 206）。
  技能脚本没有"从文件读参数"的选项，所以只能同进程 import。

用法：
  python 3d/gen.py --token ck_t_xxx
  python 3d/gen.py --token ck_t_xxx --face-count 800000
"""
import argparse
import base64
import importlib.util
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKILL_PY = Path(r"D:\Program  Files\WorkBuddy\resources\app.asar.unpacked"
                r"\resources\plugins\workbuddy-builtin\skills"
                r"\buddy-multimodal-generation\scripts\buddy-multimodal-generation.py")
REF_IMG = ROOT / "code/assets/ChatGPT Image 2026年10月4日 22_01_34.png"
PROMPT_FILE = ROOT / "3d/cake_prompt.txt"
OUT = ROOT / "3d/out"


def load_skill():
    spec = importlib.util.spec_from_file_location("bmg", SKILL_PY)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["bmg"] = mod
    spec.loader.exec_module(mod)
    return mod


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--token", required=True)
    ap.add_argument("--face-count", type=int, default=500000)
    ap.add_argument("--model", default="3.1")
    ap.add_argument("--generate-type", default="Normal")
    ap.add_argument("--no-pbr", action="store_true")
    ap.add_argument("--result-format", default=None)
    ap.add_argument("--timeout", type=int, default=600)
    args = ap.parse_args()

    if not SKILL_PY.exists():
        print(f"[ERR] 找不到技能脚本：{SKILL_PY}", file=sys.stderr)
        return 2

    m = load_skill()
    prompt = PROMPT_FILE.read_text(encoding="utf-8").strip()
    b64 = base64.b64encode(REF_IMG.read_bytes()).decode("ascii")
    print(f"[INFO] 提示词 {len(prompt)} 字符，参考图 base64 {len(b64)} 字符", file=sys.stderr)

    # 接口限制：Prompt 与 ImageBase64 / ImageUrl 不能同时存在（二选一）。
    # 参考图已包含造型、材质与全部装饰信息，所以走纯图生 3D；
    # 提示词留作图上没画出来的部分（未点燃蜡烛等）在后处理里补。
    body = m._build_3d_body(
        prompt="",
        model=args.model,
        image_url=None,
        image_base64=b64,
        multi_view=None,
        enable_pbr=not args.no_pbr,
        face_count=args.face_count,
        generate_type=args.generate_type,
        polygon_type=None,
        result_format=args.result_format,
    )

    token = args.token
    m._ACTIVE_TOKEN = token
    cfg = m._PROVIDER_MAP["3d"]
    endpoint = m._resolve_default_endpoint()
    print(f"[INFO] endpoint = {endpoint}", file=sys.stderr)
    print("[INFO] 提交任务 …", file=sys.stderr)
    resp = m._call_api(endpoint, cfg["provider"], cfg["service"],
                       cfg["version"], cfg["submit_action"], body, token)
    job_id = resp.get("JobId") or resp.get("RequestId")
    print(f"[INFO] job_id = {job_id}", file=sys.stderr)
    (OUT).mkdir(parents=True, exist_ok=True)
    (OUT / "_job.txt").write_text(str(job_id), encoding="utf-8")

    result = m._poll_job(endpoint, cfg["provider"], cfg["service"], cfg["version"],
                         cfg["query_action"], job_id, token,
                         poll_interval=5, max_poll_time=args.timeout)
    (OUT / "_result.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(m._format_output(result, job_id=job_id),
                     ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
