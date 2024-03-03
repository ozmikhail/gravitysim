#include "lib/cuda/kernel_launchers.h"

namespace grav {

namespace {

constexpr int kBlockSize = 128;

__global__ void init_parents(int* parents, int n) {
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) {
        parents[i] = i;
    }
}

__device__ int collision_root(int* parents, int index) {
    while (true) {
        const int parent = atomicAdd(&parents[index], 0);
        if (index == parent) {
            return index;
        }
        index = parent;
    }
}

__device__ void join(int* parents, int a, int b) {
    while (true) {
        a = collision_root(parents, a);
        b = collision_root(parents, b);
        if (a == b) {
            return;
        }

        // Links always point toward lower indices, even when another thread wins.
        const int hi = a > b ? a : b;
        const int lo = a > b ? b : a;
        if (atomicCAS(&parents[hi], hi, lo) == hi) {
            return;
        }
    }
}

__global__ void find_collisions(const float* positions, int* parents, int n, float radius_sq) {
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n) {
        return;
    }
    const float x = positions[3 * i];
    const float y = positions[3 * i + 1];
    const float z = positions[3 * i + 2];
    for (int j = i + 1; j < n; ++j) {
        const float dx = positions[3 * j] - x;
        const float dy = positions[3 * j + 1] - y;
        const float dz = positions[3 * j + 2] - z;
        if (dx * dx + dy * dy + dz * dz <= radius_sq) {
            join(parents, i, j);
        }
    }
}

}

void launch_find_collisions(
    const float* positions, int* parents, int n, float radius_sq, cudaStream_t stream
) {
    const int blocks = (n + kBlockSize - 1) / kBlockSize;
    init_parents<<<blocks, kBlockSize, 0, stream>>>(parents, n);
    find_collisions<<<blocks, kBlockSize, 0, stream>>>(positions, parents, n, radius_sq);
}

}
