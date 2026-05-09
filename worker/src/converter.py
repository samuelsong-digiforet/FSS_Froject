"""
변환 엔진 — 2단계 파이프라인
─────────────────────────────────────────────────────────────────────
1단계 (preprocess_to_fly)
  ZIP/영상 → 프레임 추출 → COLMAP SfM → 빠른 splatfacto (1000 iter) → PLY (fly file)
  결과: previewObject — 업로드 직후 미리보기 제공

2단계 (convert_from_processed)
  COLMAP 결과 재사용 → 풀 트레이닝
  - gaussian    : splatfacto (7000 iter) → PLY
  - nerf        : nerfacto   (15000 iter) → ns-render interpolate → MP4
  - mesh        : trimesh 변환 → GLB
  - point_cloud : laspy/numpy → PLY
─────────────────────────────────────────────────────────────────────
"""

import os
import re
import json
import glob as glob_module
import shutil
import subprocess
import time
import zipfile
import numpy as np

NERF_RENDER_TARGET_FRAMES = 180
NERF_RENDER_MAX_INTERP_STEPS = 12
NERF_FALLBACK_MAX_FRAMES = 180
NERF_RENDER_MAX_KEYFRAMES = 24


# ══════════════════════════════════════════════════════════════════
# PUBLIC API
# ══════════════════════════════════════════════════════════════════

def preprocess_to_fly(input_path: str, work_dir: str, progress_callback=None, stop_check=None) -> tuple[str | None, str | None]:
    """
    1단계: ZIP/영상 → COLMAP → 빠른 splatfacto → fly PLY
    반환값: (fly_ply_path, processed_dir)
      - fly_ply_path : 미리보기용 PLY 경로 (실패 시 None)
      - processed_dir: COLMAP 결과 디렉터리 (2단계에서 재사용)
    """
    def report(pct: int):
        if progress_callback:
            progress_callback(min(pct, 54))  # 1단계는 0~54%

    ext = os.path.splitext(input_path)[-1].lower()

    frames_dir    = os.path.join(work_dir, "frames")
    processed_dir = os.path.join(work_dir, "processed")
    os.makedirs(frames_dir, exist_ok=True)

    # ── 1. 프레임 추출 ───────────────────────────────────────────
    report(3)
    if ext == ".zip":
        count = _extract_images_from_zip(input_path, frames_dir, report, start=3, end=10)
    elif ext in (".mp4", ".mov", ".avi", ".mkv"):
        count = _extract_frames_from_video(input_path, frames_dir, report, start=3, end=10, fps=2)
    else:
        print(f"[Converter] preprocess_to_fly: 지원하지 않는 포맷 {ext}")
        return None, None

    if count < 10:
        print(f"[Converter] 이미지 부족 ({count}장) — 최소 10장 필요")
        return None, None

    print(f"[Converter][Stage1] {count}개 이미지 추출 완료")
    report(10)

    # ── 2. COLMAP SfM (ns-process-data) ─────────────────────────
    # --no-gpu: Docker 컨테이너 안에서 Qt 디스플레이 없이 실행하기 위해 CPU SIFT 사용
    print("[Converter][Stage1] COLMAP 카메라 캘리브레이션 중...")
    try:
        _run_cmd(
            ["ns-process-data", "images", "--data", frames_dir, "--output-dir", processed_dir, "--no-gpu"],
            report_range=(10, 35), report_fn=report, stop_check=stop_check,
        )
    except Exception as e:
        print(f"[Converter][Stage1] COLMAP 실패: {e}")
        if "__asset_deleted__" in str(e):
            raise
        return None, None
    report(35)

    # ── 3. 빠른 splatfacto (500 iter → fly PLY) ────────────────
    print("[Converter][Stage1] 빠른 3DGS 학습 중 (500 iterations)...")
    fly_train_dir  = os.path.join(work_dir, "fly_train")
    fly_export_dir = os.path.join(work_dir, "fly_export")
    os.makedirs(fly_export_dir, exist_ok=True)

    try:
        _run_cmd(
            [
                "ns-train", "splatfacto",
                "--data", processed_dir,
                "--output-dir", fly_train_dir,
                "--max-num-iterations", "500",
                "--viewer.quit-on-train-completion", "True",
            ],
            report_range=(35, 50), report_fn=report, stop_check=stop_check,
        )
        report(50)

        config_path = _find_nerfstudio_config(fly_train_dir)
        _run_cmd(
            ["ns-export", "gaussian-splat", "--load-config", config_path, "--output-dir", fly_export_dir],
            report_range=(50, 54), report_fn=report, stop_check=stop_check,
        )
    except Exception as e:
        print(f"[Converter][Stage1] 빠른 splat 실패: {e}")
        return None, processed_dir  # COLMAP 결과는 유효하므로 반환

    # PLY 파일 찾기
    fly_ply = os.path.join(fly_export_dir, "splat.ply")
    if not os.path.exists(fly_ply):
        plys = glob_module.glob(os.path.join(fly_export_dir, "*.ply"))
        fly_ply = plys[0] if plys else None

    if fly_ply:
        final_fly = os.path.join(work_dir, "fly.ply")
        shutil.copy(fly_ply, final_fly)
        print(f"[Converter][Stage1] fly file 완성 → {final_fly}")
        report(54)
        return final_fly, processed_dir

    return None, processed_dir


def convert_from_processed(asset_type: str, processed_dir: str, output_dir: str, progress_callback=None, output_profile: str | None = None, obb_params: dict | None = None, stop_check=None) -> str:
    """
    2단계: COLMAP 결과(processed_dir) → 풀 트레이닝 or 포인트클라우드/메시 추출
    obb_params: {"center": [x,y,z], "rotation": [x,y,z], "scale": [x,y,z]} — mesh/nerf 영역 지정용
    """
    os.makedirs(output_dir, exist_ok=True)

    def report(pct: int):
        if progress_callback:
            progress_callback(55 + min(pct, 44))  # 2단계는 55~99%

    if asset_type == "gaussian":
        return _full_gaussian(processed_dir, output_dir, report, obb_params=obb_params, stop_check=stop_check)
    elif asset_type == "nerf":
        return _full_nerf(processed_dir, output_dir, report, obb_params=obb_params, stop_check=stop_check)
    elif asset_type == "point_cloud":
        return _point_cloud_from_colmap(processed_dir, output_dir, report, stop_check=stop_check)
    elif asset_type == "mesh":
        return _mesh_from_colmap(processed_dir, output_dir, report, output_profile=output_profile, obb_params=obb_params, stop_check=stop_check)
    else:
        raise ValueError(f"convert_from_processed: 지원하지 않는 타입 {asset_type}")


def convert_asset(asset_type: str, input_path: str, output_dir: str, progress_callback=None, output_profile: str | None = None) -> str:
    """단일 단계 변환 (mesh, point_cloud, 또는 ZIP/영상 없이 직접 변환)"""
    os.makedirs(output_dir, exist_ok=True)
    ext = os.path.splitext(input_path)[-1].lower()

    def report(pct: int):
        if progress_callback:
            progress_callback(min(pct, 99))

    dispatch = {
        "mesh":        _convert_mesh,
        "point_cloud": _convert_point_cloud,
    }
    fn = dispatch.get(asset_type)
    if fn is None:
        # gaussian / nerf 은 ZIP/영상 → 2단계 파이프라인 전용이므로
        # 단일 단계에서 호출되면 반드시 실패 처리해야 함
        raise ValueError(
            f"'{asset_type}' 타입은 ZIP/영상 입력의 2단계 파이프라인이 필요합니다. "
            f"입력 파일({ext})이 지원되는 형식(zip, mp4, mov, avi, mkv)인지 확인하세요."
        )

    return fn(input_path, output_dir, ext, report, output_profile=output_profile)


# ══════════════════════════════════════════════════════════════════
# 2단계 — Gaussian Splatting 풀 트레이닝
# ══════════════════════════════════════════════════════════════════
def _full_gaussian(processed_dir: str, output_dir: str, report, obb_params: dict | None = None, stop_check=None) -> str:
    train_dir  = os.path.join(output_dir, "train")
    export_dir = os.path.join(output_dir, "export")
    os.makedirs(export_dir, exist_ok=True)

    print("[Converter][Stage2][3DGS] 풀 학습 시작 (splatfacto 7000 iter)...")
    _run_cmd(
        [
            "ns-train", "splatfacto",
            "--data", processed_dir,
            "--output-dir", train_dir,
            "--max-num-iterations", "7000",
            "--pipeline.model.cull-alpha-thresh", "0.005",
            "--viewer.quit-on-train-completion", "True",
        ],
        report_range=(0, 80), report_fn=report, stop_check=stop_check,
    )
    report(80)

    config_path = _find_nerfstudio_config(train_dir)
    export_cmd = ["ns-export", "gaussian-splat", "--load-config", config_path, "--output-dir", export_dir]
    export_obb = _resolve_export_obb(obb_params)
    if export_obb is not None:
        export_cmd.extend([
            "--obb-center",
            *[str(v) for v in export_obb["center"].tolist()],
            "--obb-rotation",
            *[str(v) for v in export_obb["rotation_rad"].tolist()],
            "--obb-scale",
            *[str(v) for v in export_obb["scale"].tolist()],
        ])
        print(
            "[Converter][Stage2][3DGS] export-time OBB crop enabled:"
            f" center={export_obb['center'].tolist()},"
            f" previewCenter={export_obb['preview_center'].tolist()},"
            f" rotationDeg={export_obb['rotation_deg'].tolist()},"
            f" rotationRad={export_obb['rotation_rad'].tolist()},"
            f" scale={export_obb['scale'].tolist()}"
        )

    _run_cmd(
        export_cmd,
        report_range=(80, 95), report_fn=report, stop_check=stop_check,
    )

    output_path = os.path.join(export_dir, "splat.ply")
    if not os.path.exists(output_path):
        plys = glob_module.glob(os.path.join(export_dir, "*.ply"))
        if not plys:
            raise FileNotFoundError("3DGS 내보내기 PLY 없음")
        output_path = plys[0]

    final = os.path.join(output_dir, "output.ply")
    shutil.copy(output_path, final)
    report(99)
    print(f"[Converter][Stage2][3DGS] 완료 → {final}")
    return final


def _collect_image_files(image_dir: str) -> list[str]:
    img_exts = {".jpg", ".jpeg", ".png", ".bmp", ".tiff", ".webp"}
    if not os.path.isdir(image_dir):
        return []

    files: list[str] = []
    for name in sorted(os.listdir(image_dir)):
        path = os.path.join(image_dir, name)
        if os.path.isfile(path) and os.path.splitext(name)[1].lower() in img_exts:
            files.append(path)
    return files


def _sample_evenly(items: list[str], limit: int) -> list[str]:
    if limit <= 0 or len(items) <= limit:
        return list(items)
    if limit == 1:
        return [items[0]]

    last = len(items) - 1
    return [items[round(i * last / (limit - 1))] for i in range(limit)]


def _compute_nerf_interp_steps(num_train_images: int) -> tuple[int, int]:
    transitions = max(1, num_train_images - 1)
    interp_steps = max(
        1,
        min(NERF_RENDER_MAX_INTERP_STEPS, NERF_RENDER_TARGET_FRAMES // transitions),
    )
    estimated_total_frames = transitions * interp_steps + 1
    return interp_steps, estimated_total_frames


def _resolve_frame_source_path(processed_dir: str, frame_path: str) -> str:
    if os.path.isabs(frame_path):
        return frame_path
    return os.path.normpath(os.path.join(processed_dir, frame_path))


def _prepare_sampled_nerf_render_dataset(
    processed_dir: str,
    output_dir: str,
    max_keyframes: int = NERF_RENDER_MAX_KEYFRAMES,
) -> tuple[str, int, bool]:
    transforms_path = os.path.join(processed_dir, "transforms.json")
    if not os.path.exists(transforms_path):
        return processed_dir, len(_collect_image_files(os.path.join(processed_dir, "images"))), False

    with open(transforms_path, "r", encoding="utf-8") as fh:
        transforms = json.load(fh)

    frames = transforms.get("frames")
    if not isinstance(frames, list) or len(frames) <= max_keyframes:
        return processed_dir, len(frames) if isinstance(frames, list) else 0, False

    sampled_frames = _sample_evenly(frames, max_keyframes)
    sampled_dir = os.path.join(output_dir, "render_dataset")
    if os.path.isdir(sampled_dir):
        shutil.rmtree(sampled_dir)
    os.makedirs(sampled_dir, exist_ok=True)

    rewritten_frames: list[dict] = []
    for index, frame in enumerate(sampled_frames):
        if not isinstance(frame, dict) or "file_path" not in frame:
            continue

        source_image = _resolve_frame_source_path(processed_dir, str(frame["file_path"]))
        if not os.path.exists(source_image):
            print(f"[Converter][Stage2][NeRF] sampled render frame missing: {source_image}")
            continue

        _, ext = os.path.splitext(source_image)
        dest_rel = os.path.join("images", f"render_keyframe_{index:04d}{ext.lower() or '.png'}")
        dest_path = os.path.join(sampled_dir, dest_rel)
        os.makedirs(os.path.dirname(dest_path), exist_ok=True)
        shutil.copy2(source_image, dest_path)

        copied_frame = dict(frame)
        copied_frame["file_path"] = dest_rel.replace("\\", "/")
        rewritten_frames.append(copied_frame)

    if len(rewritten_frames) < 2:
        shutil.rmtree(sampled_dir, ignore_errors=True)
        return processed_dir, len(frames), False

    transforms["frames"] = rewritten_frames
    with open(os.path.join(sampled_dir, "transforms.json"), "w", encoding="utf-8") as fh:
        json.dump(transforms, fh, ensure_ascii=False, indent=2)

    return sampled_dir, len(rewritten_frames), True


def _create_sampled_nerf_render_config(
    config_path: str,
    original_processed_dir: str,
    render_processed_dir: str,
    output_dir: str,
) -> str:
    if os.path.normpath(original_processed_dir) == os.path.normpath(render_processed_dir):
        return config_path

    with open(config_path, "r", encoding="utf-8") as fh:
        config_text = fh.read()

    updated_text = config_text.replace(original_processed_dir, render_processed_dir)
    if updated_text == config_text:
        print("[Converter][Stage2][NeRF] render config path replacement skipped; using original config")
        return config_path

    sampled_config_path = os.path.join(output_dir, "render_config.yml")
    with open(sampled_config_path, "w", encoding="utf-8") as fh:
        fh.write(updated_text)
    return sampled_config_path


def _compute_nerf_render_downscale(num_source_images: int) -> float:
    if num_source_images >= 600:
        return 4.0
    if num_source_images >= 240:
        return 3.0
    if num_source_images >= 120:
        return 2.0
    return 1.0


def _extract_png_frames_from_video(video_path: str, output_dir: str) -> list[str]:
    import cv2

    os.makedirs(output_dir, exist_ok=True)
    cap = cv2.VideoCapture(video_path)
    frame_paths: list[str] = []
    frame_index = 0

    while cap.isOpened():
        ret, frame = cap.read()
        if not ret:
            break

        frame_path = os.path.join(output_dir, f"render_{frame_index:04d}.png")
        if cv2.imwrite(frame_path, frame):
            frame_paths.append(frame_path)
            frame_index += 1

    cap.release()
    return frame_paths


def _write_png_frames_from_images(image_paths: list[str], output_dir: str) -> list[str]:
    import cv2

    os.makedirs(output_dir, exist_ok=True)
    frame_paths: list[str] = []

    for index, image_path in enumerate(image_paths):
        frame = cv2.imread(image_path, cv2.IMREAD_COLOR)
        if frame is None:
            print(f"[Converter][Stage2][NeRF] fallback frame skip (unreadable): {image_path}")
            continue

        frame_path = os.path.join(output_dir, f"render_{index:04d}.png")
        if cv2.imwrite(frame_path, frame):
            frame_paths.append(frame_path)

    return frame_paths


def _write_mp4_from_frames(frame_paths: list[str], mp4_path: str, fps: int = 12) -> bool:
    import cv2

    if not frame_paths:
        return False

    if os.path.exists(mp4_path):
        os.remove(mp4_path)

    first_frame = cv2.imread(frame_paths[0], cv2.IMREAD_COLOR)
    if first_frame is None:
        return False

    height, width = first_frame.shape[:2]
    writer = cv2.VideoWriter(mp4_path, cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height))
    if not writer.isOpened():
        if os.path.exists(mp4_path):
            os.remove(mp4_path)
        return False

    try:
        for frame_path in frame_paths:
            frame = cv2.imread(frame_path, cv2.IMREAD_COLOR)
            if frame is None:
                continue
            if frame.shape[0] != height or frame.shape[1] != width:
                frame = cv2.resize(frame, (width, height), interpolation=cv2.INTER_AREA)
            writer.write(frame)
    finally:
        writer.release()

    if not os.path.exists(mp4_path) or os.path.getsize(mp4_path) <= 0:
        if os.path.exists(mp4_path):
            os.remove(mp4_path)
        return False

    return True


def _fallback_nerf_render_bundle(
    image_paths: list[str],
    output_dir: str,
    render_dir: str,
    mp4_path: str,
) -> tuple[list[str], bool]:
    sampled_images = _sample_evenly(image_paths, NERF_FALLBACK_MAX_FRAMES)
    if not sampled_images:
        raise FileNotFoundError("NeRF fallback용 이미지 소스를 찾을 수 없습니다")

    frame_paths = _write_png_frames_from_images(sampled_images, render_dir)
    if not frame_paths:
        raise FileNotFoundError("NeRF fallback 프레임(PNG)을 생성하지 못했습니다")

    fallback_note = os.path.join(output_dir, "bundle_info.txt")
    with open(fallback_note, "w", encoding="utf-8") as fh:
        fh.write(
            "ns-render interpolate failed or was skipped, so the bundle was created from processed source images.\n"
            f"frames={len(frame_paths)}\n"
        )

    mp4_created = _write_mp4_from_frames(frame_paths, mp4_path)
    if not mp4_created:
        print("[Converter][Stage2][NeRF] fallback MP4 generation skipped")
        if os.path.exists(mp4_path):
            os.remove(mp4_path)

    return frame_paths, mp4_created


def _package_nerf_render_bundle(
    output_dir: str,
    zip_path: str,
    frame_paths: list[str],
    mp4_path: str,
) -> str:
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        if os.path.exists(mp4_path) and os.path.getsize(mp4_path) > 0:
            zf.write(mp4_path, "render.mp4")

        info_path = os.path.join(output_dir, "bundle_info.txt")
        if os.path.exists(info_path):
            zf.write(info_path, "bundle_info.txt")

        for frame_path in frame_paths:
            zf.write(frame_path, os.path.join("frames", os.path.basename(frame_path)))

    return zip_path


# ══════════════════════════════════════════════════════════════════
# 2단계 — NeRF 풀 트레이닝
# ══════════════════════════════════════════════════════════════════
def _full_nerf(processed_dir: str, output_dir: str, report, obb_params: dict | None = None, stop_check=None) -> str:
    """
    nerfacto 학습 후 interpolate 렌더링 → PNG 이미지 ZIP 출력.
    렌더링 프레임 수는 학습 이미지 수에 비례하여 자동 결정.
    obb_params는 NeRF 렌더링에서 사용하지 않음.
    """
    train_dir  = os.path.join(output_dir, "train")
    render_dir = os.path.join(output_dir, "render_frames")
    if os.path.isdir(render_dir):
        shutil.rmtree(render_dir)
    os.makedirs(render_dir, exist_ok=True)

    images_dir = os.path.join(processed_dir, "images")
    if not os.path.isdir(images_dir):
        images_dir = processed_dir
    image_paths = _collect_image_files(images_dir)
    num_train_images = len(image_paths)
    render_processed_dir, render_pose_count, sampled_render_dataset = _prepare_sampled_nerf_render_dataset(
        processed_dir,
        output_dir,
    )
    render_image_paths = _collect_image_files(os.path.join(render_processed_dir, "images"))
    render_pose_count = render_pose_count or num_train_images
    interp_steps, estimated_frames = _compute_nerf_interp_steps(render_pose_count)
    render_downscale = _compute_nerf_render_downscale(num_train_images)
    should_render_video = render_pose_count > 1 and estimated_frames <= NERF_RENDER_TARGET_FRAMES
    print(
        f"[Converter][Stage2][NeRF] 학습 이미지 {num_train_images}장 "
        f"→ renderPoses={render_pose_count}, interpolation-steps={interp_steps}, "
        f"estimatedFrames={estimated_frames}, downscale={render_downscale}, "
        f"sampledDataset={'yes' if sampled_render_dataset else 'no'}, "
        f"renderMode={'interpolate' if should_render_video else 'fallback'}"
    )

    print("[Converter][Stage2][NeRF] 풀 학습 시작 (nerfacto 15000 iter, tcnn 가속)...")
    _run_cmd(
        [
            "ns-train", "nerfacto",
            "--data", processed_dir,
            "--output-dir", train_dir,
            "--max-num-iterations", "15000",
            "--pipeline.model.implementation", "tcnn",
            "--viewer.quit-on-train-completion", "True",
        ],
        report_range=(0, 80), report_fn=report, stop_check=stop_check,
    )
    report(80)

    config_path = _find_nerfstudio_config(train_dir)
    render_config_path = _create_sampled_nerf_render_config(
        config_path,
        processed_dir,
        render_processed_dir,
        output_dir,
    )
    mp4_path = os.path.join(output_dir, "render.mp4")
    zip_path = os.path.join(output_dir, "output.zip")
    frame_paths: list[str] = []
    used_fallback = False

    if os.path.exists(mp4_path):
        os.remove(mp4_path)

    info_path = os.path.join(output_dir, "bundle_info.txt")
    if os.path.exists(info_path):
        os.remove(info_path)

    if should_render_video:
        print(f"[Converter][Stage2][NeRF] 신규 시점 렌더링 중 → {mp4_path}...")
        try:
            _run_cmd(
                [
                    "ns-render", "interpolate",
                    "--load-config", render_config_path,
                    "--output-path", mp4_path,
                    "--pose-source", "train",
                    "--interpolation-steps", str(interp_steps),
                    "--downscale-factor", str(render_downscale),
                    "--order-poses", "True",
                ],
                report_range=(80, 95), report_fn=report,
                timeout=1800, stop_check=stop_check,
            )
        except (CommandTimeoutError, RuntimeError) as e:
            used_fallback = True
            print(f"[Converter][Stage2][NeRF] render fallback engaged: {e}")
        else:
            report(95)
            if os.path.exists(mp4_path) and os.path.getsize(mp4_path) > 0:
                print("[Converter][Stage2][NeRF] MP4에서 PNG 프레임 추출 중...")
                frame_paths = _extract_png_frames_from_video(mp4_path, render_dir)
                print(f"[Converter][Stage2][NeRF] 프레임 {len(frame_paths)}장 추출 완료")
            else:
                used_fallback = True
                print("[Converter][Stage2][NeRF] render.mp4 not found after render; switching to fallback")
    else:
        used_fallback = True
        print(
            "[Converter][Stage2][NeRF] 학습 이미지 수가 많아 interpolate 렌더를 건너뜁니다. "
            "processed 이미지 기반 번들로 대체합니다."
        )

    if used_fallback or not frame_paths:
        frame_paths, fallback_mp4 = _fallback_nerf_render_bundle(
            image_paths=render_image_paths or image_paths,
            output_dir=output_dir,
            render_dir=render_dir,
            mp4_path=mp4_path,
        )
        report(95)
        print(
            f"[Converter][Stage2][NeRF] fallback bundle prepared "
            f"(frames={len(frame_paths)}, mp4={'yes' if fallback_mp4 else 'no'})"
        )

    if not frame_paths:
        raise FileNotFoundError("NeRF 프레임 결과(PNG)를 찾을 수 없습니다")

    _package_nerf_render_bundle(output_dir, zip_path, frame_paths, mp4_path)

    report(99)
    print(
        f"[Converter][Stage2][NeRF] 완료 → {zip_path} "
        f"(MP4={'yes' if os.path.exists(mp4_path) else 'no'}, PNG={len(frame_paths)}장, "
        f"mode={'fallback' if used_fallback else 'render'})"
    )
    return zip_path


# ══════════════════════════════════════════════════════════════════
# 2단계 — Point Cloud (COLMAP 희소 포인트 클라우드 추출)
# ══════════════════════════════════════════════════════════════════
def _point_cloud_from_colmap(processed_dir: str, output_dir: str, report, stop_check=None) -> str:
    """COLMAP sparse 재구성 결과를 PLY로 변환"""
    output_ply = os.path.join(output_dir, "output.ply")

    # ns-process-data 결과의 COLMAP sparse 경로 후보
    colmap_sparse_candidates = [
        os.path.join(processed_dir, "colmap", "sparse", "0"),
        os.path.join(processed_dir, "sparse", "0"),
        os.path.join(processed_dir, "sparse"),
    ]
    colmap_sparse = next((p for p in colmap_sparse_candidates if os.path.isdir(p)), None)

    report(10)

    if colmap_sparse:
        print(f"[Converter][PointCloud] COLMAP sparse → PLY: {colmap_sparse}")
        try:
            _run_cmd(
                [
                    "colmap", "model_converter",
                    "--input_path", colmap_sparse,
                    "--output_path", output_ply,
                    "--output_type", "PLY",
                ],
                report_range=(10, 90), report_fn=report,
            )
            if os.path.exists(output_ply):
                report(99)
                print(f"[Converter][PointCloud] COLMAP PLY 추출 완료 → {output_ply}")
                return output_ply
        except Exception as e:
            print(f"[Converter][PointCloud] colmap model_converter 실패: {e}")

    # fallback: ns-train splatfacto → ns-export pointcloud
    print("[Converter][PointCloud] fallback: splatfacto → pointcloud export")
    train_dir  = os.path.join(output_dir, "train")
    export_dir = os.path.join(output_dir, "export")
    os.makedirs(export_dir, exist_ok=True)
    try:
        _run_cmd(
            ["ns-train", "splatfacto", "--data", processed_dir, "--output-dir", train_dir, "--max-num-iterations", "3000", "--viewer.quit-on-train-completion", "True"],
            report_range=(10, 70), report_fn=report,
        )
        config_path = _find_nerfstudio_config(train_dir)
        _run_cmd(
            ["ns-export", "pointcloud", "--load-config", config_path, "--output-dir", export_dir, "--num-points", "1000000"],
            report_range=(70, 95), report_fn=report,
        )
        plys = glob_module.glob(os.path.join(export_dir, "*.ply"))
        if plys:
            shutil.copy(plys[0], output_ply)
            report(99)
            return output_ply
    except Exception as e:
        print(f"[Converter][PointCloud] fallback 실패: {e}")

    raise RuntimeError("포인트 클라우드 변환 실패: COLMAP 결과를 PLY로 변환할 수 없습니다.")


# ══════════════════════════════════════════════════════════════════
# 2단계 — Mesh (COLMAP → NeRF → Mesh 추출)
# ══════════════════════════════════════════════════════════════════
def _rotation_matrix_xyz_deg(rotation_deg: np.ndarray) -> np.ndarray:
    """Three.js Euler('XYZ')와 같은 회전 행렬을 만든다."""
    rx, ry, rz = np.radians(rotation_deg)
    a, b = np.cos(rx), np.sin(rx)
    c, d = np.cos(ry), np.sin(ry)
    e, f = np.cos(rz), np.sin(rz)
    return np.array([
        [c * e,               -c * f,              d],
        [a * f + b * e * d,   a * e - b * f * d,  -b * c],
        [b * f - a * e * d,   b * e + a * f * d,   a * c],
    ], dtype=np.float64)


def _load_mesh_for_crop(export_dir: str):
    import trimesh

    mesh_files = glob_module.glob(os.path.join(export_dir, "*.obj"))
    if not mesh_files:
        mesh_files = glob_module.glob(os.path.join(export_dir, "*.ply"))
    if not mesh_files:
        return None, None

    mesh_path = mesh_files[0]
    mesh = trimesh.load(mesh_path, process=False)

    if isinstance(mesh, trimesh.Scene):
        try:
            dumped = mesh.dump(concatenate=True)
            if isinstance(dumped, trimesh.Trimesh):
                mesh = dumped
            else:
                geoms = [g for g in dumped if isinstance(g, trimesh.Trimesh)]
                mesh = trimesh.util.concatenate(geoms)
        except Exception:
            geoms = [g for g in mesh.dump() if isinstance(g, trimesh.Trimesh)]
            mesh = trimesh.util.concatenate(geoms)

    if not isinstance(mesh, trimesh.Trimesh):
        return mesh_path, None

    return mesh_path, mesh


def _slice_mesh_to_local_obb(mesh, half: np.ndarray):
    planes = [
        (np.array([half[0], 0.0, 0.0], dtype=np.float64), np.array([-1.0, 0.0, 0.0], dtype=np.float64)),
        (np.array([-half[0], 0.0, 0.0], dtype=np.float64), np.array([1.0, 0.0, 0.0], dtype=np.float64)),
        (np.array([0.0, half[1], 0.0], dtype=np.float64), np.array([0.0, -1.0, 0.0], dtype=np.float64)),
        (np.array([0.0, -half[1], 0.0], dtype=np.float64), np.array([0.0, 1.0, 0.0], dtype=np.float64)),
        (np.array([0.0, 0.0, half[2]], dtype=np.float64), np.array([0.0, 0.0, -1.0], dtype=np.float64)),
        (np.array([0.0, 0.0, -half[2]], dtype=np.float64), np.array([0.0, 0.0, 1.0], dtype=np.float64)),
    ]

    clipped = mesh.copy()
    for plane_origin, plane_normal in planes:
        clipped = clipped.slice_plane(
            plane_origin=plane_origin,
            plane_normal=plane_normal,
            cap=False,
        )
        if clipped is None or clipped.is_empty or len(clipped.faces) == 0:
            return None

    clipped.remove_unreferenced_vertices()
    return clipped


def _compute_mesh_bbox(mesh):
    bounds = getattr(mesh, "bounds", None)
    if bounds is not None and np.shape(bounds) == (2, 3):
        min_corner = np.asarray(bounds[0], dtype=np.float64)
        max_corner = np.asarray(bounds[1], dtype=np.float64)
    else:
        vertices = np.asarray(mesh.vertices, dtype=np.float64)
        if vertices.size == 0:
            zeros = np.zeros(3, dtype=np.float64)
            return zeros, np.ones(3, dtype=np.float64)
        min_corner = vertices.min(axis=0)
        max_corner = vertices.max(axis=0)

    center = (min_corner + max_corner) / 2.0
    extents = np.maximum(max_corner - min_corner, np.full(3, 1e-6, dtype=np.float64))
    return center, extents


def _clip_mesh_with_obb(mesh, world_center: np.ndarray, rotation: np.ndarray, scale: np.ndarray):
    rotation_matrix = _rotation_matrix_xyz_deg(rotation)
    half = np.abs(scale) / 2.0

    local_mesh = mesh.copy()
    local_mesh.vertices = (local_mesh.vertices - world_center) @ rotation_matrix
    clipped = _slice_mesh_to_local_obb(local_mesh, half)
    if clipped is None or clipped.is_empty or len(clipped.faces) == 0:
        return None

    clipped.vertices = clipped.vertices @ rotation_matrix.T + world_center
    clipped.remove_unreferenced_vertices()
    return clipped


def _score_mesh_crop_candidate(clipped, total_faces: int, candidate_scale: np.ndarray, strategy: str):
    """Score a cropped mesh candidate.

    We compare candidates generated from different preview->mesh mappings.
    Small accidental intersections should lose to candidates that keep a more
    substantial portion of the intended OBB volume.
    """
    if clipped is None or clipped.is_empty or len(clipped.faces) == 0:
        return None

    _, clipped_extents = _compute_mesh_bbox(clipped)
    scale_safe = np.maximum(np.abs(candidate_scale), np.full(3, 1e-6, dtype=np.float64))
    fill_mean = float(np.mean(np.clip(clipped_extents / scale_safe, 0.0, 1.0)))

    denom = max(float(np.log1p(max(total_faces, 1))), 1.0)
    kept = int(len(clipped.faces))
    kept_score = float(np.log1p(kept) / denom)

    strategy_bias = {
        "mesh_bbox_axis": 0.10,
        "preview_center_raw": 0.08,
        "mesh_bbox_uniform": 0.03,
        "mesh_center_translate": 0.0,
    }.get(strategy, 0.0)

    score = (kept_score * 0.78) + (fill_mean * 0.22) + strategy_bias
    return {
        "score": score,
        "kept": kept,
        "fillMean": fill_mean,
    }


def _resolve_export_obb(obb_params: dict | None):
    """Convert preview-space OBB params from the UI into Nerfstudio export-space OBB args."""
    if not obb_params:
        return None

    try:
        center = np.array(obb_params.get("center", [0, 0, 0]), dtype=np.float64)
        rotation_deg = np.array(obb_params.get("rotation", [0, 0, 0]), dtype=np.float64)
        scale = np.abs(np.array(obb_params.get("scale", [1, 1, 1]), dtype=np.float64))
        preview_center_raw = obb_params.get("previewCenter")
        preview_center = (
            np.array(preview_center_raw, dtype=np.float64)
            if preview_center_raw is not None else np.zeros(3, dtype=np.float64)
        )

        if center.shape != (3,) or rotation_deg.shape != (3,) or scale.shape != (3,) or preview_center.shape != (3,):
            return None
        if not (
            np.all(np.isfinite(center))
            and np.all(np.isfinite(rotation_deg))
            and np.all(np.isfinite(scale))
            and np.all(np.isfinite(preview_center))
        ):
            return None

        world_center = center + preview_center
        safe_scale = np.maximum(scale, np.full(3, 1e-6, dtype=np.float64))
        rotation_rad = np.radians(rotation_deg)
        return {
            "center": world_center,
            "rotation_deg": rotation_deg,
            "rotation_rad": rotation_rad,
            "scale": safe_scale,
            "preview_center": preview_center,
        }
    except Exception:
        return None


def _crop_exported_mesh(export_dir: str, obb_params: dict):
    """OBJ 메시를 AABB로 크롭 (trimesh 버텍스 마스킹)"""
    try:
        import trimesh
        mesh_path, mesh = _load_mesh_for_crop(export_dir)
        if not mesh_path:
            print("[Converter][Crop] 크롭할 OBJ/PLY 파일이 없음")
            return
        if mesh is None:
            print("[Converter][Crop] 크롭 가능한 메시가 없음")
            return
        if mesh.is_empty or len(mesh.vertices) == 0 or len(mesh.faces) == 0:
            print("[Converter][Crop] 빈 메시라서 원본 유지")
            return

        center = np.array(obb_params.get("center", [0, 0, 0]), dtype=np.float64)
        preview_center = np.array(obb_params.get("previewCenter", [0, 0, 0]), dtype=np.float64)
        rotation = np.array(obb_params.get("rotation", [0, 0, 0]), dtype=np.float64)
        scale = np.abs(np.array(obb_params.get("scale", [1, 1, 1]), dtype=np.float64))
        half = scale / 2.0
        world_center = center + preview_center
        rotation_matrix = _rotation_matrix_xyz_deg(rotation)

        local_mesh = mesh.copy()
        local_mesh.vertices = (local_mesh.vertices - world_center) @ rotation_matrix
        clipped = _slice_mesh_to_local_obb(local_mesh, half)

        total = int(len(mesh.faces))
        kept = 0 if clipped is None else int(len(clipped.faces))
        print(
            "[Converter][Crop] OBB exact clip:"
            f" center={world_center.tolist()}, previewCenter={preview_center.tolist()},"
            f" rotation={rotation.tolist()}, kept={kept}/{total}"
        )

        if clipped is None or clipped.is_empty or len(clipped.faces) == 0:
            print("[Converter][Crop] 절단 결과가 비어서 원본 메시 유지")
            return

        clipped.vertices = clipped.vertices @ rotation_matrix.T + world_center
        clipped.remove_unreferenced_vertices()
        clipped.export(mesh_path)
        print(f"[Converter][Crop] 메시 절단 완료: {mesh_path}")
        return
        mesh_files = glob_module.glob(os.path.join(export_dir, "*.obj"))
        if not mesh_files:
            mesh_files = glob_module.glob(os.path.join(export_dir, "*.ply"))
        if mesh_files:
            center = np.array(obb_params.get("center", [0, 0, 0]), dtype=np.float64)
            preview_center = np.array(obb_params.get("previewCenter", [0, 0, 0]), dtype=np.float64)
            rotation = np.array(obb_params.get("rotation", [0, 0, 0]), dtype=np.float64)
            scale = np.abs(np.array(obb_params.get("scale", [1, 1, 1]), dtype=np.float64))
            half = scale / 2.0
            world_center = center + preview_center
            rotation_matrix = _rotation_matrix_xyz_deg(rotation)

            mesh_path = mesh_files[0]
            mesh = trimesh.load(mesh_path, process=False)

            if isinstance(mesh, trimesh.Scene):
                try:
                    dumped = mesh.dump(concatenate=True)
                    if isinstance(dumped, trimesh.Trimesh):
                        mesh = dumped
                    else:
                        geoms = [g for g in dumped if isinstance(g, trimesh.Trimesh)]
                        mesh = trimesh.util.concatenate(geoms)
                except Exception:
                    geoms = [g for g in mesh.dump() if isinstance(g, trimesh.Trimesh)]
                    mesh = trimesh.util.concatenate(geoms)

            if not isinstance(mesh, trimesh.Trimesh):
                print("[Converter][Crop] 크롭 가능한 메시 없음")
                return

            if mesh.is_empty or len(mesh.vertices) == 0 or len(mesh.faces) == 0:
                print("[Converter][Crop] 빈 메시 — 원본 유지")
                return

            local_vertices = (mesh.vertices - world_center) @ rotation_matrix
            eps = 1e-6
            in_bounds = np.all(np.abs(local_vertices) <= (half + eps), axis=1)
            face_mask = np.all(in_bounds[mesh.faces], axis=1)

            kept = int(face_mask.sum())
            total = len(mesh.faces)
            print(
                "[Converter][Crop] OBB 크롭:"
                f" center={world_center.tolist()}, previewCenter={preview_center.tolist()},"
                f" rotation={rotation.tolist()}, kept={kept}/{total}"
            )

            if kept == 0:
                print("[Converter][Crop] 크롭 결과가 비어있음 — 원본 메시 유지")
                return

            mesh.update_faces(face_mask)
            mesh.remove_unreferenced_vertices()
            mesh.export(mesh_path)
            print(f"[Converter][Crop] 메시 크롭 완료 → {mesh_path}")
            return
        obj_files = glob_module.glob(os.path.join(export_dir, "*.obj"))
        if not obj_files:
            print("[Converter][Crop] OBJ 파일 없음 — 크롭 건너뜀")
            return

        center = np.array(obb_params.get("center", [0, 0, 0]), dtype=np.float64)
        scale  = np.array(obb_params.get("scale",  [1, 1, 1]), dtype=np.float64)
        half   = scale / 2.0
        bounds_min = center - half
        bounds_max = center + half

        obj_path = obj_files[0]
        mesh = trimesh.load(obj_path, process=False)

        # Scene인 경우 geometry 합치기
        if isinstance(mesh, trimesh.Scene):
            geoms = [g for g in mesh.geometry.values() if isinstance(g, trimesh.Trimesh)]
            if not geoms:
                print("[Converter][Crop] 크롭 가능한 메시 없음")
                return
            mesh = trimesh.util.concatenate(geoms)

        # 범위 내 버텍스만 남기기
        in_bounds = np.all((mesh.vertices >= bounds_min) & (mesh.vertices <= bounds_max), axis=1)
        face_mask = np.all(in_bounds[mesh.faces], axis=1)

        kept = int(face_mask.sum())
        total = len(mesh.faces)
        print(f"[Converter][Crop] 크롭 결과: {kept}/{total} faces 유지")

        if kept == 0:
            print("[Converter][Crop] 크롭 결과가 비어있음 — 원본 메시 유지")
            return

        mesh.update_faces(face_mask)
        mesh.remove_unreferenced_vertices()
        mesh.export(obj_path)
        print(f"[Converter][Crop] OBJ 크롭 완료 → {obj_path}")
    except Exception as e:
        print(f"[Converter][Crop] 크롭 실패, 원본 유지: {e}")


def _crop_exported_mesh_v2(export_dir: str, obb_params: dict):
    """Crop the exported mesh using preview-space OBB data with bbox-aware fallback."""
    try:
        mesh_path, mesh = _load_mesh_for_crop(export_dir)
        if not mesh_path:
            print("[Converter][Crop] no OBJ/PLY file found")
            return
        if mesh is None:
            print("[Converter][Crop] no crop-capable mesh found")
            return
        if mesh.is_empty or len(mesh.vertices) == 0 or len(mesh.faces) == 0:
            print("[Converter][Crop] empty mesh, keeping original")
            return

        center = np.array(obb_params.get("center", [0, 0, 0]), dtype=np.float64)
        rotation = np.array(obb_params.get("rotation", [0, 0, 0]), dtype=np.float64)
        scale = np.abs(np.array(obb_params.get("scale", [1, 1, 1]), dtype=np.float64))
        preview_center_raw = obb_params.get("previewCenter")
        preview_center = np.array(preview_center_raw, dtype=np.float64) if preview_center_raw is not None else None
        preview_bounds_raw = obb_params.get("previewBounds")
        preview_bounds = np.abs(np.array(preview_bounds_raw, dtype=np.float64)) if preview_bounds_raw is not None else None
        mesh_center, mesh_extents = _compute_mesh_bbox(mesh)

        candidates: list[tuple[str, np.ndarray, np.ndarray, int]] = []
        axis_ratio = None
        if preview_center is not None:
            candidates.append(("preview_center_raw", center + preview_center, scale, 0))
        if preview_bounds is not None and np.all(preview_bounds > 1e-6):
            axis_ratio = mesh_extents / np.maximum(preview_bounds, np.full(3, 1e-6, dtype=np.float64))
            candidates.append(("mesh_bbox_axis", mesh_center + center * axis_ratio, scale * axis_ratio, 0))

            uniform_ratio = float(np.max(mesh_extents) / max(float(np.max(preview_bounds)), 1e-6))
            uniform_vec = np.full(3, uniform_ratio, dtype=np.float64)
            candidates.append(("mesh_bbox_uniform", mesh_center + center * uniform_vec, scale * uniform_vec, 1))
        candidates.append(("mesh_center_translate", mesh_center + center, scale, 2))

        deduped_candidates: list[tuple[str, np.ndarray, np.ndarray, int]] = []
        seen = set()
        for strategy, world_center, candidate_scale, tier in candidates:
            key = tuple(np.round(np.concatenate([world_center, candidate_scale]), 6))
            if key in seen:
                continue
            seen.add(key)
            deduped_candidates.append((strategy, world_center, candidate_scale, tier))

        total = int(len(mesh.faces))
        best_by_tier: dict[int, tuple[str, object, dict]] = {}
        for strategy, world_center, candidate_scale, tier in deduped_candidates:
            clipped = _clip_mesh_with_obb(mesh, world_center, rotation, candidate_scale)
            metrics = _score_mesh_crop_candidate(clipped, total, candidate_scale, strategy)
            kept = 0 if metrics is None else metrics["kept"]
            print(
                "[Converter][Crop] OBB clip attempt:"
                f" strategy={strategy}, requestedCenter={center.tolist()},"
                f" worldCenter={world_center.tolist()},"
                f" previewCenter={(preview_center.tolist() if preview_center is not None else None)},"
                f" previewBounds={(preview_bounds.tolist() if preview_bounds is not None else None)},"
                f" meshExtents={mesh_extents.tolist()},"
                f" axisRatio={(axis_ratio.tolist() if axis_ratio is not None else None)},"
                f" scale={candidate_scale.tolist()}, rotation={rotation.tolist()},"
                f" kept={kept}/{total},"
                f" fillMean={(None if metrics is None else round(metrics['fillMean'], 4))},"
                f" score={(None if metrics is None else round(metrics['score'], 4))}"
            )

            if metrics is None:
                continue

            current = best_by_tier.get(tier)
            if current is None or metrics["score"] > current[2]["score"]:
                best_by_tier[tier] = (strategy, clipped, metrics)

        if not best_by_tier:
            print("[Converter][Crop] empty crop result, keeping original mesh")
            return

        chosen_tier = min(best_by_tier)
        strategy, clipped, metrics = best_by_tier[chosen_tier]
        kept = metrics["kept"]
        if chosen_tier > 0:
            print(f"[Converter][Crop] fallback strategy tier selected: tier={chosen_tier}, strategy={strategy}")
        clipped.export(mesh_path)
        print(
            f"[Converter][Crop] mesh clip complete: {mesh_path} "
            f"(strategy={strategy}, tier={chosen_tier}, kept={kept}/{total}, score={metrics['score']:.4f})"
        )
    except Exception as e:
        print(f"[Converter][Crop] crop failed, keeping original mesh: {e}")


def _mesh_from_colmap(processed_dir: str, output_dir: str, report, obb_params: dict | None = None, stop_check=None) -> str:
    """COLMAP 결과로 nerfacto 학습 후 Poisson 메시 추출 → OBJ ZIP 또는 GLB"""
    train_dir  = os.path.join(output_dir, "train")
    export_dir = os.path.join(output_dir, "export")
    os.makedirs(export_dir, exist_ok=True)

    print("[Converter][Mesh from COLMAP] nerfacto → poisson mesh 추출...")
    _run_cmd(
        [
            "ns-train", "nerfacto",
            "--data", processed_dir,
            "--output-dir", train_dir,
            "--max-num-iterations", "15000",
            "--pipeline.model.predict-normals", "True",
            "--pipeline.model.implementation", "tcnn",
            "--viewer.quit-on-train-completion", "True",
        ],
        report_range=(0, 80), report_fn=report, stop_check=stop_check,
    )
    report(80)

    config_path = _find_nerfstudio_config(train_dir)
    _run_cmd(
        [
            "ns-export", "poisson",
            "--load-config", config_path,
            "--output-dir", export_dir,
            "--num-points", "300000",
            "--target-num-faces", "50000",
            "--texture-method", "nerf",
        ],
        report_range=(80, 92), report_fn=report,
        timeout=1800, stop_check=stop_check,
    )

    if obb_params:
        _crop_exported_mesh_v2(export_dir, obb_params)
    report(95)

    obj_files = glob_module.glob(os.path.join(export_dir, "*.obj"))
    if obj_files:
        all_files = [f for f in glob_module.glob(os.path.join(export_dir, "*")) if os.path.isfile(f)]
        zip_path = os.path.join(output_dir, "output.zip")
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for fpath in all_files:
                zf.write(fpath, os.path.basename(fpath))
        report(99)
        print(f"[Converter][Mesh from COLMAP] OBJ+텍스처 ZIP 완료 → {zip_path}")
        return zip_path

    mesh_ply    = os.path.join(export_dir, "mesh.ply")
    output_path = os.path.join(output_dir, "output.glb")
    if os.path.exists(mesh_ply):
        try:
            import trimesh
            trimesh.load(mesh_ply).export(output_path)
        except Exception as e:
            print(f"[Converter][Mesh from COLMAP] GLB 변환 실패: {e}")
            output_path = os.path.join(output_dir, "output.ply")
            shutil.copy(mesh_ply, output_path)
    else:
        glbs = glob_module.glob(os.path.join(export_dir, "*.glb"))
        if glbs:
            shutil.copy(glbs[0], output_path)
        else:
            raise FileNotFoundError("Mesh from COLMAP: 내보내기 결과 없음")

    report(99)
    print(f"[Converter][Mesh from COLMAP] 완료 → {output_path}")
    return output_path


# ══════════════════════════════════════════════════════════════════
# MESH 변환
# ══════════════════════════════════════════════════════════════════
CAD_EXTS = {".step", ".stp", ".iges", ".igs", ".brep"}

def _convert_cad_to_mesh_files(input_path: str, output_dir: str, ext: str, report) -> dict:
    """
    CAD 포맷(STEP/IGES/BREP) → STL + OBJ 직접 변환 (cadquery 사용)
    tolerance는 모델 바운딩박스 대각선의 0.2% 로 자동 계산 (형상 보존 + 면 수 균형)
    반환: {'stl': path, 'obj': path}
    """
    try:
        import cadquery as cq
        report(15)
        if ext in (".step", ".stp"):
            shape = cq.importers.importStep(input_path)
        elif ext in (".iges", ".igs"):
            shape = cq.importers.importStep(input_path)
        elif ext == ".brep":
            from OCC.Core.BRep import BRep_Builder
            from OCC.Core.BRepTools import breptools_Read
            from OCC.Core.TopoDS import TopoDS_Shape
            shape_occ = TopoDS_Shape()
            breptools_Read(shape_occ, input_path, BRep_Builder())
            shape = cq.Shape(shape_occ)
        else:
            raise ValueError(f"지원하지 않는 CAD 포맷: {ext}")
        report(30)

        # 바운딩박스 기반 adaptive tolerance 계산
        try:
            bb = shape.val().BoundingBox()
            diag = ((bb.xmax - bb.xmin)**2 + (bb.ymax - bb.ymin)**2 + (bb.zmax - bb.zmin)**2) ** 0.5
            tolerance = max(0.005, diag * 0.0005)  # 대각선의 0.05%, 최소 0.005
        except Exception:
            tolerance = 0.1
        angular_tolerance = 0.15  # ~8.6도, 곡면 품질과 면 수의 균형
        print(f"[Converter][Mesh] CAD 바운딩박스 대각선={diag:.1f}, tolerance={tolerance:.4f}, angularTol={angular_tolerance}")

        stl_path = os.path.join(output_dir, "output.stl")
        cq.exporters.export(shape, stl_path, exportType=cq.exporters.ExportTypes.STL,
                            tolerance=tolerance, angularTolerance=angular_tolerance)
        report(60)
        print(f"[Converter][Mesh] CAD → STL 완료 (tolerance={tolerance:.4f})")

        # STL → crease angle 기반 정점 병합 → OBJ / GLB / PLY
        # merge_vertices()는 sharp edge까지 뭉개므로 사용 안 함
        # 대신 face_normals 기준으로 이미 cadquery STL에 올바른 법선이 있음
        obj_path = os.path.join(output_dir, "output.obj")
        try:
            import trimesh as _trimesh
            import numpy as np
            _mesh = _trimesh.load(stl_path, force="mesh")
            # STL의 face normal을 그대로 유지하면서 smooth/sharp 경계 보존
            # crease_angle=30°: 30° 이하로 만나는 면은 smooth, 이상은 sharp edge 유지
            _mesh = _trimesh.graph.smoothed(_mesh, angle=np.radians(30))
            _mesh.export(obj_path)
            report(70)
            print(f"[Converter][Mesh] STL → OBJ (crease 30°) 완료: {len(_mesh.faces)}면")
        except Exception as e:
            print(f"[Converter][Mesh] OBJ 변환 실패: {e}")
            obj_path = stl_path

        return {"stl": stl_path, "obj": obj_path}
    except ImportError:
        raise RuntimeError(
            "cadquery가 설치되지 않았습니다. Docker 이미지를 재빌드하세요.\n"
            "  docker compose build worker"
        )


def _convert_mesh(input_path: str, output_dir: str, ext: str, report) -> str:
    output_path = os.path.join(output_dir, "output.glb")
    report(5)

    if ext in (".glb", ".gltf"):
        shutil.copy(input_path, output_path)
        report(95)
        return output_path

    # PLY 포인트 클라우드 → Poisson Surface Reconstruction → GLB
    if ext == ".ply":
        print("[Converter][Mesh] PLY 감지 → Poisson Surface Reconstruction 실행")
        return poisson_to_mesh(input_path, output_dir, progress_callback=report)

    # CAD 포맷: cadquery로 직접 STL+OBJ 변환 → trimesh로 GLB+PLY 추가 → ZIP
    if ext in CAD_EXTS:
        print(f"[Converter][Mesh] CAD 포맷 감지 ({ext}) → cadquery 변환 중...")
        cad_files = _convert_cad_to_mesh_files(input_path, output_dir, ext, report)
        stl_path = cad_files["stl"]
        obj_path = cad_files["obj"]
        report(75)
        glb_path = os.path.join(output_dir, "output.glb")
        ply_path = os.path.join(output_dir, "output.ply")
        try:
            import trimesh
            import numpy as np
            # STL로 로드 (OBJ보다 법선 계산이 안정적)
            mesh = trimesh.load(stl_path, force="mesh")
            if isinstance(mesh, trimesh.Trimesh) and len(mesh.faces) > 0:
                # crease angle 30°: 곡면은 smooth, 모서리는 sharp 유지
                mesh = trimesh.graph.smoothed(mesh, angle=np.radians(30))
                # 정점 법선 명시적 계산 (CloudCompare 조명 렌더링에 필수)
                mesh.vertex_normals  # trimesh lazy property 강제 계산
                print(f"[Converter][Mesh] GLB/PLY 변환: {len(mesh.faces)}면, 법선 포함")
                mesh.export(glb_path)
                # PLY에 법선 명시적 포함
                mesh.export(ply_path, vertex_normal=True)
            else:
                raise ValueError("유효한 메시 없음")
        except Exception as e:
            print(f"[Converter][Mesh] GLB/PLY 변환 실패 (STL fallback): {e}")
            glb_path = stl_path
            ply_path = stl_path
        report(92)
        zip_path = os.path.join(output_dir, "output.zip")
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            zf.write(glb_path, "output.glb")   # 웹 뷰어용
            zf.write(obj_path, "output.obj")   # CloudCompare 등 외부 툴용
            zf.write(stl_path, "output.stl")   # 3D 프린팅용
            zf.write(ply_path, "output.ply")   # 포인트 클라우드 툴용
        report(95)
        print(f"[Converter][Mesh] CAD → GLB+OBJ+STL+PLY ZIP 완료 → {zip_path}")
        return zip_path

    try:
        import trimesh
        report(15)
        scene_or_mesh = trimesh.load(input_path, force="scene")
        report(85)
        if isinstance(scene_or_mesh, trimesh.Scene):
            if len(scene_or_mesh.geometry) == 0:
                raise ValueError("빈 씬: 지오메트리 없음")
        else:
            scene_or_mesh = scene_or_mesh.scene()
        scene_or_mesh.export(output_path)
        report(95)
        return output_path
    except ImportError:
        print("[Converter][Mesh] trimesh 미설치 — 복사 fallback")
    except Exception as e:
        print(f"[Converter][Mesh] trimesh 실패: {e} — 복사 fallback")

    fallback = os.path.join(output_dir, f"output{ext}")
    shutil.copy(input_path, fallback)
    report(95)
    return fallback


# ══════════════════════════════════════════════════════════════════
# POINT CLOUD 변환
# ══════════════════════════════════════════════════════════════════
def _convert_point_cloud(input_path: str, output_dir: str, ext: str, report) -> str:
    output_path = os.path.join(output_dir, "output.ply")
    report(5)

    if ext == ".ply":
        shutil.copy(input_path, output_path)
        report(95)
        return output_path

    if ext in (".glb", ".gltf", ".obj", ".stl", ".dae", ".off"):
        try:
            return _mesh_to_point_cloud(input_path, output_path, report)
        except Exception as e:
            print(f"[Converter][PointCloud] 메시 샘플링 실패: {e}")

    if ext in (".las", ".laz"):
        try:
            return _las_to_ply(input_path, output_path, report)
        except Exception as e:
            print(f"[Converter][PointCloud] laspy 실패: {e}")

    if ext in (".xyz", ".pts", ".txt"):
        try:
            return _xyz_to_ply(input_path, output_path, report)
        except Exception as e:
            print(f"[Converter][PointCloud] XYZ 파서 실패: {e}")

    if ext == ".pcd":
        try:
            return _pcd_to_ply(input_path, output_path, report)
        except Exception as e:
            print(f"[Converter][PointCloud] PCD 파서 실패: {e}")

    out = os.path.join(output_dir, f"output{ext}")
    shutil.copy(input_path, out)
    report(95)
    return out


def _mesh_to_point_cloud(input_path: str, output_path: str, report, num_points: int = 200_000) -> str:
    import trimesh
    report(15)
    loaded = trimesh.load(input_path, force="scene")
    report(30)
    if isinstance(loaded, trimesh.Scene):
        meshes = [g for g in loaded.geometry.values() if isinstance(g, trimesh.Trimesh)]
        if not meshes:
            raise ValueError("씬 내 메시 없음")
        mesh = trimesh.util.concatenate(meshes)
    elif isinstance(loaded, trimesh.Trimesh):
        mesh = loaded
    else:
        raise ValueError(f"지원되지 않는 타입: {type(loaded)}")
    report(45)
    points, face_idx = trimesh.sample.sample_surface(mesh, num_points)
    report(70)
    has_color = (mesh.visual is not None and
                 hasattr(mesh.visual, "vertex_colors") and
                 mesh.visual.vertex_colors is not None and
                 len(mesh.visual.vertex_colors) == len(mesh.vertices))
    if has_color:
        face_verts = mesh.faces[face_idx]
        vc = mesh.visual.vertex_colors[:, :3]
        r = vc[face_verts[:, 0], 0].astype(np.uint8)
        g = vc[face_verts[:, 0], 1].astype(np.uint8)
        b = vc[face_verts[:, 0], 2].astype(np.uint8)
        _write_ply_binary(output_path, points[:, 0], points[:, 1], points[:, 2], r, g, b)
    else:
        _write_ply_binary(output_path, points[:, 0], points[:, 1], points[:, 2])
    report(95)
    return output_path


def _las_to_ply(input_path: str, output_path: str, report) -> str:
    import laspy
    report(15)
    las = laspy.read(input_path)
    report(40)
    x = np.array(las.x, dtype=np.float32)
    y = np.array(las.y, dtype=np.float32)
    z = np.array(las.z, dtype=np.float32)
    has_rgb = all(hasattr(las, c) for c in ("red", "green", "blue"))
    if has_rgb:
        r = np.array(las.red,   dtype=np.uint8)
        g = np.array(las.green, dtype=np.uint8)
        b = np.array(las.blue,  dtype=np.uint8)
        if r.max() > 255:
            r = (r / 256).astype(np.uint8)
            g = (g / 256).astype(np.uint8)
            b = (b / 256).astype(np.uint8)
    report(60)
    _write_ply_binary(output_path, x, y, z,
                      r if has_rgb else None,
                      g if has_rgb else None,
                      b if has_rgb else None)
    report(95)
    return output_path


def _xyz_to_ply(input_path: str, output_path: str, report) -> str:
    report(10)
    data = []
    with open(input_path, "r", errors="ignore") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or line.startswith("//"):
                continue
            parts = line.replace(",", " ").split()
            if len(parts) >= 3:
                try:
                    data.append([float(p) for p in parts[:6]])
                except ValueError:
                    continue
    if not data:
        raise ValueError("포인트 없음")
    report(50)
    arr = np.array(data, dtype=np.float32)
    x, y, z = arr[:, 0], arr[:, 1], arr[:, 2]
    if arr.shape[1] >= 6:
        _write_ply_binary(output_path, x, y, z,
                          arr[:, 3].astype(np.uint8),
                          arr[:, 4].astype(np.uint8),
                          arr[:, 5].astype(np.uint8))
    else:
        _write_ply_binary(output_path, x, y, z)
    report(95)
    return output_path


def _pcd_to_ply(input_path: str, output_path: str, report) -> str:
    report(10)
    with open(input_path, "rb") as f:
        header = {}
        data_start = 0
        for _ in range(50):
            line = f.readline().decode("ascii", errors="ignore").strip()
            data_start += len(line) + 1
            if line.startswith("DATA"):
                header["DATA"] = line.split()[-1]
                break
            key, *vals = line.split()
            header[key] = vals
    n_points = int(header.get("POINTS", [0])[0])
    fields   = header.get("FIELDS", [])
    sizes    = [int(s) for s in header.get("SIZE",  [])]
    data_fmt = header.get("DATA", "ascii")
    xi = fields.index("x") if "x" in fields else 0
    yi = fields.index("y") if "y" in fields else 1
    zi = fields.index("z") if "z" in fields else 2
    report(20)
    if data_fmt == "ascii":
        data = []
        with open(input_path, "r", errors="ignore") as f:
            in_data = False
            for line in f:
                if in_data:
                    parts = line.strip().split()
                    if len(parts) > max(xi, yi, zi):
                        data.append([float(parts[xi]), float(parts[yi]), float(parts[zi])])
                elif line.startswith("DATA"):
                    in_data = True
        arr = np.array(data, dtype=np.float32)
    else:
        row_size = sum(sizes)
        with open(input_path, "rb") as f:
            f.read(data_start)
            raw = f.read(n_points * row_size)
        arr = np.frombuffer(raw, dtype=np.float32).reshape(n_points, len(fields))
    report(60)
    _write_ply_binary(output_path, arr[:, xi], arr[:, yi], arr[:, zi])
    report(95)
    return output_path


# ══════════════════════════════════════════════════════════════════
# POISSON SURFACE RECONSTRUCTION  (PLY → GLB)
# ══════════════════════════════════════════════════════════════════
def poisson_to_mesh(input_ply: str, output_dir: str, progress_callback=None,
                    depth: int = 9, normal_radius_factor: float = 0.05,
                    normal_max_nn: int = 30) -> str:
    """
    Open3D Poisson Surface Reconstruction 으로 포인트 클라우드 PLY → GLB 변환.

    단계:
      1. PLY 로드 → 법선 추정 → Poisson 재구성 → 저밀도 면 제거
      2. trimesh 로 GLB 내보내기
    반환: GLB 파일 경로
    """
    def report(pct: int):
        if progress_callback:
            progress_callback(min(pct, 99))

    try:
        import open3d as o3d
    except ImportError:
        raise RuntimeError(
            "open3d 미설치. 'pip install open3d' 후 재시도하세요."
        )

    try:
        import trimesh
    except ImportError:
        raise RuntimeError(
            "trimesh 미설치. 'pip install trimesh' 후 재시도하세요."
        )

    os.makedirs(output_dir, exist_ok=True)
    output_glb = os.path.join(output_dir, "output.glb")

    # ── 1. PLY 로드 ─────────────────────────────────────────────────
    report(5)
    print(f"[Converter][PSR] PLY 로드: {input_ply}")
    pcd = o3d.io.read_point_cloud(input_ply)
    n_pts = len(pcd.points)
    if n_pts == 0:
        raise ValueError("포인트 클라우드가 비어 있습니다.")
    print(f"[Converter][PSR] 포인트 수: {n_pts:,}")
    report(10)

    # ── 2. 법선 추정 ────────────────────────────────────────────────
    print("[Converter][PSR] 법선 추정 중...")
    bbox   = pcd.get_axis_aligned_bounding_box()
    extent = bbox.get_extent()
    radius = float(np.max(extent)) * normal_radius_factor
    pcd.estimate_normals(
        search_param=o3d.geometry.KDTreeSearchParamHybrid(
            radius=radius, max_nn=normal_max_nn
        )
    )
    pcd.orient_normals_consistent_tangent_plane(100)
    report(30)

    # ── 3. Poisson Surface Reconstruction ───────────────────────────
    print(f"[Converter][PSR] Poisson 재구성 (depth={depth})...")
    mesh, densities = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(
        pcd, depth=depth, width=0, scale=1.1, linear_fit=False
    )
    report(70)

    # ── 4. 저밀도 영역(아티팩트) 제거 ───────────────────────────────
    print("[Converter][PSR] 저밀도 면 제거 중...")
    densities_np = np.asarray(densities)
    threshold    = np.quantile(densities_np, 0.05)  # 하위 5% 제거
    vertices_to_remove = densities_np < threshold
    mesh.remove_vertices_by_mask(vertices_to_remove)
    mesh.compute_vertex_normals()
    report(80)

    # ── 5. 포인트 색상을 메시에 전달 (벡터화 KNN) ──────────────────
    if pcd.has_colors():
        print("[Converter][PSR] 포인트 색상 → 메시 정점 색상 전달 중...")
        pcd_pts = np.asarray(pcd.points)
        pcd_colors = np.asarray(pcd.colors)
        mesh_verts = np.asarray(mesh.vertices)
        # sklearn 없이 numpy 브로드캐스트로 nearest-neighbor (메모리 절약: 청크 처리)
        chunk = 4096
        nn_indices = np.empty(len(mesh_verts), dtype=np.int64)
        for start in range(0, len(mesh_verts), chunk):
            end = min(start + chunk, len(mesh_verts))
            diff = pcd_pts[np.newaxis, :, :] - mesh_verts[start:end, np.newaxis, :]  # (chunk, N, 3)
            dists = np.sum(diff ** 2, axis=-1)  # (chunk, N)
            nn_indices[start:end] = np.argmin(dists, axis=-1)
        mesh.vertex_colors = o3d.utility.Vector3dVector(pcd_colors[nn_indices])
    report(85)

    # ── 6. Open3D → trimesh → GLB 내보내기 ──────────────────────────
    print("[Converter][PSR] GLB 내보내기 중...")
    verts   = np.asarray(mesh.vertices)
    faces   = np.asarray(mesh.triangles)
    normals = np.asarray(mesh.vertex_normals) if mesh.has_vertex_normals() else None
    colors_arr = (np.asarray(mesh.vertex_colors) * 255).astype(np.uint8) if mesh.has_vertex_colors() else None

    tm = trimesh.Trimesh(
        vertices=verts,
        faces=faces,
        vertex_normals=normals,
        vertex_colors=colors_arr,
        process=False,
    )
    tm.export(output_glb)
    report(99)
    print(f"[Converter][PSR] 완료 → {output_glb}  ({len(faces):,} 면)")
    return output_glb


def _write_ply_binary(output_path: str, x, y, z, r=None, g=None, b=None):
    n = len(x)
    has_color = r is not None
    with open(output_path, "wb") as f:
        header = "ply\nformat binary_little_endian 1.0\n"
        header += f"element vertex {n}\n"
        header += "property float x\nproperty float y\nproperty float z\n"
        if has_color:
            header += "property uchar red\nproperty uchar green\nproperty uchar blue\n"
        header += "end_header\n"
        f.write(header.encode("ascii"))
        x = np.asarray(x, dtype=np.float32)
        y = np.asarray(y, dtype=np.float32)
        z = np.asarray(z, dtype=np.float32)
        if has_color:
            r = np.asarray(r, dtype=np.uint8)
            g = np.asarray(g, dtype=np.uint8)
            b = np.asarray(b, dtype=np.uint8)
            data = np.zeros(n, dtype=[
                ("x", "<f4"), ("y", "<f4"), ("z", "<f4"),
                ("r", "u1"),  ("g", "u1"),  ("b", "u1"),
            ])
            data["x"], data["y"], data["z"] = x, y, z
            data["r"], data["g"], data["b"] = r, g, b
        else:
            data = np.zeros(n, dtype=[("x", "<f4"), ("y", "<f4"), ("z", "<f4")])
            data["x"], data["y"], data["z"] = x, y, z
        f.write(data.tobytes())


# ── NerfStudio 헬퍼 ───────────────────────────────────────────────
class CommandTimeoutError(RuntimeError):
    pass


def _run_cmd(cmd: list, report_range: tuple, report_fn, timeout: int = 7200, stop_check=None):
    import threading
    start_pct, end_pct = report_range
    print(f"[Converter] 실행: {' '.join(cmd)}")
    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
    )
    step_pattern = re.compile(r"Step.*?(\d+)/(\d+)")
    stopped_by_deletion = [False]

    def _read_stdout():
        for line in proc.stdout:
            line = line.rstrip()
            if line:
                print(f"  [ns] {line}")
            m = step_pattern.search(line)
            if m:
                cur, total = int(m.group(1)), int(m.group(2))
                if total > 0:
                    ratio = cur / total
                    pct = int(start_pct + ratio * (end_pct - start_pct))
                    report_fn(pct)

    def _monitor():
        while proc.poll() is None:
            time.sleep(3)
            try:
                if stop_check and stop_check():
                    print("[Converter] 에셋 삭제 감지 — 프로세스 강제 종료")
                    stopped_by_deletion[0] = True
                    proc.kill()
                    return
            except Exception:
                pass

    reader  = threading.Thread(target=_read_stdout, daemon=True)
    monitor = threading.Thread(target=_monitor,     daemon=True)
    reader.start()
    monitor.start()

    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        reader.join(timeout=5)
        raise CommandTimeoutError(f"명령 타임아웃 ({timeout}초 초과): {' '.join(cmd)}")

    reader.join()

    if stopped_by_deletion[0]:
        raise RuntimeError("__asset_deleted__")
    if proc.returncode != 0:
        raise RuntimeError(f"명령 실패 (exit {proc.returncode}): {' '.join(cmd)}")


def _find_nerfstudio_config(train_dir: str) -> str:
    configs = sorted(glob_module.glob(os.path.join(train_dir, "**", "config.yml"), recursive=True))
    if not configs:
        raise FileNotFoundError(f"config.yml 없음: {train_dir}")
    return max(configs, key=os.path.getmtime)


def _extract_frames_from_video(video_path: str, output_dir: str, report,
                                start: int, end: int, fps: int = 2) -> int:
    try:
        import cv2
        cap = cv2.VideoCapture(video_path)
        video_fps    = cap.get(cv2.CAP_PROP_FPS) or 30
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        interval = max(1, int(video_fps / fps))
        count, frame_idx = 0, 0
        while cap.isOpened():
            ret, frame = cap.read()
            if not ret:
                break
            if frame_idx % interval == 0:
                cv2.imwrite(os.path.join(output_dir, f"frame_{count:06d}.jpg"), frame)
                count += 1
                if total_frames > 0:
                    pct = start + int((frame_idx / total_frames) * (end - start))
                    report(pct)
            frame_idx += 1
        cap.release()
        return count
    except Exception as e:
        print(f"[Converter] 프레임 추출 실패: {e}")
        return 0


def _extract_images_from_zip(zip_path: str, output_dir: str, report,
                              start: int, end: int) -> int:
    IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
    count = 0
    try:
        with zipfile.ZipFile(zip_path, "r") as zf:
            members = [m for m in zf.namelist()
                       if os.path.splitext(m)[-1].lower() in IMAGE_EXTS
                       and not os.path.basename(m).startswith(".")]
            total = len(members)
            for i, member in enumerate(sorted(members)):
                ext = os.path.splitext(member)[-1].lower()
                dest = os.path.join(output_dir, f"frame_{count:06d}{ext}")
                with zf.open(member) as src, open(dest, "wb") as dst:
                    dst.write(src.read())
                count += 1
                if total > 0:
                    pct = start + int((i / total) * (end - start))
                    report(pct)
    except Exception as e:
        print(f"[Converter] ZIP 추출 실패: {e}")
    return count
def _normalize_mesh_profile(output_profile: str | None) -> str:
    if output_profile == "mesh_interop_bundle":
        return "mesh_interop_bundle"
    return "mesh_glb"


def _coerce_scene_and_mesh(scene_or_mesh):
    import trimesh

    if isinstance(scene_or_mesh, trimesh.Scene):
        if len(scene_or_mesh.geometry) == 0:
            raise ValueError("empty mesh scene")
        dumped = scene_or_mesh.dump(concatenate=True)
        if isinstance(dumped, trimesh.Trimesh):
            mesh = dumped
        else:
            meshes = [g for g in dumped if isinstance(g, trimesh.Trimesh)]
            if not meshes:
                raise ValueError("no mesh geometry found")
            mesh = trimesh.util.concatenate(meshes)
        return scene_or_mesh, mesh

    if isinstance(scene_or_mesh, trimesh.Trimesh):
        return scene_or_mesh.scene(), scene_or_mesh

    raise ValueError(f"unsupported mesh payload: {type(scene_or_mesh)}")


def _write_mesh_interop_bundle(scene_or_mesh, output_dir: str, report=None) -> str:
    scene, mesh = _coerce_scene_and_mesh(scene_or_mesh)
    glb_path = os.path.join(output_dir, "output.glb")
    obj_path = os.path.join(output_dir, "output.obj")
    stl_path = os.path.join(output_dir, "output.stl")
    ply_path = os.path.join(output_dir, "output.ply")

    scene.export(glb_path)
    mesh.export(obj_path)
    mesh.export(stl_path)
    mesh.export(ply_path, vertex_normal=True)

    if report:
        report(92)

    zip_path = os.path.join(output_dir, "output.zip")
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.write(glb_path, "output.glb")
        zf.write(obj_path, "output.obj")
        zf.write(stl_path, "output.stl")
        zf.write(ply_path, "output.ply")
    return zip_path


def _mesh_from_colmap(processed_dir: str, output_dir: str, report, output_profile: str | None = None, obb_params: dict | None = None, stop_check=None) -> str:
    train_dir = os.path.join(output_dir, "train")
    export_dir = os.path.join(output_dir, "export")
    profile = _normalize_mesh_profile(output_profile)
    os.makedirs(export_dir, exist_ok=True)

    print("[Converter][Mesh from COLMAP] nerfacto -> poisson mesh export")
    _run_cmd(
        [
            "ns-train", "nerfacto",
            "--data", processed_dir,
            "--output-dir", train_dir,
            "--max-num-iterations", "8000",
            "--pipeline.model.predict-normals", "True",
            "--pipeline.model.implementation", "tcnn",
            "--viewer.quit-on-train-completion", "True",
        ],
        report_range=(0, 80), report_fn=report, stop_check=stop_check,
    )
    report(80)

    config_path = _find_nerfstudio_config(train_dir)
    export_cmd = [
        "ns-export", "poisson",
        "--load-config", config_path,
        "--output-dir", export_dir,
        "--num-points", "300000",
        "--target-num-faces", "50000",
        "--texture-method", "nerf",
    ]
    export_obb = _resolve_export_obb(obb_params)
    if export_obb is not None:
        export_cmd.extend([
            "--obb-center",
            *[str(v) for v in export_obb["center"].tolist()],
            "--obb-rotation",
            *[str(v) for v in export_obb["rotation_rad"].tolist()],
            "--obb-scale",
            *[str(v) for v in export_obb["scale"].tolist()],
        ])
        print(
            "[Converter][Mesh from COLMAP] export-time OBB crop enabled:"
            f" center={export_obb['center'].tolist()},"
            f" previewCenter={export_obb['preview_center'].tolist()},"
            f" rotationDeg={export_obb['rotation_deg'].tolist()},"
            f" rotationRad={export_obb['rotation_rad'].tolist()},"
            f" scale={export_obb['scale'].tolist()}"
        )
    elif obb_params:
        print("[Converter][Mesh from COLMAP] export-time OBB crop unavailable, falling back to post-export crop")

    _run_cmd(
        export_cmd,
        report_range=(80, 92), report_fn=report,
        timeout=1800, stop_check=stop_check,
    )

    if obb_params and export_obb is None:
        _crop_exported_mesh_v2(export_dir, obb_params)
    report(95)

    obj_files = glob_module.glob(os.path.join(export_dir, "*.obj"))
    if obj_files:
        if profile == "mesh_interop_bundle":
            all_files = [f for f in glob_module.glob(os.path.join(export_dir, "*")) if os.path.isfile(f)]
            zip_path = os.path.join(output_dir, "output.zip")
            with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
                for fpath in all_files:
                    zf.write(fpath, os.path.basename(fpath))
            report(99)
            return zip_path

        try:
            import trimesh

            output_path = os.path.join(output_dir, "output.glb")
            scene_or_mesh = trimesh.load(obj_files[0], force="scene")
            scene, _ = _coerce_scene_and_mesh(scene_or_mesh)
            scene.export(output_path)
            report(99)
            return output_path
        except Exception as e:
            print(f"[Converter][Mesh from COLMAP] OBJ -> GLB export failed: {e}")

    mesh_ply = os.path.join(export_dir, "mesh.ply")
    output_path = os.path.join(output_dir, "output.glb")
    if os.path.exists(mesh_ply):
        try:
            import trimesh

            scene_or_mesh = trimesh.load(mesh_ply, force="scene")
            if profile == "mesh_interop_bundle":
                zip_path = _write_mesh_interop_bundle(scene_or_mesh, output_dir, report=report)
                report(99)
                return zip_path
            scene, _ = _coerce_scene_and_mesh(scene_or_mesh)
            scene.export(output_path)
        except Exception as e:
            print(f"[Converter][Mesh from COLMAP] mesh export failed: {e}")
            output_path = os.path.join(output_dir, "output.ply")
            shutil.copy(mesh_ply, output_path)
    else:
        glbs = glob_module.glob(os.path.join(export_dir, "*.glb"))
        if glbs:
            if profile == "mesh_interop_bundle":
                import trimesh

                scene_or_mesh = trimesh.load(glbs[0], force="scene")
                zip_path = _write_mesh_interop_bundle(scene_or_mesh, output_dir, report=report)
                report(99)
                return zip_path
            shutil.copy(glbs[0], output_path)
        else:
            raise FileNotFoundError("Mesh from COLMAP: no export result found")

    report(99)
    return output_path


def _convert_mesh(input_path: str, output_dir: str, ext: str, report, output_profile: str | None = None) -> str:
    output_path = os.path.join(output_dir, "output.glb")
    profile = _normalize_mesh_profile(output_profile)
    report(5)

    if ext in (".glb", ".gltf"):
        if profile == "mesh_interop_bundle":
            import trimesh

            scene_or_mesh = trimesh.load(input_path, force="scene")
            report(85)
            zip_path = _write_mesh_interop_bundle(scene_or_mesh, output_dir, report=report)
            report(95)
            return zip_path
        shutil.copy(input_path, output_path)
        report(95)
        return output_path

    if ext == ".ply":
        print("[Converter][Mesh] PLY detected -> running Poisson reconstruction")
        glb_path = poisson_to_mesh(input_path, output_dir, progress_callback=report)
        if profile == "mesh_interop_bundle":
            import trimesh

            scene_or_mesh = trimesh.load(glb_path, force="scene")
            zip_path = _write_mesh_interop_bundle(scene_or_mesh, output_dir, report=report)
            report(95)
            return zip_path
        return glb_path

    if ext in CAD_EXTS:
        print(f"[Converter][Mesh] CAD input detected ({ext})")
        cad_files = _convert_cad_to_mesh_files(input_path, output_dir, ext, report)
        stl_path = cad_files["stl"]
        obj_path = cad_files["obj"]
        report(75)
        glb_path = os.path.join(output_dir, "output.glb")
        ply_path = os.path.join(output_dir, "output.ply")
        try:
            import trimesh
            import numpy as np

            mesh = trimesh.load(stl_path, force="mesh")
            if isinstance(mesh, trimesh.Trimesh) and len(mesh.faces) > 0:
                mesh = trimesh.graph.smoothed(mesh, angle=np.radians(30))
                mesh.vertex_normals
                mesh.export(glb_path)
                mesh.export(ply_path, vertex_normal=True)
            else:
                raise ValueError("invalid mesh")
        except Exception as e:
            print(f"[Converter][Mesh] CAD mesh export failed: {e}")
            glb_path = stl_path
            ply_path = stl_path

        if profile == "mesh_interop_bundle":
            report(92)
            zip_path = os.path.join(output_dir, "output.zip")
            with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
                zf.write(glb_path, "output.glb")
                zf.write(obj_path, "output.obj")
                zf.write(stl_path, "output.stl")
                zf.write(ply_path, "output.ply")
            report(95)
            return zip_path

        shutil.copy(glb_path, output_path)
        report(95)
        return output_path

    try:
        import trimesh

        report(15)
        scene_or_mesh = trimesh.load(input_path, force="scene")
        report(85)
        if profile == "mesh_interop_bundle":
            zip_path = _write_mesh_interop_bundle(scene_or_mesh, output_dir, report=report)
            report(95)
            return zip_path

        scene, _ = _coerce_scene_and_mesh(scene_or_mesh)
        scene.export(output_path)
        report(95)
        return output_path
    except ImportError:
        print("[Converter][Mesh] trimesh not installed, falling back to copy")
    except Exception as e:
        print(f"[Converter][Mesh] trimesh conversion failed: {e}, falling back to copy")

    fallback = os.path.join(output_dir, f"output{ext}")
    shutil.copy(input_path, fallback)
    report(95)
    return fallback


def _convert_point_cloud(input_path: str, output_dir: str, ext: str, report, output_profile: str | None = None) -> str:
    output_path = os.path.join(output_dir, "output.ply")
    report(5)

    if ext == ".ply":
        shutil.copy(input_path, output_path)
        report(95)
        return output_path

    if ext in (".glb", ".gltf", ".obj", ".stl", ".dae", ".off"):
        try:
            return _mesh_to_point_cloud(input_path, output_path, report)
        except Exception as e:
            print(f"[Converter][PointCloud] mesh sampling failed: {e}")

    if ext in (".las", ".laz"):
        try:
            return _las_to_ply(input_path, output_path, report)
        except Exception as e:
            print(f"[Converter][PointCloud] laspy failed: {e}")

    if ext in (".xyz", ".pts", ".txt"):
        try:
            return _xyz_to_ply(input_path, output_path, report)
        except Exception as e:
            print(f"[Converter][PointCloud] XYZ parse failed: {e}")

    if ext == ".pcd":
        try:
            return _pcd_to_ply(input_path, output_path, report)
        except Exception as e:
            print(f"[Converter][PointCloud] PCD parse failed: {e}")

    out = os.path.join(output_dir, f"output{ext}")
    shutil.copy(input_path, out)
    report(95)
    return out
