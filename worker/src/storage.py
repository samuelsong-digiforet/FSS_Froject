import os
import io
from minio import Minio

def get_client() -> Minio:
    return Minio(
        endpoint=os.getenv("MINIO_ENDPOINT", "minio") + ":" + os.getenv("MINIO_PORT", "9000"),
        access_key=os.getenv("MINIO_ROOT_USER", ""),
        secret_key=os.getenv("MINIO_ROOT_PASSWORD", ""),
        secure=False,
    )

def download_object(object_name: str, local_path: str) -> None:
    """MinIO에서 파일 다운로드"""
    client = get_client()
    bucket = os.getenv("MINIO_BUCKET", "fss-uploads")
    client.fget_object(bucket, object_name, local_path)
    print(f"[Storage] Downloaded: {object_name} -> {local_path}")

def upload_object(local_path: str, object_name: str, content_type: str = "application/octet-stream") -> str:
    """MinIO에 파일 업로드 후 object_name 반환"""
    client = get_client()
    bucket = os.getenv("MINIO_BUCKET", "fss-uploads")
    client.fput_object(bucket, object_name, local_path, content_type=content_type)
    print(f"[Storage] Uploaded: {local_path} -> {object_name}")
    return object_name