FROM nvidia/cuda:11.8.0-cudnn8-devel-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1
ENV CUDA_HOME=/usr/local/cuda
ENV PATH="${CUDA_HOME}/bin:${PATH}"
ENV LD_LIBRARY_PATH="${CUDA_HOME}/lib64:${LD_LIBRARY_PATH}"

# 시스템 패키지
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.10 python3-pip python3.10-dev \
    git cmake build-essential ninja-build \
    libgl1 libglib2.0-0 libgomp1 \
    libsm6 libxext6 libxrender1 \
    libboost-filesystem-dev libboost-graph-dev libboost-program-options-dev \
    libboost-system-dev libboost-test-dev \
    libeigen3-dev libflann-dev libfreeimage-dev libgoogle-glog-dev \
    libgflags-dev libglew-dev libgtest-dev libsqlite3-dev libvulkan-dev \
    qtbase5-dev libqt5opengl5-dev libcgal-dev \
    libceres-dev \
    libmetis-dev \
    ffmpeg \
    wget curl \
    && rm -rf /var/lib/apt/lists/*

# COLMAP CUDA 빌드 (apt 버전은 GPU 미지원)
# 75=Turing(RTX 20xx) 80=Ampere(A100) 86=Ampere(RTX 30xx) 89=Ada(RTX 40xx) 90=Hopper(H100)
RUN git clone https://github.com/colmap/colmap.git /tmp/colmap && \
    cd /tmp/colmap && git checkout 3.9.1 && \
    mkdir build && cd build && \
    cmake .. -GNinja \
        -DCMAKE_CUDA_ARCHITECTURES="75;80;86;89;90" \
        -DCMAKE_BUILD_TYPE=Release \
        -DGUI_ENABLED=OFF && \
    ninja install && \
    rm -rf /tmp/colmap

RUN ln -sf /usr/bin/python3.10 /usr/bin/python && \
    ln -sf /usr/bin/pip3 /usr/bin/pip

WORKDIR /app

# PyTorch (CUDA 11.8)
RUN pip install --no-cache-dir \
    torch==2.1.0+cu118 torchvision==0.16.0+cu118 \
    --index-url https://download.pytorch.org/whl/cu118

# NerfStudio (3DGS splatfacto + nerfacto 포함)
RUN pip install --no-cache-dir nerfstudio==1.1.4

# Opacity Entropy Loss 패치 적용
COPY patches/splatfacto_opacity_entropy.patch .
RUN patch /usr/local/lib/python3.10/dist-packages/nerfstudio/models/splatfacto.py \
    splatfacto_opacity_entropy.patch

# gsplat (3DGS 학습 엔진) - CUDA 빌드 필요
RUN pip install --no-cache-dir gsplat==1.0.0

# tiny-cuda-nn (tcnn) — nerfacto hash grid 가속 (범용 멀티 아키텍처)
RUN pip install --no-cache-dir ninja && \
    TCNN_CUDA_ARCHITECTURES="75;80;86;89;90" pip install --no-cache-dir \
        git+https://github.com/NVlabs/tiny-cuda-nn/#subdirectory=bindings/torch

# 기타 의존성
COPY requirements.txt .
RUN pip install --no-cache-dir \
    -i https://mirror.kakao.com/pypi/simple/ \
    -r requirements.txt

COPY src/ ./src/

CMD ["python", "src/main.py"]
