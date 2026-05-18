"""
변환 엔진 - 2단계 파이프라인

1단계 (preprocess_to_fly)
  ZIP/영상 -> 프레임 추출 -> COLMAP SfM -> sparse PLY 미리보기
  결과: previewObject 업로드 직후 미리보기 제공

2단계 (convert_from_processed)
  COLMAP 결과 재사용 -> 풀 트레이닝
  - gaussian    : splatfacto (7000 iter) -> PLY
  - nerf        : nerfacto (15000 iter) -> PNG frame bundle
  - mesh        : nerfacto -> poisson mesh export
  - point_cloud : COLMAP/laspy/numpy -> PLY
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
QUALITY_PRESETS = {
    "fast": {
        "gaussian_iterations": 3000,
        "nerf_iterations": 5000,
        "point_cloud_points": 300000,
        "mesh_sample_points": 300000,
        "mesh_target_faces": 30000,
        "mesh_psr_depth": 7,
    },
    "normal": {
        "gaussian_iterations": 7000,
        "nerf_iterations": 15000,
        "point_cloud_points": 700000,
        "mesh_sample_points": 700000,
        "mesh_target_faces": 50000,
        "mesh_psr_depth": 9,
    },
    "precise": {
        "gaussian_iterations": 15000,
        "nerf_iterations": 30000,
        "point_cloud_points": 1000000,
        "mesh_sample_points": 1000000,
        "mesh_target_faces": 100000,
        "mesh_psr_depth": 11,
    },
}
DEFAULT_QUALITY_PRESET = "fast"
MESH_TEXTURE_SLOTS = (
    "image",
    "baseColorTexture",
    "metallicRoughnessTexture",
    "normalTexture",
    "occlusionTexture",
    "emissiveTexture",
)


class RequiredMeshTextureError(RuntimeError):
    pass


def _normalize_quality_preset(quality_preset: str | None) -> str:
    return quality_preset if quality_preset in QUALITY_PRESETS else DEFAULT_QUALITY_PRESET


def _quality_config(quality_preset: str | None) -> dict:
    return QUALITY_PRESETS[_normalize_quality_preset(quality_preset)]


def _record_generation_quality(metrics_out: dict | None, asset_type: str, quality_preset: str | None):
    if metrics_out is None:
        return

    preset = _normalize_quality_preset(quality_preset)
    cfg = _quality_config(preset)
    spec = {
        "preset": preset,
        "assetType": asset_type,
        "gaussianIterations": cfg["gaussian_iterations"],
        "nerfIterations": cfg["nerf_iterations"],
        "pointCloudPoints": cfg["point_cloud_points"],
        "meshSamplePoints": cfg["mesh_sample_points"],
        "meshTargetFaces": cfg["mesh_target_faces"],
        "meshPsrDepth": cfg["mesh_psr_depth"],
    }
    metrics_out["generationQuality"] = preset
    metrics_out["generationQualitySpec"] = spec
    if asset_type == "gaussian" and preset == "precise":
        metrics_out["generationEvaluationPlan"] = {
            "method": "3D Gaussian PSNR/SSIM precision evaluation",
            "trainingStages": [
                {"name": "base", "iterations": 7000},
                {"name": "opacity_cull_refinement", "iterations": 2000},
                {"name": "scale_regularization_refinement", "iterations": 6000},
            ],
            "metrics": {
                "psnr": "MSE pixel difference with scale-normalized PSNR",
                "ssim": "luminance, contrast, and structural similarity",
            },
        }


# ================================================================
# PUBLIC API
# ================================================================

def preprocess_to_fly(input_path: str, work_dir: str, progress_callback=None, stop_check=None) -> tuple[str | None, str | None]:
    """
    1단계: ZIP/영상 -> COLMAP -> sparse PLY 미리보기
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

    # 1. 프레임 추출
    report(3)
    if ext == ".zip":
        count = _extract_images_from_zip(input_path, frames_dir, report, start=3, end=10)
    elif ext in (".mp4", ".mov", ".avi", ".mkv"):
        count = _extract_frames_from_video(input_path, frames_dir, report, start=3, end=10, fps=2)
    else:
        print(f"[Converter] preprocess_to_fly: 지원하지 않는 포맷 {ext}")
        return None, None

    if count < 10:
        print(f"[Converter] 이미지 부족 ({count}장): 최소 10장 필요")
        return None, None

    print(f"[Converter][Stage1] {count}개 이미지 추출 완료")
    report(10)

    # 2. COLMAP SfM (ns-process-data)
    print("[Converter][Stage1] COLMAP 카메라 캘리브레이션 중...")
    try:
        _run_cmd(
            ["ns-process-data", "images", "--data", frames_dir, "--output-dir", processed_dir],
            report_range=(10, 50), report_fn=report, stop_check=stop_check,
        )
    except Exception as e:
        print(f"[Converter][Stage1] COLMAP 실패: {e}")
        if "__asset_deleted__" in str(e):
            raise
        return None, None

    # 3. COLMAP sparse PLY를 미리보기 파일로 사용
    fly_ply_path = None
    candidate_paths = [
        os.path.join(processed_dir, "colmap", "sparse", "0", "points3D.ply"),
        os.path.join(processed_dir, "sparse", "0", "points3D.ply"),
        os.path.join(processed_dir, "colmap", "sparse", "points3D.ply"),
    ]
    for candidate in candidate_paths:
        if os.path.exists(candidate) and os.path.getsize(candidate) > 0:
            fly_ply_path = candidate
            print(f"[Converter][Stage1] sparse PLY 발견: {candidate}")
            break

    if fly_ply_path is None:
        # COLMAP이 bin만 생성한 경우 PLY 변환 시도
        bin_paths = [
            os.path.join(processed_dir, "colmap", "sparse", "0"),
            os.path.join(processed_dir, "sparse", "0"),
        ]
        for sparse_dir in bin_paths:
            points_bin = os.path.join(sparse_dir, "points3D.bin")
            if os.path.exists(points_bin):
                out_ply = os.path.join(work_dir, "sparse_points.ply")
                try:
                    _colmap_bin_to_ply(points_bin, out_ply)
                    fly_ply_path = out_ply
                    print(f"[Converter][Stage1] bin -> PLY 변환 완료: {out_ply}")
                except Exception as conv_e:
                    print(f"[Converter][Stage1] bin -> PLY 변환 실패: {conv_e}")
                break

    report(54)
    return fly_ply_path, processed_dir


def convert_from_processed(asset_type: str, processed_dir: str, output_dir: str, progress_callback=None, output_profile: str | None = None, obb_params: dict | None = None, quality_preset: str | None = None, stop_check=None, metrics_out: dict | None = None) -> str:
    """
    2단계: COLMAP 결과(processed_dir) -> 풀 트레이닝 또는 포인트클라우드/메시 추출
    obb_params: {"center": [x,y,z], "rotation": [x,y,z], "scale": [x,y,z]} - mesh/nerf 영역 지정용
    metrics_out: 채워질 품질 지표 dict (psnr, ssim) - gaussian/nerf 타입에서 수집
    """
    os.makedirs(output_dir, exist_ok=True)
    quality_preset = _normalize_quality_preset(quality_preset)
    _record_generation_quality(metrics_out, asset_type, quality_preset)

    def report(pct: int):
        if progress_callback:
            progress_callback(55 + min(pct, 44))  # 2단계는 55~99%

    if asset_type in {"gaussian", "nerf", "mesh"}:
        _ensure_processed_image_downscales(processed_dir, stop_check=stop_check)

    if asset_type == "gaussian":
        return _full_gaussian(processed_dir, output_dir, report, obb_params=obb_params, quality_preset=quality_preset, stop_check=stop_check, metrics_out=metrics_out)
    elif asset_type == "nerf":
        return _full_nerf(processed_dir, output_dir, report, obb_params=obb_params, quality_preset=quality_preset, stop_check=stop_check, metrics_out=None)
    elif asset_type == "point_cloud":
        return _point_cloud_from_colmap(processed_dir, output_dir, report, quality_preset=quality_preset, stop_check=stop_check)
    elif asset_type == "mesh":
        return _mesh_from_colmap(processed_dir, output_dir, report, output_profile=output_profile, obb_params=obb_params, quality_preset=quality_preset, stop_check=stop_check, metrics_out=None)
    else:
        raise ValueError(f"convert_from_processed: 지원하지 않는 타입 {asset_type}")


def convert_asset(asset_type: str, input_path: str, output_dir: str, progress_callback=None, output_profile: str | None = None, quality_preset: str | None = None) -> str:
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
        # gaussian / nerf는 ZIP/영상 기반 2단계 파이프라인 전용이다.
        raise ValueError(
            f"'{asset_type}' 타입은 ZIP/영상 입력의 2단계 파이프라인이 필요합니다. "
            f"입력 파일({ext})이 지원되는 형식(zip, mp4, mov, avi, mkv)인지 확인하세요."
        )

    return fn(input_path, output_dir, ext, report, output_profile=output_profile, quality_preset=quality_preset)


# ================================================================
# 2단계 - Gaussian Splatting 풀 트레이닝
# ================================================================
def _full_gaussian(processed_dir: str, output_dir: str, report, obb_params: dict | None = None, quality_preset: str | None = None, stop_check=None, metrics_out: dict | None = None) -> str:
    train_dir  = os.path.join(output_dir, "train")
    export_dir = os.path.join(output_dir, "export")
    os.makedirs(export_dir, exist_ok=True)
    quality_preset = _normalize_quality_preset(quality_preset)
    cfg = _quality_config(quality_preset)
    iterations = cfg["gaussian_iterations"]
    print(f"[Converter][Stage2][3DGS] training quality={quality_preset}, iterations={iterations}")

    def build_train_cmd(out_dir: str, max_iterations: int, load_dir: str | None = None, scale_regularization: bool = False, opacity_entropy: bool = False):
        cmd = [
            "ns-train", "splatfacto",
            "--data", processed_dir,
            "--output-dir", out_dir,
            "--max-num-iterations", str(max_iterations),
            "--pipeline.model.cull-alpha-thresh", "0.005",
            "--pipeline.datamanager.cache-images", "gpu",
            "--viewer.quit-on-train-completion", "True",
        ]
        if load_dir:
            cmd.extend(["--load-dir", load_dir])
        if opacity_entropy:
            cmd.extend(["--pipeline.model.opacity-loss-mult", "0.01"])
        if scale_regularization:
            cmd.extend([
                "--pipeline.model.use-scale-regularization", "True",
                "--pipeline.model.max-gauss-ratio", "10.0",
            ])
        return cmd

    if quality_preset == "precise":
        print("[Converter][Stage2][3DGS] precision plan: 7000 + 2000 + 6000 iterations")
        base_train_dir = os.path.join(output_dir, "train_base")
        opacity_train_dir = os.path.join(output_dir, "train_opacity_refine")
        _run_cmd(
            build_train_cmd(base_train_dir, 7000),
            report_range=(0, 45), report_fn=report, stop_check=stop_check, metrics_out=metrics_out,
        )
        _run_cmd(
            build_train_cmd(opacity_train_dir, 9000, load_dir=_find_nerfstudio_model_dir(base_train_dir), opacity_entropy=True),
            report_range=(45, 58), report_fn=report, stop_check=stop_check, metrics_out=metrics_out,
        )
        _run_cmd(
            build_train_cmd(train_dir, 15000, load_dir=_find_nerfstudio_model_dir(opacity_train_dir), scale_regularization=True),
            report_range=(58, 80), report_fn=report, stop_check=stop_check, metrics_out=metrics_out,
        )
    else:
        print(f"[Converter][Stage2][3DGS] splatfacto training start ({iterations} iter)")
        _run_cmd(
            build_train_cmd(train_dir, iterations),
            report_range=(0, 80), report_fn=report, stop_check=stop_check, metrics_out=metrics_out,
        )
    report(80)

    config_path = _find_nerfstudio_config(train_dir)

    # 품질 지표 수집 (ns-eval) — 정밀 모드에서만 실행
    if metrics_out is not None and quality_preset == "precise":
        import json as _json
        eval_output = os.path.join(output_dir, "eval.json")
        try:
            _run_cmd(
                ["ns-eval", "--load-config", config_path, "--output-path", eval_output],
                report_range=(80, 82), report_fn=report, stop_check=stop_check,
            )
            if os.path.exists(eval_output):
                with open(eval_output) as f:
                    eval_data = _json.load(f)
                results = eval_data.get("results", {})
                print(f"[Converter][3DGS] ns-eval results: {results}")
                if "psnr" in results:
                    metrics_out["psnr"] = round(float(results["psnr"]), 4)
                if "ssim" in results:
                    metrics_out["ssim"] = round(float(results["ssim"]), 6)
        except Exception as e:
            print(f"[Converter][3DGS] ns-eval 실패 (무시): {e}")

    export_cmd = ["ns-export", "gaussian-splat", "--load-config", config_path, "--output-dir", export_dir]
    export_obb = _resolve_export_obb(obb_params, processed_dir)
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
        report_range=(82, 95), report_fn=report, stop_check=stop_check,
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
    print(f"[Converter][Stage2][3DGS] 완료 -> {final}")
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


def _ensure_processed_image_downscales(processed_dir: str, factors: tuple[int, ...] = (2, 4, 8), stop_check=None):
    """
    Ensure Nerfstudio can auto-select a lower image resolution during stage 2.

    Old processed tarballs may only contain the original `images` directory,
    especially from runs made with `ns-process-data --num-downscales 0`.
    Nerfstudio only auto-downscales if `images_2`, `images_4`, ... already
    exist, so create the missing folders before training/export.
    """
    images_dir = os.path.join(processed_dir, "images")
    if not os.path.isdir(images_dir):
        return

    image_paths = _collect_image_files(images_dir)
    if not image_paths:
        return

    try:
        from PIL import Image
    except Exception as e:
        print(f"[Converter][Downscale] Pillow unavailable, using original images only: {e}")
        return

    try:
        with Image.open(image_paths[0]) as sample:
            max_dim = max(sample.size)
    except Exception as e:
        print(f"[Converter][Downscale] sample image inspection failed: {e}")
        return

    needed_factors = [factor for factor in factors if max_dim / factor > 512]
    if not needed_factors:
        return

    resampling = getattr(getattr(Image, "Resampling", Image), "LANCZOS", Image.BICUBIC)
    for factor in needed_factors:
        if stop_check and stop_check():
            raise RuntimeError("__asset_deleted__")

        target_dir = os.path.join(processed_dir, f"images_{factor}")
        existing_count = len(_collect_image_files(target_dir))
        if existing_count >= len(image_paths):
            continue

        os.makedirs(target_dir, exist_ok=True)
        print(
            f"[Converter][Downscale] creating images_{factor} "
            f"({len(image_paths) - existing_count}/{len(image_paths)} missing)"
        )

        for src_path in image_paths:
            if stop_check and stop_check():
                raise RuntimeError("__asset_deleted__")

            dst_path = os.path.join(target_dir, os.path.basename(src_path))
            if os.path.exists(dst_path) and os.path.getsize(dst_path) > 0:
                continue

            with Image.open(src_path) as img:
                width, height = img.size
                next_size = (max(1, width // factor), max(1, height // factor))
                resized = img.resize(next_size, resampling)
                ext = os.path.splitext(dst_path)[1].lower()
                save_kwargs = {}
                if ext in {".jpg", ".jpeg"}:
                    if resized.mode in {"RGBA", "LA", "P"}:
                        resized = resized.convert("RGB")
                    save_kwargs = {"quality": 95, "optimize": True}
                resized.save(dst_path, **save_kwargs)


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
        raise FileNotFoundError("NeRF fallback frame PNG generation failed")

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


# ================================================================
# 2단계 - NeRF 풀 트레이닝
# ================================================================
def _full_nerf(processed_dir: str, output_dir: str, report, obb_params: dict | None = None, quality_preset: str | None = None, stop_check=None, metrics_out: dict | None = None) -> str:
    """
    nerfacto 학습 후 학습 원본 이미지를 PNG 이미지 ZIP으로 출력.
    obb_params는 NeRF 렌더링에서 사용하지 않음.
    """
    train_dir  = os.path.join(output_dir, "train")
    render_dir = os.path.join(output_dir, "render_frames")
    if os.path.isdir(render_dir):
        shutil.rmtree(render_dir)
    os.makedirs(render_dir, exist_ok=True)
    quality_preset = _normalize_quality_preset(quality_preset)
    cfg = _quality_config(quality_preset)
    iterations = cfg["nerf_iterations"]

    images_dir = os.path.join(processed_dir, "images")
    if not os.path.isdir(images_dir):
        images_dir = processed_dir
    image_paths = _collect_image_files(images_dir)
    num_train_images = len(image_paths)
    print(f"[Converter][Stage2][NeRF] training images: {num_train_images}")

    print(f"[Converter][Stage2][NeRF] training start (nerfacto {iterations} iter, tcnn, quality={quality_preset})")
    _run_cmd(
        [
            "ns-train", "nerfacto",
            "--data", processed_dir,
            "--output-dir", train_dir,
            "--max-num-iterations", str(iterations),
            "--pipeline.model.implementation", "tcnn",
            "--viewer.quit-on-train-completion", "True",
        ],
        report_range=(0, 90), report_fn=report, stop_check=stop_check, metrics_out=metrics_out,
    )
    report(90)

    zip_path = os.path.join(output_dir, "output.zip")

    print("[Converter][Stage2][NeRF] 학습 이미지 기반 프레임 번들 생성 중...")
    sampled_images = _sample_evenly(image_paths, NERF_FALLBACK_MAX_FRAMES)
    if not sampled_images:
        raise FileNotFoundError("NeRF carousel용 이미지 소스를 찾을 수 없습니다")

    frame_paths = _write_png_frames_from_images(sampled_images, render_dir)
    if not frame_paths:
        raise FileNotFoundError("NeRF 프레임 결과(PNG)를 찾을 수 없습니다")

    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for frame_path in frame_paths:
            zf.write(frame_path, os.path.join("frames", os.path.basename(frame_path)))

    report(99)
    print(f"[Converter][Stage2][NeRF] 완료 -> {zip_path} (PNG={len(frame_paths)}장)")
    return zip_path


# ================================================================
# 2단계 - Point Cloud (COLMAP sparse point cloud 추출)
# ================================================================
def _point_cloud_from_colmap(processed_dir: str, output_dir: str, report, quality_preset: str | None = None, stop_check=None) -> str:
    # Convert COLMAP sparse reconstruction points to PLY.
    output_ply = os.path.join(output_dir, "output.ply")
    quality_preset = _normalize_quality_preset(quality_preset)
    cfg = _quality_config(quality_preset)
    num_points = cfg["point_cloud_points"]

    # ns-process-data 결과의 COLMAP sparse 경로 후보
    colmap_sparse_candidates = [
        os.path.join(processed_dir, "colmap", "sparse", "0"),
        os.path.join(processed_dir, "sparse", "0"),
        os.path.join(processed_dir, "sparse"),
    ]
    colmap_sparse = next((p for p in colmap_sparse_candidates if os.path.isdir(p)), None)

    report(10)

    if colmap_sparse:
        print(f"[Converter][PointCloud] COLMAP sparse -> PLY: {colmap_sparse}")
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
                print(f"[Converter][PointCloud] COLMAP PLY 추출 완료 -> {output_ply}")
                return output_ply
        except Exception as e:
            if "__asset_deleted__" in str(e):
                raise
            print(f"[Converter][PointCloud] colmap model_converter 실패: {e}")

    raise RuntimeError("포인트클라우드 변환 실패: COLMAP 결과를 PLY로 변환할 수 없습니다.")


# ================================================================
# 2단계 - Mesh (COLMAP -> NeRF -> Mesh 추출)
# ================================================================
def _rotation_matrix_xyz_deg(rotation_deg: np.ndarray) -> np.ndarray:
    """Three.js Euler('XYZ')와 같은 회전 행렬을 만든다. R = Rx @ Ry @ Rz"""
    rx, ry, rz = np.radians(rotation_deg)
    a, b = np.cos(rx), np.sin(rx)
    c, d = np.cos(ry), np.sin(ry)
    e, f = np.cos(rz), np.sin(rz)
    return np.array([
        [c * e,               -c * f,              d],
        [a * f + b * e * d,   a * e - b * f * d,  -b * c],
        [b * f - a * e * d,   b * e + a * f * d,   a * c],
    ], dtype=np.float64)


def _euler_xyz_rad_from_matrix(R: np.ndarray) -> np.ndarray:
    """회전 행렬 R = Rx @ Ry @ Rz에서 XYZ 오일러 각도(라디안)를 추출한다."""
    ry = np.arcsin(np.clip(float(R[0, 2]), -1.0, 1.0))
    if abs(float(R[0, 2])) < 0.9999:
        rx = np.arctan2(-float(R[1, 2]), float(R[2, 2]))
        rz = np.arctan2(-float(R[0, 1]), float(R[0, 0]))
    else:
        rx = np.arctan2(float(R[2, 1]), float(R[1, 1]))
        rz = 0.0
    return np.array([rx, ry, rz], dtype=np.float64)


def _orthonormalize_rotation(matrix: np.ndarray) -> np.ndarray:
    """Return the nearest proper rotation matrix for a dataparser transform."""
    u, _, vh = np.linalg.svd(matrix)
    rotation = u @ vh
    if np.linalg.det(rotation) < 0:
        u[:, -1] *= -1
        rotation = u @ vh
    return rotation


def _as_4x4_transform(raw):
    if raw is None:
        return None
    mat = np.array(raw, dtype=np.float64)
    if mat.shape == (3, 4):
        full = np.eye(4, dtype=np.float64)
        full[:3, :] = mat
        return full
    if mat.shape == (4, 4):
        return mat
    return None


def _read_colmap_points3d_xyz(points_bin_path: str):
    import struct

    points = []
    with open(points_bin_path, "rb") as f:
        num_points = struct.unpack("<Q", f.read(8))[0]
        for _ in range(num_points):
            f.read(8)  # point3D_id
            xyz = struct.unpack("<ddd", f.read(24))
            f.read(3)  # rgb
            f.read(8)  # error
            track_len = struct.unpack("<Q", f.read(8))[0]
            f.read(track_len * 8)
            points.append(xyz)

    return np.asarray(points, dtype=np.float64)


def _read_ply_vertices(ply_path: str):
    try:
        import trimesh

        loaded = trimesh.load(ply_path, process=False)
        vertices = getattr(loaded, "vertices", None)
        if vertices is None and isinstance(loaded, trimesh.Scene):
            dumped = loaded.dump(concatenate=True)
            vertices = getattr(dumped, "vertices", None)
        if vertices is None:
            return None
        points = np.asarray(vertices, dtype=np.float64)
        if points.ndim != 2 or points.shape[1] != 3 or len(points) == 0:
            return None
        return points
    except Exception:
        return None


def _load_preview_space_points(processed_dir: str | None):
    if not processed_dir:
        return None, None

    ply_candidates = [
        os.path.join(processed_dir, "colmap", "sparse", "0", "points3D.ply"),
        os.path.join(processed_dir, "sparse", "0", "points3D.ply"),
        os.path.join(processed_dir, "colmap", "sparse", "points3D.ply"),
    ]
    for candidate in ply_candidates:
        if os.path.exists(candidate) and os.path.getsize(candidate) > 0:
            points = _read_ply_vertices(candidate)
            if points is not None:
                return points, candidate

    bin_candidates = [
        os.path.join(processed_dir, "colmap", "sparse", "0", "points3D.bin"),
        os.path.join(processed_dir, "sparse", "0", "points3D.bin"),
    ]
    for candidate in bin_candidates:
        if os.path.exists(candidate) and os.path.getsize(candidate) > 0:
            try:
                return _read_colmap_points3d_xyz(candidate), candidate
            except Exception:
                continue

    return None, None


def _count_points_inside_obb(points: np.ndarray, center: np.ndarray, rotation_deg: np.ndarray, scale: np.ndarray):
    if points is None or len(points) == 0:
        return 0, 0.0

    rotation_matrix = _rotation_matrix_xyz_deg(rotation_deg)
    half = np.maximum(np.abs(scale) / 2.0, np.full(3, 1e-6, dtype=np.float64))
    local = (points - center) @ rotation_matrix
    inside = np.all(np.abs(local) <= half, axis=1)
    kept = int(np.count_nonzero(inside))
    return kept, float(kept / max(len(points), 1))


def _estimate_preview_obb_coverage(obb_params: dict | None, processed_dir: str | None):
    if not obb_params:
        return None

    try:
        center = np.array(obb_params.get("center", [0, 0, 0]), dtype=np.float64)
        rotation_deg = np.array(obb_params.get("rotation", [0, 0, 0]), dtype=np.float64)
        scale = np.abs(np.array(obb_params.get("scale", [1, 1, 1]), dtype=np.float64))
        preview_center = np.array(obb_params.get("previewCenter", [0, 0, 0]), dtype=np.float64)
        if center.shape != (3,) or rotation_deg.shape != (3,) or scale.shape != (3,) or preview_center.shape != (3,):
            return None
        if not (
            np.all(np.isfinite(center))
            and np.all(np.isfinite(rotation_deg))
            and np.all(np.isfinite(scale))
            and np.all(np.isfinite(preview_center))
        ):
            return None

        points, source = _load_preview_space_points(processed_dir)
        if points is None or len(points) == 0:
            return None

        world_center = center + preview_center
        inside, ratio = _count_points_inside_obb(points, world_center, rotation_deg, scale)
        stats = {
            "inside": inside,
            "total": int(len(points)),
            "ratio": ratio,
            "source": source,
        }
        print(
            "[Converter][OBB] preview selection coverage:"
            f" source={source},"
            f" inside={inside}/{len(points)} ({ratio * 100:.2f}%),"
            f" previewWorldCenter={world_center.tolist()},"
            f" previewScale={scale.tolist()}"
        )
        return stats
    except Exception as e:
        print(f"[Converter][OBB] preview coverage estimate failed: {e}")
        return None


def _should_use_poisson_export_obb(coverage_stats: dict | None):
    if not coverage_stats:
        return False
    total = max(int(coverage_stats.get("total", 0)), 1)
    inside = int(coverage_stats.get("inside", 0))
    min_inside = max(64, min(500, int(total * 0.002)))
    return inside >= min_inside


def _poisson_crop_num_points(base_points: int, coverage_stats: dict | None):
    if not coverage_stats:
        return base_points
    ratio = float(coverage_stats.get("ratio", 1.0))
    if ratio >= 0.25:
        return base_points
    scaled = int(base_points * max(0.20, min(1.0, ratio * 3.0)))
    return max(60000, min(base_points, scaled))


def _obb_aabb_bounds(center: np.ndarray, rotation_deg: np.ndarray, scale: np.ndarray):
    rotation_matrix = _rotation_matrix_xyz_deg(rotation_deg)
    half = np.maximum(np.abs(scale) / 2.0, np.full(3, 1e-6, dtype=np.float64))
    corners = np.array(
        [
            [sx * half[0], sy * half[1], sz * half[2]]
            for sx in (-1.0, 1.0)
            for sy in (-1.0, 1.0)
            for sz in (-1.0, 1.0)
        ],
        dtype=np.float64,
    )
    world_corners = corners @ rotation_matrix.T + center
    min_corner = world_corners.min(axis=0)
    max_corner = world_corners.max(axis=0)
    padding = np.maximum((max_corner - min_corner) * 0.02, np.full(3, 1e-3, dtype=np.float64))
    return min_corner - padding, max_corner + padding


def _load_mesh_for_crop(export_dir: str):
    import trimesh

    mesh_files = sorted(glob_module.glob(os.path.join(export_dir, "*.obj")))
    if not mesh_files:
        mesh_files = sorted(glob_module.glob(os.path.join(export_dir, "*.ply")))
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


def _resolve_export_obb(obb_params: dict | None, processed_dir: str | None = None):
    """Convert preview-space OBB params from the UI into Nerfstudio export-space OBB args.

    COLMAP sparse PLY 공간(preview)의 OBB를 nerfstudio 학습 공간으로 변환한다.
    transforms.json의 applied_transform / applied_scale을 사용해 좌표를 맞춘다.
    """
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

        # COLMAP 공간의 절대 중심
        world_center_colmap = center + preview_center
        safe_scale = np.maximum(scale, np.full(3, 1e-6, dtype=np.float64))
        rotation_matrix = _rotation_matrix_xyz_deg(rotation_deg)

        # transforms.json을 사용해 nerfstudio 좌표계로 변환
        ns_transform, ns_scale = _load_nerfstudio_transform(processed_dir) if processed_dir else (None, None)
        if ns_scale is not None and ns_scale > 0:
            if ns_transform is not None:
                # 중심과 회전을 COLMAP -> nerfstudio로 변환
                c_h = np.append(world_center_colmap, 1.0)
                world_center = (c_h @ ns_transform.T)[:3] * ns_scale
                ns_rotation = _orthonormalize_rotation(ns_transform[:3, :3])
                rotation_rad = _euler_xyz_rad_from_matrix(ns_rotation @ rotation_matrix)
            else:
                # applied_transform이 없으면 scale만 적용
                world_center = world_center_colmap * ns_scale
                rotation_rad = np.radians(rotation_deg)

            # scale도 nerfstudio 정규화 비율 적용
            safe_scale = np.maximum(safe_scale * ns_scale, np.full(3, 1e-6, dtype=np.float64))
            print(
                "[Converter][OBB] nerfstudio 좌표 변환 적용:"
                f" colmapCenter={world_center_colmap.tolist()},"
                f" nsCenter={world_center.tolist()},"
                f" nsScale={safe_scale.tolist()},"
                f" nsRotationRad={rotation_rad.tolist()},"
                f" hasTransform={ns_transform is not None}"
            )
        else:
            world_center = world_center_colmap
            rotation_rad = np.radians(rotation_deg)
            print("[Converter][OBB] transforms.json 없음: COLMAP 좌표계 그대로 사용")

        return {
            "center": world_center,
            "rotation_deg": np.degrees(rotation_rad),
            "rotation_rad": rotation_rad,
            "scale": safe_scale,
            "preview_center": preview_center,
        }
    except Exception:
        return None




def _crop_exported_mesh_v2(
    export_dir: str,
    obb_params: dict,
    processed_dir: str | None = None,
    resolved_obb: dict | None = None,
):
    # Crop the exported mesh with the exact OBB used by nerfstudio export.
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

        export_obb = resolved_obb or _resolve_export_obb(obb_params, processed_dir)
        if export_obb is None:
            print("[Converter][Crop] invalid OBB crop params, keeping original mesh")
            return

        exact_center = np.array(export_obb["center"], dtype=np.float64)
        exact_rotation = np.array(export_obb["rotation_deg"], dtype=np.float64)
        exact_scale = np.abs(np.array(export_obb["scale"], dtype=np.float64))
        total = int(len(mesh.faces))
        clipped = _clip_mesh_with_obb(mesh, exact_center, exact_rotation, exact_scale)
        kept = 0 if clipped is None else int(len(clipped.faces))
        print(
            "[Converter][Crop] OBB exact final clip:"
            f" center={exact_center.tolist()},"
            f" rotationDeg={exact_rotation.tolist()},"
            f" scale={exact_scale.tolist()},"
            f" kept={kept}/{total}"
        )
        if clipped is None or clipped.is_empty or len(clipped.faces) == 0:
            print("[Converter][Crop] OBB crop produced an empty mesh, keeping original mesh")
            return
        min_expected_faces = max(50, int(total * 0.01))
        if total >= 1000 and kept < min_expected_faces:
            print(
                "[Converter][Crop] OBB crop kept too few faces,"
                f" keeping original mesh instead (kept={kept}/{total}, minExpected={min_expected_faces})"
            )
            return

        clipped.export(mesh_path)
        print(f"[Converter][Crop] mesh clip complete: {mesh_path} (kept={kept}/{total})")
        return

    except Exception as e:
        print(f"[Converter][Crop] crop failed, keeping original mesh: {e}")
        return



def _convert_cad_to_mesh_files(input_path: str, output_dir: str, ext: str, report) -> dict:
    """
    CAD 포맷(STEP/IGES/BREP)을 STL + OBJ로 직접 변환한다 (cadquery 사용).
    tolerance는 모델 바운딩박스 대각선 기반으로 자동 계산한다.
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
        angular_tolerance = 0.15  # 약 8.6도, 곡면 품질과 면 수의 균형
        print(f"[Converter][Mesh] CAD 바운딩박스 대각선={diag:.1f}, tolerance={tolerance:.4f}, angularTol={angular_tolerance}")

        stl_path = os.path.join(output_dir, "output.stl")
        cq.exporters.export(shape, stl_path, exportType=cq.exporters.ExportTypes.STL,
                            tolerance=tolerance, angularTolerance=angular_tolerance)
        report(60)
        print(f"[Converter][Mesh] CAD -> STL 완료 (tolerance={tolerance:.4f})")

        # STL을 crease angle 기반으로 부드럽게 처리한 뒤 OBJ / GLB / PLY로 변환
        obj_path = os.path.join(output_dir, "output.obj")
        try:
            import trimesh as _trimesh
            import numpy as np
            _mesh = _trimesh.load(stl_path, force="mesh")
            # crease_angle=30도: 30도 이하는 smooth, 이상은 sharp edge 유지
            _mesh = _trimesh.graph.smoothed(_mesh, angle=np.radians(30))
            _mesh.export(obj_path)
            report(70)
            print(f"[Converter][Mesh] STL to OBJ complete: {len(_mesh.faces)} faces")
        except Exception as e:
            print(f"[Converter][Mesh] OBJ 변환 실패: {e}")
            obj_path = stl_path

        return {"stl": stl_path, "obj": obj_path}
    except ImportError:
        raise RuntimeError(
            "cadquery가 설치되어 있지 않습니다. Docker 이미지를 다시 빌드하세요.\n"
            "  docker compose build worker"
        )


# ================================================================
# POINT CLOUD 변환
# ================================================================
def _mesh_to_point_cloud(input_path: str, output_path: str, report, num_points: int = 200_000) -> str:
    import trimesh
    report(15)
    loaded = trimesh.load(input_path, force="scene")
    report(30)
    if isinstance(loaded, trimesh.Scene):
        meshes = [g for g in loaded.geometry.values() if isinstance(g, trimesh.Trimesh)]
        if not meshes:
            raise ValueError("유효한 메시 없음")
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


# ================================================================
# POISSON SURFACE RECONSTRUCTION (PLY -> GLB)
# ================================================================
def poisson_to_mesh(input_ply: str, output_dir: str, progress_callback=None,
                    depth: int = 9, normal_radius_factor: float = 0.05,
                    normal_max_nn: int = 30) -> str:
    """
    Open3D Poisson Surface Reconstruction으로 포인트클라우드 PLY를 GLB로 변환.

    단계:
      1. PLY 로드 -> 법선 추정 -> Poisson 재구성 -> 외곽 면 제거
      2. trimesh로 GLB 내보내기
    반환: GLB 파일 경로
    """
    def report(pct: int):
        if progress_callback:
            progress_callback(min(pct, 99))

    try:
        import open3d as o3d
    except ImportError:
        raise RuntimeError(
            "open3d 미설치: 'pip install open3d' 후 다시 시도하세요."
        )

    try:
        import trimesh
    except ImportError:
        raise RuntimeError(
            "trimesh 미설치: 'pip install trimesh' 후 다시 시도하세요."
        )

    os.makedirs(output_dir, exist_ok=True)
    output_glb = os.path.join(output_dir, "output.glb")

    # 1. PLY 로드
    report(5)
    print(f"[Converter][PSR] PLY 로드: {input_ply}")
    pcd = o3d.io.read_point_cloud(input_ply)
    n_pts = len(pcd.points)
    if n_pts == 0:
        raise ValueError("포인트클라우드가 비어 있습니다.")
    print(f"[Converter][PSR] 포인트 수: {n_pts:,}")
    report(10)

    # 2. 법선 추정
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

    # 3. Poisson Surface Reconstruction
    print(f"[Converter][PSR] Poisson 재구성 중 (depth={depth})...")
    mesh, densities = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(
        pcd, depth=depth, width=0, scale=1.1, linear_fit=False
    )
    report(70)

    # 4. 외곽 영역 제거
    print("[Converter][PSR] 외곽 면 제거 중...")
    densities_np = np.asarray(densities)
    threshold    = np.quantile(densities_np, 0.05)  # 하위 5% 제거
    vertices_to_remove = densities_np < threshold
    mesh.remove_vertices_by_mask(vertices_to_remove)
    mesh.compute_vertex_normals()
    report(80)

    # 5. 포인트 색상을 메시 정점 색상으로 전달 (KNN)
    if pcd.has_colors():
        print("[Converter][PSR] 포인트 색상 -> 메시 정점 색상 전달 중...")
        pcd_pts = np.asarray(pcd.points)
        pcd_colors = np.asarray(pcd.colors)
        mesh_verts = np.asarray(mesh.vertices)
        # sklearn 없이 numpy 브로드캐스트로 nearest-neighbor 계산
        chunk = 4096
        nn_indices = np.empty(len(mesh_verts), dtype=np.int64)
        for start in range(0, len(mesh_verts), chunk):
            end = min(start + chunk, len(mesh_verts))
            diff = pcd_pts[np.newaxis, :, :] - mesh_verts[start:end, np.newaxis, :]  # (chunk, N, 3)
            dists = np.sum(diff ** 2, axis=-1)  # (chunk, N)
            nn_indices[start:end] = np.argmin(dists, axis=-1)
        mesh.vertex_colors = o3d.utility.Vector3dVector(pcd_colors[nn_indices])
    report(85)

    # 6. Open3D -> trimesh -> GLB 내보내기
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
    print(f"[Converter][PSR] 완료 -> {output_glb} ({len(faces):,}면)")
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


# NerfStudio 헬퍼
class CommandTimeoutError(RuntimeError):
    pass


_PSNR_PATTERN = re.compile(r'psnr[:\s=]+([0-9]+\.?[0-9]*)', re.IGNORECASE)
_SSIM_PATTERN = re.compile(r'ssim[:\s=]+([0-9]+\.?[0-9]*)', re.IGNORECASE)




def _load_nerfstudio_transform(processed_dir: str):
    """Return raw preview/COLMAP -> Nerfstudio dataparser-space transform.

    ns-export OBB arguments and exported mesh vertices live in the dataparser
    output space, not just the sparse COLMAP preview space. Recreate
    Nerfstudio's default auto-orient, centering, and auto-scale step so crop
    boxes selected in the sparse preview land on the exported mesh.
    """
    import json as _json

    tf_path = os.path.join(processed_dir, "transforms.json")
    if not os.path.exists(tf_path):
        return None, None
    try:
        with open(tf_path, encoding="utf-8") as f:
            data = _json.load(f)
    except Exception:
        return None, None

    applied_scale = 1.0
    try:
        applied_scale = float(data.get("applied_scale", 1.0))
    except Exception:
        applied_scale = 1.0

    applied_transform = _as_4x4_transform(data.get("applied_transform"))

    try:
        frames = data.get("frames", [])
        poses = []
        for frame in frames:
            pose = _as_4x4_transform(frame.get("transform_matrix"))
            if pose is not None:
                poses.append(pose)
        if poses:
            import torch
            from nerfstudio.cameras import camera_utils

            poses_tensor = torch.from_numpy(np.asarray(poses, dtype=np.float32))
            orientation_method = data.get("orientation_override", "up")
            oriented_poses, orient_transform = camera_utils.auto_orient_and_center_poses(
                poses_tensor,
                method=orientation_method,
                center_method="poses",
            )
            max_abs = float(torch.max(torch.abs(oriented_poses[:, :3, 3])).item())
            auto_scale = 1.0 / max_abs if max_abs > 1e-8 else 1.0

            orient_full = np.eye(4, dtype=np.float64)
            orient_full[:3, :] = orient_transform.detach().cpu().numpy().astype(np.float64)
            full_transform = orient_full @ applied_transform if applied_transform is not None else orient_full
            return full_transform, auto_scale * applied_scale
    except Exception as e:
        print(f"[Converter][OBB] dataparser transform fallback: {e}")

    if applied_transform is not None:
        return applied_transform, applied_scale
    return None, applied_scale




def _colmap_bin_to_ply(points_bin_path: str, out_ply_path: str):
    # Convert COLMAP points3D.bin to PLY (x y z r g b).
    import struct

    with open(points_bin_path, "rb") as f:
        num_points = struct.unpack("<Q", f.read(8))[0]
        points = []
        for _ in range(num_points):
            # point3D_id (uint64), xyz (3횞float64), rgb (3횞uint8),
            # error (float64), track_length (uint64), track data
            _pid = struct.unpack("<Q", f.read(8))[0]
            x, y, z = struct.unpack("<ddd", f.read(24))
            r, g, b = struct.unpack("<BBB", f.read(3))
            _error = struct.unpack("<d", f.read(8))[0]
            track_len = struct.unpack("<Q", f.read(8))[0]
            f.read(track_len * 8)  # image_id + point2D_idx pairs
            points.append((x, y, z, r, g, b))

    with open(out_ply_path, "wb") as f:
        header = (
            "ply\n"
            "format binary_little_endian 1.0\n"
            f"element vertex {len(points)}\n"
            "property float x\n"
            "property float y\n"
            "property float z\n"
            "property uchar red\n"
            "property uchar green\n"
            "property uchar blue\n"
            "end_header\n"
        )
        f.write(header.encode("ascii"))
        for x, y, z, r, g, b in points:
            f.write(struct.pack("<fffBBB", float(x), float(y), float(z), r, g, b))


def _run_cmd(cmd: list, report_range: tuple, report_fn, timeout: int = 7200, stop_check=None, metrics_out: dict | None = None):
    import threading
    start_pct, end_pct = report_range
    print(f"[Converter] 실행: {' '.join(cmd)}")
    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", bufsize=1,
    )
    step_pattern = re.compile(r"Step.*?(\d+)/(\d+)")
    rich_step_pattern = re.compile(r"^\s*(\d+)\s+\((\d+(?:\.\d+)?)%\)")
    ansi_pattern = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
    stopped_by_deletion = [False]

    def _read_stdout():
        for line in proc.stdout:
            line = line.rstrip()
            if line:
                print(f"  [ns] {line}")
            clean_line = ansi_pattern.sub("", line)
            m = step_pattern.search(clean_line)
            if m:
                cur, total = int(m.group(1)), int(m.group(2))
                if total > 0:
                    ratio = cur / total
                    pct = int(start_pct + ratio * (end_pct - start_pct))
                    report_fn(pct)
            else:
                rm = rich_step_pattern.search(clean_line)
                if rm:
                    ratio = max(0.0, min(1.0, float(rm.group(2)) / 100.0))
                    pct = int(start_pct + ratio * (end_pct - start_pct))
                    report_fn(pct)
            if metrics_out is not None:
                pm = _PSNR_PATTERN.search(clean_line)
                if pm:
                    try:
                        metrics_out["psnr"] = round(float(pm.group(1)), 4)
                    except ValueError:
                        pass
                sm = _SSIM_PATTERN.search(clean_line)
                if sm:
                    try:
                        val = float(sm.group(1))
                        # SSIM은 0~1 범위여야 함 (nerfstudio가 % 단위로 찍는 경우 보정)
                        if val > 1.0:
                            val = val / 100.0
                        metrics_out["ssim"] = round(val, 6)
                    except ValueError:
                        pass

    def _monitor():
        while proc.poll() is None:
            time.sleep(3)
            try:
                if stop_check and stop_check():
                    print("[Converter] 작업 취소/삭제 감지: 프로세스 강제 종료")
                    stopped_by_deletion[0] = True
                    proc.kill()
                    try:
                        proc.stdout.close()
                    except Exception:
                        pass
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
        try:
            proc.stdout.close()
        except Exception:
            pass
        reader.join(timeout=5)
        raise CommandTimeoutError(f"명령 타임아웃 ({timeout}초 초과): {' '.join(cmd)}")

    reader.join(timeout=10)

    if stopped_by_deletion[0]:
        raise RuntimeError("__asset_deleted__")
    if proc.returncode != 0:
        raise RuntimeError(f"명령 실패 (exit {proc.returncode}): {' '.join(cmd)}")


def _find_nerfstudio_config(train_dir: str) -> str:
    configs = sorted(glob_module.glob(os.path.join(train_dir, "**", "config.yml"), recursive=True))
    if not configs:
        raise FileNotFoundError(f"config.yml 없음: {train_dir}")
    return max(configs, key=os.path.getmtime)


def _find_nerfstudio_model_dir(train_dir: str) -> str:
    model_dirs = sorted(glob_module.glob(os.path.join(train_dir, "**", "nerfstudio_models"), recursive=True))
    if not model_dirs:
        raise FileNotFoundError(f"nerfstudio_models 없음: {train_dir}")
    return max(model_dirs, key=os.path.getmtime)


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


def _texture_slot_has_image(value) -> bool:
    if value is None:
        return False
    if hasattr(value, "image"):
        return _texture_slot_has_image(getattr(value, "image", None))
    return hasattr(value, "save") or isinstance(value, np.ndarray)


def _scene_has_image_texture(scene_or_mesh) -> bool:
    try:
        import trimesh

        if isinstance(scene_or_mesh, trimesh.Scene):
            geometries = scene_or_mesh.geometry.values()
        elif isinstance(scene_or_mesh, trimesh.Trimesh):
            geometries = [scene_or_mesh]
        else:
            return False

        for geom in geometries:
            visual = getattr(geom, "visual", None)
            mat = getattr(visual, "material", None)
            if mat is None:
                continue
            for slot in MESH_TEXTURE_SLOTS:
                if _texture_slot_has_image(getattr(mat, slot, None)):
                    return True
        return False
    except Exception as e:
        print(f"[MeshTexture] texture inspection failed: {e}")
        return False


def _export_scene_to_glb(scene, mesh, glb_path: str, require_texture: bool = False):
    had_texture = _scene_has_image_texture(scene)
    if require_texture and not had_texture:
        raise RequiredMeshTextureError("Required mesh texture was not found before GLB export")

    try:
        scene.export(glb_path)
        if not os.path.exists(glb_path) or os.path.getsize(glb_path) == 0:
            raise ValueError("scene GLB export produced empty file")
    except Exception as e:
        if require_texture or had_texture:
            raise RequiredMeshTextureError(f"Textured GLB export failed: {e}") from e
        print(f"[MeshBundle] scene GLB export failed ({e}), falling back to mesh export")
        mesh.export(glb_path)

    if require_texture or had_texture:
        import trimesh

        exported = trimesh.load(glb_path, force="scene")
        if not _scene_has_image_texture(exported):
            raise RequiredMeshTextureError("GLB export completed without an embedded image texture")


def _extract_textures_from_scene(scene, output_dir: str) -> list:
    """Scene에 임베드된 텍스처 이미지를 PNG 파일로 추출하여 경로 목록 반환"""
    try:
        extracted = []
        img_idx = [0]
        seen_img_ids = set()

        def _save_img(img, suffix=""):
            if img is None:
                return
            if id(img) in seen_img_ids:
                return
            seen_img_ids.add(id(img))
            img_path = os.path.join(output_dir, f"texture_{img_idx[0]}{suffix}.png")
            try:
                img.save(img_path)
                extracted.append(img_path)
                img_idx[0] += 1
            except Exception as e_img:
                print(f"[MeshBundle] 텍스처 저장 실패: {e_img}")

        for _name, geom in scene.geometry.items():
            visual = getattr(geom, 'visual', None)
            if visual is None:
                continue
            mat = getattr(visual, 'material', None)
            if mat is None:
                continue
            # SimpleMaterial: single image
            _save_img(getattr(mat, 'image', None))
            # PBRMaterial: multiple texture slots
            for slot in ('baseColorTexture', 'metallicRoughnessTexture', 'normalTexture',
                         'occlusionTexture', 'emissiveTexture'):
                tex = getattr(mat, slot, None)
                if tex is not None:
                    _save_img(getattr(tex, 'image', None) if hasattr(tex, 'image') else tex,
                              suffix=f"_{slot}")
        return extracted
    except Exception as e:
        print(f"[MeshBundle] scene 텍스처 추출 실패 (무시): {e}")
        return []


def _write_mesh_interop_bundle(
    scene_or_mesh,
    output_dir: str,
    report=None,
    texture_dir: str | None = None,
    require_texture: bool = False,
) -> str:
    scene, mesh = _coerce_scene_and_mesh(scene_or_mesh)
    glb_path = os.path.join(output_dir, "output.glb")
    obj_path = os.path.join(output_dir, "output.obj")
    stl_path = os.path.join(output_dir, "output.stl")
    ply_path = os.path.join(output_dir, "output.ply")

    MAIN_FILES = {"output.glb", "output.obj", "output.stl", "output.ply", "output.zip"}
    IMAGE_EXTS = {'.png', '.jpg', '.jpeg', '.webp'}
    MTL_EXTS   = {'.mtl'}

    # GLB: scene으로 내보내 텍스처/재질을 보존하고 실패하면 mesh fallback 사용
    _export_scene_to_glb(scene, mesh, glb_path, require_texture=require_texture)

    # OBJ: scene으로 내보내 재질/MTL/텍스처 파일도 함께 생성
    try:
        scene.export(obj_path)
    except Exception as e:
        print(f"[MeshBundle] scene OBJ export failed ({e}), falling back to mesh export")
        mesh.export(obj_path)

    mesh.export(stl_path)
    mesh.export(ply_path, vertex_normal=True)

    if report:
        report(92)

    # OBJ 내보내기 시 output_dir에 생성된 MTL/텍스처 파일 수집
    obj_extras: list[tuple[str, str]] = []  # (abs_path, arcname)
    for fname in sorted(os.listdir(output_dir)):
        if fname in MAIN_FILES:
            continue
        ext = os.path.splitext(fname)[-1].lower()
        if ext in IMAGE_EXTS or ext in MTL_EXTS:
            fpath = os.path.join(output_dir, fname)
            if os.path.isfile(fpath):
                obj_extras.append((fpath, fname))
    if obj_extras:
        print(f"[MeshBundle] OBJ 내보내기 생성 파일 {len(obj_extras)}개 ZIP에 포함")

    # texture_dir에서 이미지 파일 수집 (하위 디렉터리 포함, nerfstudio 내보내기용)
    texture_files: list[str] = []
    if texture_dir and os.path.isdir(texture_dir):
        for dirpath, _, filenames in os.walk(texture_dir):
            # output_dir 내부는 이미 obj_extras로 처리했으므로 중복 방지
            if os.path.abspath(dirpath) == os.path.abspath(output_dir):
                continue
            for fname in filenames:
                if os.path.splitext(fname)[-1].lower() in IMAGE_EXTS:
                    texture_files.append(os.path.join(dirpath, fname))
        texture_files.sort()
        if texture_files:
            print(f"[MeshBundle] 외부 텍스처 {len(texture_files)}개 ZIP에 포함")
        else:
            print(f"[MeshBundle] texture_dir({texture_dir})에 이미지 파일 없음")

    # 위 두 경로 모두 텍스처 없는 경우: scene에서 직접 추출 (GLB 임베드 텍스처)
    if not obj_extras and not texture_files:
        extracted = _extract_textures_from_scene(scene, output_dir)
        if extracted:
            for ep in extracted:
                obj_extras.append((ep, os.path.basename(ep)))
            print(f"[MeshBundle] scene에서 텍스처 {len(extracted)}개 추출")

    zip_path = os.path.join(output_dir, "output.zip")
    added_arcnames: set[str] = set()
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for fname, arcname in [
            (glb_path, "output.glb"),
            (obj_path, "output.obj"),
            (stl_path, "output.stl"),
            (ply_path, "output.ply"),
        ]:
            if os.path.exists(fname):
                zf.write(fname, arcname)
                added_arcnames.add(arcname)
            else:
                print(f"[MeshBundle] WARNING: {arcname} not found, skipping")

        # MTL + OBJ 내보내기 텍스처 (원본 파일명 유지해 OBJ 참조가 깨지지 않도록)
        for fpath, arcname in obj_extras:
            if arcname not in added_arcnames:
                zf.write(fpath, arcname)
                added_arcnames.add(arcname)

        # 외부 텍스처 (basename 충돌 시 접두어 추가)
        for tex_path in texture_files:
            arcname = os.path.basename(tex_path)
            if arcname in added_arcnames:
                arcname = f"tex_{arcname}"
            if arcname not in added_arcnames:
                zf.write(tex_path, arcname)
                added_arcnames.add(arcname)

    print(f"[MeshBundle] ZIP 생성 완료: {len(added_arcnames)}개 파일")
    return zip_path


def _mesh_from_colmap(processed_dir: str, output_dir: str, report, output_profile: str | None = None, obb_params: dict | None = None, quality_preset: str | None = None, stop_check=None, metrics_out: dict | None = None) -> str:
    train_dir = os.path.join(output_dir, "train")
    export_dir = os.path.join(output_dir, "export")
    profile = _normalize_mesh_profile(output_profile)
    os.makedirs(export_dir, exist_ok=True)
    quality_preset = _normalize_quality_preset(quality_preset)
    cfg = _quality_config(quality_preset)
    nerf_iterations = cfg["nerf_iterations"]
    mesh_sample_points = cfg["mesh_sample_points"]
    mesh_target_faces = cfg["mesh_target_faces"]

    print(
        "[Converter][Mesh from COLMAP] nerfacto -> poisson mesh export "
        f"(quality={quality_preset}, iter={nerf_iterations}, points={mesh_sample_points}, faces={mesh_target_faces})"
    )
    _run_cmd(
        [
            "ns-train", "nerfacto",
            "--data", processed_dir,
            "--output-dir", train_dir,
            "--max-num-iterations", str(nerf_iterations),
            "--pipeline.model.predict-normals", "True",
            "--pipeline.model.implementation", "tcnn",
            "--viewer.quit-on-train-completion", "True",
        ],
        report_range=(0, 80), report_fn=report, stop_check=stop_check, metrics_out=metrics_out,
    )
    report(80)

    config_path = _find_nerfstudio_config(train_dir)

    export_obb = _resolve_export_obb(obb_params, processed_dir) if obb_params else None
    preview_obb_coverage = _estimate_preview_obb_coverage(obb_params, processed_dir) if export_obb is not None else None
    use_export_obb = export_obb is not None and _should_use_poisson_export_obb(preview_obb_coverage)
    export_num_points = _poisson_crop_num_points(mesh_sample_points, preview_obb_coverage) if use_export_obb else mesh_sample_points

    export_cmd = [
        "ns-export", "poisson",
        "--load-config", config_path,
        "--output-dir", export_dir,
        "--num-points", str(export_num_points),
        "--target-num-faces", str(mesh_target_faces),
        "--normal-method", "model_output",
        "--texture-method", "nerf",
        "--unwrap-method", "xatlas",
        "--num-pixels-per-side", "2048",
        "--num-rays-per-batch", "16384",
    ]
    if use_export_obb:
        export_cmd.extend([
            "--obb-center",
            *[str(float(v)) for v in np.asarray(export_obb["center"], dtype=np.float64).tolist()],
            "--obb-rotation",
            *[str(float(v)) for v in np.asarray(export_obb["rotation_rad"], dtype=np.float64).tolist()],
            "--obb-scale",
            *[str(float(v)) for v in np.asarray(export_obb["scale"], dtype=np.float64).tolist()],
        ])
        print(
            "[Converter][Mesh from COLMAP] Poisson export-time OBB crop enabled:"
            f" obbCenter={export_obb['center'].tolist()},"
            f" obbRotationDeg={export_obb['rotation_deg'].tolist()},"
            f" obbRotationRad={export_obb['rotation_rad'].tolist()},"
            f" obbScale={export_obb['scale'].tolist()},"
            f" points={export_num_points}"
        )
    elif export_obb is not None:
        print(
            "[Converter][Mesh from COLMAP] Poisson export-time OBB crop skipped; "
            "falling back to post-export crop to avoid slow/empty point sampling."
        )

    _run_cmd(
        export_cmd,
        report_range=(80, 92), report_fn=report,
        timeout=3600, stop_check=stop_check,
    )

    if obb_params and not use_export_obb:
        _crop_exported_mesh_v2(export_dir, obb_params, processed_dir, resolved_obb=export_obb)
    elif obb_params:
        print("[Converter][Crop] export-time OBB used; keeping NerfStudio textured mesh output")
    report(95)

    obj_files = glob_module.glob(os.path.join(export_dir, "*.obj"))
    if obj_files:
        try:
            import trimesh

            scene_or_mesh = trimesh.load(obj_files[0], force="scene")
            if not _scene_has_image_texture(scene_or_mesh):
                raise RequiredMeshTextureError("NerfStudio mesh export did not include an image texture")
            if profile == "mesh_interop_bundle":
                zip_path = _write_mesh_interop_bundle(
                    scene_or_mesh,
                    output_dir,
                    report=report,
                    texture_dir=export_dir,
                    require_texture=True,
                )
                report(99)
                return zip_path
            output_path = os.path.join(output_dir, "output.glb")
            scene, mesh = _coerce_scene_and_mesh(scene_or_mesh)
            _export_scene_to_glb(scene, mesh, output_path, require_texture=True)
            report(99)
            return output_path
        except RequiredMeshTextureError:
            raise
        except Exception as e:
            raise RuntimeError(f"Textured OBJ -> GLB export failed: {e}") from e

    output_path = os.path.join(output_dir, "output.glb")
    glbs = glob_module.glob(os.path.join(export_dir, "*.glb"))
    if glbs:
        import trimesh

        scene_or_mesh = trimesh.load(glbs[0], force="scene")
        if not _scene_has_image_texture(scene_or_mesh):
            raise RequiredMeshTextureError("NerfStudio GLB export did not include an image texture")
        if profile == "mesh_interop_bundle":
            zip_path = _write_mesh_interop_bundle(
                scene_or_mesh,
                output_dir,
                report=report,
                texture_dir=export_dir,
                require_texture=True,
            )
            report(99)
            return zip_path
        shutil.copy(glbs[0], output_path)
        report(99)
        return output_path

    raise RequiredMeshTextureError("NerfStudio mesh export did not produce the required textured OBJ/GLB")


CAD_EXTS = {".step", ".stp", ".iges", ".igs", ".brep"}


def _convert_mesh(input_path: str, output_dir: str, ext: str, report, output_profile: str | None = None, quality_preset: str | None = None) -> str:
    output_path = os.path.join(output_dir, "output.glb")
    profile = _normalize_mesh_profile(output_profile)
    cfg = _quality_config(quality_preset)
    report(5)

    if ext in (".glb", ".gltf"):
        if profile == "mesh_interop_bundle":
            import trimesh

            scene_or_mesh = trimesh.load(input_path, force="scene")
            report(85)
            zip_path = _write_mesh_interop_bundle(scene_or_mesh, output_dir, report=report)
            report(95)
            return zip_path
        if ext == ".gltf":
            import trimesh

            scene_or_mesh = trimesh.load(input_path, force="scene")
            scene, mesh = _coerce_scene_and_mesh(scene_or_mesh)
            _export_scene_to_glb(scene, mesh, output_path)
            report(95)
            return output_path
        shutil.copy(input_path, output_path)
        report(95)
        return output_path

    if ext == ".ply":
        print("[Converter][Mesh] PLY detected -> running Poisson reconstruction")
        glb_path = poisson_to_mesh(input_path, output_dir, progress_callback=report, depth=cfg["mesh_psr_depth"])
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

        scene, mesh = _coerce_scene_and_mesh(scene_or_mesh)
        _export_scene_to_glb(scene, mesh, output_path)
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


def _convert_point_cloud(input_path: str, output_dir: str, ext: str, report, output_profile: str | None = None, quality_preset: str | None = None) -> str:
    output_path = os.path.join(output_dir, "output.ply")
    cfg = _quality_config(quality_preset)
    report(5)

    if ext == ".ply":
        shutil.copy(input_path, output_path)
        report(95)
        return output_path

    if ext in (".glb", ".gltf", ".obj", ".stl", ".dae", ".off"):
        try:
            return _mesh_to_point_cloud(input_path, output_path, report, num_points=cfg["point_cloud_points"])
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
