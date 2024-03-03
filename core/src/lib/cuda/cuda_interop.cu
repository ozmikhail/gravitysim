#include "lib/cuda/cuda_interop.h"

#include <cuda_gl_interop.h>
#include <cuda_runtime.h>

#include <cstddef>
#include <cstdint>
#include <string>

#include "error.h"

namespace grav::cuda {

namespace {

#define GRAV_INTEROP_CHECK(expr)                                                    \
    do {                                                                            \
        cudaError_t _e = (expr);                                                    \
        if (_e != cudaSuccess) {                                                    \
            throw AppError::dependency_unavailable(                                 \
                std::string("cuda interop: " #expr ": ") + cudaGetErrorString(_e)  \
            );                                                                      \
        }                                                                           \
    } while (0)

}

GlBufferInterop::GlBufferInterop(std::uint32_t vbo, std::size_t size_bytes)
    : vbo_(vbo), size_bytes_(size_bytes) {
    cudaGraphicsResource_t res = nullptr;
    GRAV_INTEROP_CHECK(cudaGraphicsGLRegisterBuffer(
        &res, static_cast<GLuint>(vbo), cudaGraphicsRegisterFlagsNone
    ));
    resource_ = res;
}

GlBufferInterop::~GlBufferInterop() {
    if (resource_ != nullptr) {
        cudaGraphicsUnregisterResource(static_cast<cudaGraphicsResource_t>(resource_));
        resource_ = nullptr;
    }
}

void* GlBufferInterop::map(void* stream) {
    auto res = static_cast<cudaGraphicsResource_t>(resource_);
    auto cstream = static_cast<cudaStream_t>(stream);
    GRAV_INTEROP_CHECK(cudaGraphicsMapResources(1, &res, cstream));

    void* device_ptr = nullptr;
    std::size_t mapped_bytes = 0;
    GRAV_INTEROP_CHECK(
        cudaGraphicsResourceGetMappedPointer(&device_ptr, &mapped_bytes, res)
    );
    return device_ptr;
}

void GlBufferInterop::unmap(void* stream) {
    auto res = static_cast<cudaGraphicsResource_t>(resource_);
    auto cstream = static_cast<cudaStream_t>(stream);
    GRAV_INTEROP_CHECK(cudaGraphicsUnmapResources(1, &res, cstream));
}

}
