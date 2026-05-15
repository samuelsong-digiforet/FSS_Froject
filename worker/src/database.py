import os
import json
import psycopg2

def get_connection():
    return psycopg2.connect(
        host=os.getenv("DB_HOST", "postgres"),
        port=int(os.getenv("DB_PORT", "5432")),
        dbname=os.getenv("DB_NAME", "fss"),
        user=os.getenv("DB_USER", "fss_user"),
        password=os.getenv("DB_PASS", "fss_secret_2024"),
    )


def update_asset_status(asset_id: str, status: str, output_object: str = None, error_message: str = None, progress: int = None):
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            if output_object:
                cur.execute(
                    "UPDATE assets SET status = %s, output_object = %s, progress = 100, updated_at = NOW() WHERE id = %s",
                    (status, output_object, asset_id),
                )
            elif error_message:
                cur.execute(
                    "UPDATE assets SET status = %s, error_message = %s, updated_at = NOW() WHERE id = %s",
                    (status, error_message, asset_id),
                )
            elif progress is not None:
                cur.execute(
                    "UPDATE assets SET status = %s, progress = %s, updated_at = NOW() WHERE id = %s",
                    (status, progress, asset_id),
                )
            else:
                cur.execute(
                    "UPDATE assets SET status = %s, updated_at = NOW() WHERE id = %s",
                    (status, asset_id),
                )
        conn.commit()
    finally:
        conn.close()


def reset_processing_assets():
    """워커 재시작 시 처리 중이던 에셋을 failed로 표시 (재시작으로 인해 중단됨)."""
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE assets
                   SET status = 'failed',
                       error_message = '워커가 재시작되어 처리가 중단되었습니다. 다시 변환을 시도해 주세요.',
                       updated_at = NOW()
                   WHERE status = 'processing'""",
            )
        conn.commit()
    finally:
        conn.close()


def mark_asset_processing(asset_id: str):
    """Mark only this asset as processing; everything else goes back to pending."""
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE assets
                   SET status = 'pending', progress = 0, updated_at = NOW()
                   WHERE status = 'processing' AND id <> %s""",
                (asset_id,),
            )
            cur.execute(
                """UPDATE assets
                   SET status = 'processing', progress = 0, updated_at = NOW()
                   WHERE id = %s AND status <> 'failed'
                   RETURNING id""",
                (asset_id,),
            )
            if cur.rowcount == 0:
                raise AssetDeletedException(f"Asset {asset_id} deleted -- stopping job")
        conn.commit()
    finally:
        conn.close()


def update_asset_progress(asset_id: str, progress: int):
    """변환 진행률 업데이트. 에셋이 삭제된 경우 AssetDeletedException 발생."""
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE assets SET progress = %s, updated_at = NOW() WHERE id = %s RETURNING id",
                (progress, asset_id),
            )
            if cur.rowcount == 0:
                raise AssetDeletedException(f"Asset {asset_id} deleted — stopping job")
        conn.commit()
    finally:
        conn.close()


def is_asset_deleted(asset_id: str) -> bool:
    """에셋이 DB에서 삭제됐는지 확인"""
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM assets WHERE id = %s", (asset_id,))
            return cur.fetchone() is None
    finally:
        conn.close()


def is_asset_cancelled(asset_id: str) -> bool:
    """에셋이 삭제됐거나 사용자에 의해 취소(failed)됐는지 확인"""
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT status FROM assets WHERE id = %s", (asset_id,))
            row = cur.fetchone()
            if row is None:
                return True  # 삭제됨
            return row[0] == "failed"
    finally:
        conn.close()


def update_awaiting_crop(asset_id: str, colmap_object: str, preview_center=None, preview_bounds=None):
    """Stage 1 완료 후 영역 선택 대기 상태로 변경 및 colmap 경로 저장"""
    metadata = {"colmapObject": colmap_object}
    if preview_center is not None:
        metadata["previewCenter"] = preview_center
    if preview_bounds is not None:
        metadata["previewBounds"] = preview_bounds

    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE assets
                   SET status = 'awaiting_crop',
                       metadata = COALESCE(metadata, '{}'::jsonb) || %s::jsonb,
                       updated_at = NOW()
                   WHERE id = %s""",
                (json.dumps(metadata), asset_id),
            )
        conn.commit()
    finally:
        conn.close()


def update_texture_objects(asset_id: str, texture_objects: list):
    """메시 텍스쳐 파일 경로 목록을 metadata에 저장"""
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE assets
                   SET metadata = COALESCE(metadata, '{}'::jsonb) || %s::jsonb,
                       updated_at = NOW()
                   WHERE id = %s""",
                (json.dumps({"textureObjects": texture_objects}), asset_id),
            )
        conn.commit()
    finally:
        conn.close()


def merge_asset_metadata(asset_id: str, metadata: dict):
    """Merge arbitrary values into metadata jsonb."""
    if not metadata:
        return
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE assets
                   SET metadata = COALESCE(metadata, '{}'::jsonb) || %s::jsonb,
                       updated_at = NOW()
                   WHERE id = %s""",
                (json.dumps(metadata), asset_id),
            )
        conn.commit()
    finally:
        conn.close()


def update_quality_metrics(asset_id: str, metrics: dict):
    """PSNR, SSIM 등 품질 지표를 metadata에 저장"""
    merge_asset_metadata(asset_id, metrics)


class AssetDeletedException(Exception):
    pass
