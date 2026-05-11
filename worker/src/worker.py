import os
import json
import struct
import tempfile
import time
import redis
from storage import download_object, upload_object
from converter import preprocess_to_fly, convert_from_processed, convert_asset
from database import update_asset_status, update_asset_progress, update_preview_object, update_awaiting_crop, is_asset_deleted, update_texture_objects, update_quality_metrics, AssetDeletedException

REDIS_HOST = os.getenv("REDIS_HOST", "redis")
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))
QUEUE_NAME = "conversion"

# ZIP/영상 → 2단계 파이프라인 적용 대상 타입
TWO_STAGE_TYPES = {"gaussian", "nerf", "point_cloud", "mesh"}
TWO_STAGE_EXTS  = {".zip", ".mp4", ".mov", ".avi", ".mkv"}

MIME_MAP = {
    ".glb":   "model/gltf-binary",
    ".ply":   "application/octet-stream",
    ".obj":   "model/obj",
    ".splat": "application/octet-stream",
    ".zip":   "application/zip",
}

# GPU 학습이 필요한 타입
GPU_INTENSIVE_TYPES = {"gaussian", "nerf", "mesh"}

# 최소 GPU 요구 사양
MIN_COMPUTE_CAPABILITY = (7, 0)   # Volta 이상 (RTX 20xx, V100, ...)
MIN_VRAM_GB = 6.0


def get_redis():
    return redis.Redis(host=REDIS_HOST, port=REDIS_PORT, decode_responses=True)


class AwaitingCropException(Exception):
    """Stage 1 완료 후 사용자 영역 선택을 기다리는 경우 발생"""
    pass


class GpuRequiredException(Exception):
    """GPU 사양 미달로 처리 불가능한 경우 발생"""
    pass


def check_gpu_requirements(asset_type: str) -> tuple:
    """GPU 사양 확인. (ok: bool, message: str) 반환"""
    if asset_type not in GPU_INTENSIVE_TYPES:
        return True, ""

    try:
        import torch
    except ImportError:
        return False, (
            "PyTorch가 설치되어 있지 않습니다.\n"
            "Worker 환경을 확인해 주세요."
        )

    if not torch.cuda.is_available():
        return False, (
            "NVIDIA GPU를 감지할 수 없습니다.\n\n"
            "[최소 요구 사양]\n"
            f"• NVIDIA GPU (Compute Capability {MIN_COMPUTE_CAPABILITY[0]}.{MIN_COMPUTE_CAPABILITY[1]} 이상)\n"
            f"• VRAM {MIN_VRAM_GB:.0f}GB 이상\n"
            "• CUDA 11.8 이상"
        )

    try:
        props = torch.cuda.get_device_properties(0)
        cc = (props.major, props.minor)
        vram_gb = props.total_memory / (1024 ** 3)
        gpu_name = props.name

        issues = []
        if cc < MIN_COMPUTE_CAPABILITY:
            issues.append(
                f"• 연산 능력(Compute Capability): {cc[0]}.{cc[1]} "
                f"(최소 {MIN_COMPUTE_CAPABILITY[0]}.{MIN_COMPUTE_CAPABILITY[1]} 이상 필요)"
            )
        if vram_gb < MIN_VRAM_GB:
            issues.append(f"• VRAM: {vram_gb:.1f}GB (최소 {MIN_VRAM_GB:.0f}GB 이상 필요)")

        if issues:
            msg = (
                f"현재 GPU가 이 변환 작업을 지원하지 않습니다.\n\n"
                f"[현재 GPU 사양]\n"
                f"• 모델: {gpu_name}\n"
                f"• 연산 능력(Compute Capability): {cc[0]}.{cc[1]}\n"
                f"• VRAM: {vram_gb:.1f}GB\n\n"
                f"[미달 항목]\n" + "\n".join(issues) + "\n\n"
                f"[최소 요구 사양]\n"
                f"• NVIDIA GPU (Compute Capability {MIN_COMPUTE_CAPABILITY[0]}.{MIN_COMPUTE_CAPABILITY[1]} 이상)\n"
                f"• VRAM {MIN_VRAM_GB:.0f}GB 이상\n"
                "• CUDA 11.8 이상"
            )
            return False, msg

        return True, ""

    except Exception as e:
        return False, (
            f"GPU 정보 확인 중 오류가 발생했습니다: {e}\n"
            "NVIDIA GPU 및 CUDA 환경을 확인해 주세요."
        )


PLY_SCALAR_FORMATS = {
    "char": ("<b", 1),
    "int8": ("<b", 1),
    "uchar": ("<B", 1),
    "uint8": ("<B", 1),
    "short": ("<h", 2),
    "int16": ("<h", 2),
    "ushort": ("<H", 2),
    "uint16": ("<H", 2),
    "int": ("<i", 4),
    "int32": ("<i", 4),
    "uint": ("<I", 4),
    "uint32": ("<I", 4),
    "float": ("<f", 4),
    "float32": ("<f", 4),
    "double": ("<d", 8),
    "float64": ("<d", 8),
}


def _compute_ply_preview_stats(ply_path: str):
    """편집기 centered 좌표계의 기준이 되는 preview 중심을 계산한다."""
    try:
        with open(ply_path, "rb") as f:
            header_bytes = bytearray()
            while True:
                line = f.readline()
                if not line:
                    return None
                header_bytes.extend(line)
                if line.strip() == b"end_header":
                    break

            header_lines = header_bytes.decode("utf-8", errors="ignore").splitlines()
            fmt = None
            vertex_count = 0
            in_vertex = False
            props = []

            for line in header_lines:
                t = line.strip()
                if t.startswith("format "):
                    parts = t.split()
                    fmt = parts[1] if len(parts) > 1 else None
                elif t.startswith("element "):
                    parts = t.split()
                    in_vertex = len(parts) >= 3 and parts[1] == "vertex"
                    if in_vertex:
                        vertex_count = int(parts[2])
                elif in_vertex and t.startswith("property "):
                    parts = t.split()
                    if len(parts) < 3 or parts[1] == "list":
                        continue
                    prop_type, prop_name = parts[1], parts[2]
                    if prop_type not in PLY_SCALAR_FORMATS:
                        raise ValueError(f"Unsupported PLY property type: {prop_type}")
                    props.append((prop_name, prop_type))

            if fmt is None or vertex_count <= 0:
                return None

            prop_names = [name for name, _ in props]
            if not all(axis in prop_names for axis in ("x", "y", "z")):
                return None

            min_x = min_y = min_z = float("inf")
            max_x = max_y = max_z = float("-inf")

            if fmt == "binary_little_endian":
                import numpy as _np
                offsets = {}
                row_size = 0
                for name, prop_type in props:
                    offsets[name] = (row_size, prop_type)
                    row_size += PLY_SCALAR_FORMATS[prop_type][1]

                # numpy 벡터화: 전체 바이너리 블록을 한 번에 읽어 처리
                raw = f.read(vertex_count * row_size)
                if len(raw) < vertex_count * row_size:
                    return None
                buf = _np.frombuffer(raw, dtype=_np.uint8).reshape(vertex_count, row_size)
                for axis in ("x", "y", "z"):
                    off, ptype = offsets[axis]
                    fmt_str, nbytes = PLY_SCALAR_FORMATS[ptype]
                    col = buf[:, off:off + nbytes].copy()
                    vals = _np.frombuffer(col.tobytes(), dtype=_np.dtype(fmt_str.lstrip("<>")))
                    if axis == "x":
                        min_x, max_x = float(vals.min()), float(vals.max())
                    elif axis == "y":
                        min_y, max_y = float(vals.min()), float(vals.max())
                    else:
                        min_z, max_z = float(vals.min()), float(vals.max())
            elif fmt == "ascii":
                import numpy as _np
                xi = prop_names.index("x")
                yi = prop_names.index("y")
                zi = prop_names.index("z")
                rows = []
                for _ in range(vertex_count):
                    line = f.readline()
                    if not line:
                        break
                    parts = line.decode("utf-8", errors="ignore").strip().split()
                    if len(parts) > max(xi, yi, zi):
                        rows.append((float(parts[xi]), float(parts[yi]), float(parts[zi])))
                if not rows:
                    return None
                arr = _np.array(rows, dtype=_np.float32)
                min_x, min_y, min_z = arr.min(axis=0).tolist()
                max_x, max_y, max_z = arr.max(axis=0).tolist()
            else:
                return None

            if min_x == float("inf"):
                return None

            return {
                "center": [
                    float((min_x + max_x) / 2.0),
                    float((min_y + max_y) / 2.0),
                    float((min_z + max_z) / 2.0),
                ],
                "bounds": [
                    float(max_x - min_x),
                    float(max_y - min_y),
                    float(max_z - min_z),
                ],
            }
    except Exception as e:
        print(f"[Worker][Stage1] preview center 계산 실패: {e}")
        return None


def process_job(job_id: str, data: dict) -> str:
    asset_id   = data.get("assetId")
    asset_type = data.get("assetType")
    source_obj = data.get("sourceObject")

    print(f"[Worker] Processing job {job_id} — asset: {asset_id}, type: {asset_type}")

    def on_progress(pct: int):
        update_asset_progress(asset_id, pct)
        print(f"[Worker] Job {job_id} progress: {pct}%")

    def stop_check() -> bool:
        return is_asset_deleted(asset_id)

    # ── 미리보기 재생성 job: status 변경 없이 바로 처리 ─────────────
    if data.get("stage") == "regenerate_preview":
        with tempfile.TemporaryDirectory() as tmpdir:
            _run_regenerate_preview(asset_id, data, tmpdir)
        print(f"[Worker] Job {job_id} regenerate_preview done")
        return data.get("outputObject", "")

    update_asset_status(asset_id, "processing", progress=0)

    with tempfile.TemporaryDirectory() as tmpdir:

        metrics: dict = {}

        # ── Stage2 전용 job (colmapObject 다운로드 → 풀 트레이닝) ─
        if data.get("stage") == "stage2":
            on_progress(55)
            output_object = _run_stage2(asset_id, asset_type, data, tmpdir, on_progress, stop_check=stop_check, metrics_out=metrics)
        else:
            # ── 원본 파일 다운로드 ──────────────────────────────────
            ext = os.path.splitext(source_obj)[-1].lower()
            input_path = os.path.join(tmpdir, f"input{ext}")
            on_progress(5)
            download_object(source_obj, input_path)
            on_progress(10)

            # ── 2단계 파이프라인 (gaussian/nerf/mesh/point_cloud + ZIP/영상) ─
            if asset_type in TWO_STAGE_TYPES and ext in TWO_STAGE_EXTS:
                gpu_ok, gpu_msg = check_gpu_requirements(asset_type)
                if not gpu_ok:
                    update_asset_status(asset_id, "gpu_required", error_message=gpu_msg)
                    raise GpuRequiredException(gpu_msg)
                output_object = _run_two_stage(
                    asset_id, asset_type, input_path, tmpdir, on_progress, stop_check=stop_check, metrics_out=metrics,
                )
            else:
                # ── 단일 단계 (직접 파일 변환) ─────────────────────
                output_dir  = os.path.join(tmpdir, "output")
                output_path = convert_asset(asset_type, input_path, output_dir, on_progress)
                output_object = _upload_output(asset_id, output_path)
                # CAD ZIP 결과인 경우 GLB를 previewObject로 업로드
                if output_path.endswith(".zip"):
                    _upload_glb_preview_from_zip(asset_id, output_path, tmpdir)
                if asset_type == "mesh" and output_path.endswith(".zip"):
                    tex = _upload_textures_from_zip(asset_id, output_path, tmpdir)
                    if tex:
                        update_texture_objects(asset_id, tex)

    update_asset_status(asset_id, "done", output_object=output_object)
    if metrics:
        update_quality_metrics(asset_id, metrics)
        print(f"[Worker] Job {job_id} quality metrics saved: {metrics}")
    print(f"[Worker] Job {job_id} done — output: {output_object}")
    return output_object


def _run_two_stage(asset_id: str, asset_type: str, input_path: str, tmpdir: str, on_progress, stop_check=None, metrics_out: dict | None = None) -> str:
    """
    1단계: COLMAP + 빠른 splatfacto → fly PLY → previewObject
    2단계: COLMAP 결과 재사용 → 풀 트레이닝 → outputObject
    mesh 타입은 1단계 후 AwaitingCropException 발생 → 사용자가 영역 지정 후 stage2 job으로 재개
    """
    # ── 1단계 ────────────────────────────────────────────────────
    print(f"[Worker][Stage1] 전처리 + fly file 생성 시작")
    fly_path, processed_dir = preprocess_to_fly(input_path, tmpdir, on_progress, stop_check=stop_check)

    if fly_path and os.path.exists(fly_path):
        preview_object = f"previews/{asset_id}/fly.ply"
        upload_object(fly_path, preview_object, "application/octet-stream")
        update_preview_object(asset_id, preview_object)
        print(f"[Worker][Stage1] fly file 업로드 완료 → {preview_object}")
    else:
        print(f"[Worker][Stage1] fly file 생성 실패 — 2단계 계속 진행")

    on_progress(55)

    # ── mesh 타입: COLMAP 결과를 MinIO에 보존 후 사용자 영역 선택 대기 ──
    if asset_type in {"mesh", "gaussian"}:
        if not (processed_dir and os.path.isdir(processed_dir)):
            raise RuntimeError(
                "COLMAP 전처리 실패로 메시 변환을 완료할 수 없습니다. "
                "COLMAP 및 nerfstudio 설치 상태와 GPU 환경을 확인하세요."
            )
        print(f"[Worker][Stage1] COLMAP 결과 tarball 업로드 중...")
        tar_path = _tar_directory(processed_dir, tmpdir, "colmap.tar.gz")
        colmap_object = f"colmap/{asset_id}/processed.tar"
        preview_stats = _compute_ply_preview_stats(fly_path) if fly_path and os.path.exists(fly_path) else None
        preview_center = preview_stats["center"] if preview_stats else None
        preview_bounds = preview_stats["bounds"] if preview_stats else None
        upload_object(tar_path, colmap_object, "application/x-tar")
        update_awaiting_crop(asset_id, colmap_object, preview_center, preview_bounds)
        print(f"[Worker][Stage1] COLMAP tarball 업로드 완료 → {colmap_object}")
        raise AwaitingCropException(f"Asset {asset_id}: 영역 선택 대기 중")

    # ── 2단계 ────────────────────────────────────────────────────
    if processed_dir and os.path.isdir(processed_dir):
        print(f"[Worker][Stage2] COLMAP 결과 재사용 → 풀 트레이닝")
        output_dir  = os.path.join(tmpdir, "output")
        output_path = convert_from_processed(asset_type, processed_dir, output_dir, on_progress, stop_check=stop_check, metrics_out=metrics_out)
    else:
        raise RuntimeError(
            f"COLMAP 전처리 실패로 '{asset_type}' 변환을 완료할 수 없습니다. "
            "COLMAP 및 nerfstudio 설치 상태와 GPU 환경을 확인하세요."
        )

    return _upload_output(asset_id, output_path)


def _run_stage2(asset_id: str, asset_type: str, data: dict, tmpdir: str, on_progress, stop_check=None, metrics_out: dict | None = None) -> str:
    """사용자 영역 선택 후 Stage 2 재개 (COLMAP tarball 다운로드 → 풀 트레이닝)"""
    import tarfile as tarfile_mod

    colmap_object = data.get("colmapObject")
    obb_params    = data.get("obbParams")  # {center, rotation, scale} or None

    print(f"[Worker][Stage2] COLMAP tarball 다운로드: {colmap_object}")
    tar_ext = ".tar" if (colmap_object or "").endswith(".tar") else ".tar.gz"
    tar_path = os.path.join(tmpdir, f"colmap{tar_ext}")
    download_object(colmap_object, tar_path)

    print(f"[Worker][Stage2] tarball 압축 해제 중...")
    with tarfile_mod.open(tar_path, "r:*") as tar:
        tar.extractall(tmpdir)

    # tar 내 최상위 디렉터리 탐색 ("processed" 또는 디렉터리명)
    processed_dir = os.path.join(tmpdir, "processed")
    if not os.path.isdir(processed_dir):
        # 압축 해제된 첫 번째 디렉터리 사용
        entries = [e for e in os.listdir(tmpdir) if os.path.isdir(os.path.join(tmpdir, e)) and e != "__MACOSX"]
        if entries:
            processed_dir = os.path.join(tmpdir, entries[0])

    if not os.path.isdir(processed_dir):
        raise RuntimeError("COLMAP tarball 압축 해제 후 processed 디렉터리를 찾을 수 없습니다")

    on_progress(60)
    print(f"[Worker][Stage2] 풀 트레이닝 시작 (processed_dir={processed_dir}, obb={obb_params})")

    output_dir  = os.path.join(tmpdir, "output")
    output_path = convert_from_processed(asset_type, processed_dir, output_dir, on_progress, obb_params=obb_params, stop_check=stop_check, metrics_out=metrics_out)

    output_object = _upload_output(asset_id, output_path)

    # mesh ZIP 결과인 경우에만 GLB 미리보기 생성 → previewObject 갱신
    # nerf ZIP은 MP4+PNG 구성이므로 GLB 변환 불필요
    if output_path.endswith(".zip") and asset_type != "nerf":
        _upload_glb_preview_from_zip(asset_id, output_path, tmpdir)
    if asset_type == "mesh" and output_path.endswith(".zip"):
        tex = _upload_textures_from_zip(asset_id, output_path, tmpdir)
        if tex:
            update_texture_objects(asset_id, tex)

    return output_object


def _run_regenerate_preview(asset_id: str, data: dict, tmpdir: str):
    """기존 ZIP outputObject에서 GLB 미리보기를 재생성하여 previewObject 갱신"""
    import zipfile
    import glob as glob_module

    output_object = data.get("outputObject", "")
    if not output_object.endswith(".zip"):
        print(f"[Worker][RegenPreview] ZIP이 아닌 파일 — 건너뜀: {output_object}")
        return

    print(f"[Worker][RegenPreview] ZIP 다운로드: {output_object}")
    zip_path = os.path.join(tmpdir, "output.zip")
    download_object(output_object, zip_path)
    _upload_glb_preview_from_zip(asset_id, zip_path, tmpdir)


def _upload_textures_from_zip(asset_id: str, zip_path: str, tmpdir: str) -> list:
    """ZIP 안의 텍스쳐 이미지를 MinIO에 업로드하고 경로 리스트 반환"""
    import zipfile as zipfile_mod
    IMAGE_EXTS = {'.png', '.jpg', '.jpeg', '.webp'}
    texture_objects = []
    try:
        tex_dir = os.path.join(tmpdir, "textures_extract")
        os.makedirs(tex_dir, exist_ok=True)
        with zipfile_mod.ZipFile(zip_path, 'r') as zf:
            image_members = [m for m in zf.namelist()
                             if os.path.splitext(m)[-1].lower() in IMAGE_EXTS
                             and not m.startswith('__MACOSX')]
            for i, member in enumerate(image_members):
                ext = os.path.splitext(member)[-1].lower()
                extracted_path = os.path.join(tex_dir, f"texture_{i}{ext}")
                with zf.open(member) as src, open(extracted_path, 'wb') as dst:
                    dst.write(src.read())
                object_name = f"textures/{asset_id}/texture_{i}{ext}"
                mime = "image/png" if ext == ".png" else "image/jpeg"
                upload_object(extracted_path, object_name, mime)
                texture_objects.append(object_name)
        if texture_objects:
            print(f"[Worker] 텍스쳐 {len(texture_objects)}개 업로드 완료")
    except Exception as e:
        print(f"[Worker] 텍스쳐 추출 실패 (무시): {e}")
    return texture_objects


def _tar_directory(src_dir: str, tmpdir: str, tar_name: str) -> str:
    """디렉터리를 tar로 압축 (gz 생략 — MinIO 임시 저장이므로 압축 불필요)"""
    import tarfile as tarfile_mod
    # gz 압축을 제거하여 COLMAP tarball 생성/해제 속도를 2~3배 향상
    tar_name_plain = tar_name.replace(".tar.gz", ".tar")
    tar_path = os.path.join(tmpdir, tar_name_plain)
    with tarfile_mod.open(tar_path, "w:") as tar:
        tar.add(src_dir, arcname=os.path.basename(src_dir))
    return tar_path


def _upload_glb_preview_from_zip(asset_id: str, zip_path: str, tmpdir: str):
    """ZIP 안의 OBJ를 GLB로 변환하여 previewObject를 갱신 (미리보기용)"""
    import zipfile
    import glob as glob_module

    try:
        import trimesh
    except ImportError:
        print("[Worker] trimesh 미설치 — GLB 미리보기 건너뜀")
        return

    try:
        preview_dir = os.path.join(tmpdir, "glb_preview")
        os.makedirs(preview_dir, exist_ok=True)

        with zipfile.ZipFile(zip_path, "r") as zf:
            zf.extractall(preview_dir)

        obj_files = glob_module.glob(os.path.join(preview_dir, "*.obj"))
        ply_files = glob_module.glob(os.path.join(preview_dir, "*.ply"))

        source_file = None
        if obj_files:
            source_file = obj_files[0]
            print(f"[Worker] ZIP 내 OBJ 발견: {os.path.basename(source_file)}")
        elif ply_files:
            source_file = ply_files[0]
            print(f"[Worker] ZIP 내 PLY 발견 (OBJ 없음): {os.path.basename(source_file)}")
        else:
            print("[Worker] ZIP 내 OBJ/PLY 파일 없음 — GLB 미리보기 건너뜀")
            return

        glb_path = os.path.join(tmpdir, "preview.glb")
        try:
            scene = trimesh.load(source_file, force="scene")
            scene.export(glb_path)
            print(f"[Worker] GLB 변환 완료: {source_file} → {glb_path}")
        except Exception as conv_err:
            print(f"[Worker] GLB 변환 실패: {conv_err} — 원본 파일을 미리보기로 업로드")
            # GLB 변환 실패 시 원본 파일 자체를 미리보기로 업로드
            ext = os.path.splitext(source_file)[-1]
            mime = "model/gltf-binary" if ext == ".glb" else "application/octet-stream"
            preview_object = f"previews/{asset_id}/output{ext}"
            upload_object(source_file, preview_object, mime)
            _update_preview_object_keep_status(asset_id, preview_object)
            print(f"[Worker] 원본 미리보기 업로드 완료 → {preview_object}")
            return

        preview_object = f"previews/{asset_id}/output.glb"
        upload_object(glb_path, preview_object, "model/gltf-binary")
        _update_preview_object_keep_status(asset_id, preview_object)
        print(f"[Worker] GLB 미리보기 업로드 완료 → {preview_object}")
    except Exception as e:
        print(f"[Worker] GLB 미리보기 생성 실패 (무시): {e}")


def _update_preview_object_keep_status(asset_id: str, preview_object: str):
    """previewObject만 갱신 (status 변경 없음)"""
    from database import get_connection
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE assets SET preview_object = %s, updated_at = NOW() WHERE id = %s",
                (preview_object, asset_id),
            )
        conn.commit()
    finally:
        conn.close()


def _upload_output(asset_id: str, output_path: str) -> str:
    result_ext    = os.path.splitext(output_path)[-1]
    mime_type     = MIME_MAP.get(result_ext, "application/octet-stream")
    output_object = f"outputs/{asset_id}/output{result_ext}"
    upload_object(output_path, output_object, mime_type)
    return output_object


def recover_stalled_jobs(r: redis.Redis, wait_key: str, active_key: str):
    """
    워커 재시작 시 active 큐에 남은 stalled job을 wait 큐로 되돌리고
    DB 상태를 pending으로 리셋한다.
    """
    stalled = r.lrange(active_key, 0, -1)
    if not stalled:
        return

    print(f"[Worker] Stalled job {len(stalled)}개 발견 — 재시도 큐로 복구 중...")
    for job_id in stalled:
        job_key      = f"bull:{QUEUE_NAME}:{job_id}"
        job_data_raw = r.hget(job_key, "data")
        if job_data_raw:
            try:
                data     = json.loads(job_data_raw)
                asset_id = data.get("assetId")
                if asset_id:
                    update_asset_status(asset_id, "pending", progress=0)
                    print(f"[Worker] Asset {asset_id} → pending 으로 리셋")
            except Exception as e:
                print(f"[Worker] Stalled job {job_id} 리셋 실패: {e}")

        # active → wait 앞쪽으로 이동 (우선 처리)
        r.lrem(active_key, 1, job_id)
        r.lpush(wait_key, job_id)
        print(f"[Worker] Job {job_id} → wait 큐로 복구")


def main():
    print(f"[Worker] Starting — Redis: {REDIS_HOST}:{REDIS_PORT}")
    r = get_redis()

    wait_key   = f"bull:{QUEUE_NAME}:wait"
    active_key = f"bull:{QUEUE_NAME}:active"

    # 이전 실행에서 중단된 job 복구
    recover_stalled_jobs(r, wait_key, active_key)

    print("[Worker] Listening for jobs...")

    while True:
        try:
            job_id = r.brpoplpush(wait_key, active_key, timeout=5)
            if not job_id:
                continue

            print(f"[Worker] Got job ID: {job_id}")

            job_key      = f"bull:{QUEUE_NAME}:{job_id}"
            job_data_raw = r.hget(job_key, "data")

            if not job_data_raw:
                print(f"[Worker] No data for job {job_id}, skipping")
                r.lrem(active_key, 1, job_id)
                continue

            data = json.loads(job_data_raw)

            try:
                output_object = process_job(job_id, data)
            except AssetDeletedException as deleted_err:
                print(f"[Worker] {deleted_err} — job 중단")
                r.lrem(active_key, 1, job_id)
                r.hset(job_key, mapping={"failedReason": "asset deleted", "finishedOn": int(time.time() * 1000)})
                continue
            except AwaitingCropException as crop_err:
                # 정상 흐름: 사용자 영역 선택 대기 (실패 아님)
                print(f"[Worker] {crop_err}")
                r.lrem(active_key, 1, job_id)
                r.hset(job_key, mapping={"returnvalue": json.dumps({"status": "awaiting_crop"}), "finishedOn": int(time.time() * 1000)})
                continue
            except GpuRequiredException as gpu_err:
                # GPU 사양 미달: gpu_required 상태로 종료 (실패 아님)
                print(f"[Worker] GPU 요구사항 미달 — job {job_id} 중단")
                r.lrem(active_key, 1, job_id)
                r.hset(job_key, mapping={"returnvalue": json.dumps({"status": "gpu_required"}), "finishedOn": int(time.time() * 1000)})
                continue
            except Exception as job_err:
                import traceback
                asset_id = data.get("assetId")
                if str(job_err) == "__asset_deleted__":
                    print(f"[Worker] Asset {asset_id} 삭제로 인해 job {job_id} 중단")
                else:
                    traceback.print_exc()
                    if asset_id:
                        update_asset_status(asset_id, "failed", error_message=str(job_err))
                r.lrem(active_key, 1, job_id)
                r.hset(job_key, mapping={"failedReason": str(job_err), "finishedOn": int(time.time() * 1000)})
                continue

            r.lrem(active_key, 1, job_id)
            r.hset(job_key, mapping={
                "returnvalue": json.dumps({"outputObject": output_object}),
                "finishedOn":  int(time.time() * 1000),
            })
            print(f"[Worker] Job {job_id} completed")

        except KeyboardInterrupt:
            print("[Worker] Stopped")
            break
        except Exception as e:
            print(f"[Worker] Error: {e}")
            import traceback
            traceback.print_exc()
            time.sleep(3)

def process_job(job_id: str, data: dict) -> str:
    asset_id = data.get("assetId")
    asset_type = data.get("assetType")
    source_obj = data.get("sourceObject")
    output_profile = data.get("outputProfile")

    print(f"[Worker] Processing job {job_id} -- asset: {asset_id}, type: {asset_type}, profile: {output_profile}")

    def on_progress(pct: int):
        update_asset_progress(asset_id, pct)
        print(f"[Worker] Job {job_id} progress: {pct}%")

    def stop_check() -> bool:
        return is_asset_deleted(asset_id)

    if data.get("stage") == "regenerate_preview":
        with tempfile.TemporaryDirectory() as tmpdir:
            _run_regenerate_preview(asset_id, data, tmpdir)
        print(f"[Worker] Job {job_id} regenerate_preview done")
        return data.get("outputObject", "")

    update_asset_status(asset_id, "processing", progress=0)

    with tempfile.TemporaryDirectory() as tmpdir:
        metrics: dict = {}

        if data.get("stage") == "stage2":
            on_progress(55)
            output_object = _run_stage2(asset_id, asset_type, data, tmpdir, on_progress, stop_check=stop_check, metrics_out=metrics)
        else:
            ext = os.path.splitext(source_obj)[-1].lower()
            input_path = os.path.join(tmpdir, f"input{ext}")
            on_progress(5)
            download_object(source_obj, input_path)
            on_progress(10)

            if asset_type in TWO_STAGE_TYPES and ext in TWO_STAGE_EXTS:
                output_object = _run_two_stage(
                    asset_id,
                    asset_type,
                    input_path,
                    tmpdir,
                    on_progress,
                    output_profile=output_profile,
                    stop_check=stop_check,
                    metrics_out=metrics,
                )
            else:
                output_dir = os.path.join(tmpdir, "output")
                output_path = convert_asset(
                    asset_type,
                    input_path,
                    output_dir,
                    on_progress,
                    output_profile=output_profile,
                )
                output_object = _upload_output(asset_id, output_path)
                if output_path.endswith(".zip"):
                    _upload_glb_preview_from_zip(asset_id, output_path, tmpdir)
                if asset_type == "mesh" and output_path.endswith(".zip"):
                    tex = _upload_textures_from_zip(asset_id, output_path, tmpdir)
                    if tex:
                        update_texture_objects(asset_id, tex)

    update_asset_status(asset_id, "done", output_object=output_object)
    if metrics:
        update_quality_metrics(asset_id, metrics)
        print(f"[Worker] Job {job_id} quality metrics saved: {metrics}")
    print(f"[Worker] Job {job_id} done -- output: {output_object}")
    return output_object


def _run_two_stage(asset_id: str, asset_type: str, input_path: str, tmpdir: str, on_progress, output_profile: str | None = None, stop_check=None, metrics_out: dict | None = None) -> str:
    print("[Worker][Stage1] starting preprocess + preview generation")
    fly_path, processed_dir = preprocess_to_fly(input_path, tmpdir, on_progress, stop_check=stop_check)

    if fly_path and os.path.exists(fly_path):
        preview_object = f"previews/{asset_id}/fly.ply"
        upload_object(fly_path, preview_object, "application/octet-stream")
        update_preview_object(asset_id, preview_object)
        print(f"[Worker][Stage1] preview uploaded -> {preview_object}")
    else:
        print("[Worker][Stage1] preview generation failed, continuing to stage 2")

    on_progress(55)

    if asset_type in {"mesh", "gaussian"}:
        if not (processed_dir and os.path.isdir(processed_dir)):
            raise RuntimeError(
                f"COLMAP preprocess failed, so {asset_type} conversion cannot continue. Check COLMAP / NerfStudio setup."
            )
        tar_path = _tar_directory(processed_dir, tmpdir, "colmap.tar.gz")
        colmap_object = f"colmap/{asset_id}/processed.tar"
        preview_stats = _compute_ply_preview_stats(fly_path) if fly_path and os.path.exists(fly_path) else None
        preview_center = preview_stats["center"] if preview_stats else None
        preview_bounds = preview_stats["bounds"] if preview_stats else None
        upload_object(tar_path, colmap_object, "application/x-tar")
        update_awaiting_crop(asset_id, colmap_object, preview_center, preview_bounds)
        print(f"[Worker][Stage1] stage2 input uploaded -> {colmap_object}")
        raise AwaitingCropException(f"Asset {asset_id}: awaiting crop selection")

    if processed_dir and os.path.isdir(processed_dir):
        output_dir = os.path.join(tmpdir, "output")
        output_path = convert_from_processed(
            asset_type,
            processed_dir,
            output_dir,
            on_progress,
            output_profile=output_profile,
            stop_check=stop_check,
            metrics_out=metrics_out,
        )
    else:
        raise RuntimeError(
            f"COLMAP preprocess failed, so '{asset_type}' conversion cannot continue. Check COLMAP / NerfStudio setup."
        )

    return _upload_output(asset_id, output_path)


def _run_stage2(asset_id: str, asset_type: str, data: dict, tmpdir: str, on_progress, stop_check=None, metrics_out: dict | None = None) -> str:
    import tarfile as tarfile_mod

    colmap_object = data.get("colmapObject")
    output_profile = data.get("outputProfile")
    obb_params = data.get("obbParams")

    print(f"[Worker][Stage2] downloading COLMAP tarball: {colmap_object}")
    tar_ext = ".tar" if colmap_object.endswith(".tar") else ".tar.gz"
    tar_path = os.path.join(tmpdir, f"colmap{tar_ext}")
    download_object(colmap_object, tar_path)

    with tarfile_mod.open(tar_path, "r:*") as tar:
        tar.extractall(tmpdir)

    processed_dir = os.path.join(tmpdir, "processed")
    if not os.path.isdir(processed_dir):
        entries = [e for e in os.listdir(tmpdir) if os.path.isdir(os.path.join(tmpdir, e)) and e != "__MACOSX"]
        if entries:
            processed_dir = os.path.join(tmpdir, entries[0])

    if not os.path.isdir(processed_dir):
        raise RuntimeError("processed directory was not found after extracting the COLMAP tarball")

    on_progress(60)
    output_dir = os.path.join(tmpdir, "output")
    output_path = convert_from_processed(
        asset_type,
        processed_dir,
        output_dir,
        on_progress,
        output_profile=output_profile,
        obb_params=obb_params,
        stop_check=stop_check,
        metrics_out=metrics_out,
    )

    output_object = _upload_output(asset_id, output_path)
    if output_path.endswith(".zip") and asset_type != "nerf":
        _upload_glb_preview_from_zip(asset_id, output_path, tmpdir)
    if asset_type == "mesh" and output_path.endswith(".zip"):
        tex = _upload_textures_from_zip(asset_id, output_path, tmpdir)
        if tex:
            update_texture_objects(asset_id, tex)
    return output_object


if __name__ == "__main__":
    main()
