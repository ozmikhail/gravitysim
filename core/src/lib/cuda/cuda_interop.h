#pragma once

#include <cstddef>
#include <cstdint>

namespace grav::cuda {

class GlBufferInterop {
public:
    GlBufferInterop(std::uint32_t vbo, std::size_t size_bytes);
    ~GlBufferInterop();

    GlBufferInterop(const GlBufferInterop&) = delete;
    GlBufferInterop& operator=(const GlBufferInterop&) = delete;
    GlBufferInterop(GlBufferInterop&&) = delete;
    GlBufferInterop& operator=(GlBufferInterop&&) = delete;

    [[nodiscard]] std::uint32_t vbo() const noexcept { return vbo_; }
    [[nodiscard]] std::size_t size_bytes() const noexcept { return size_bytes_; }

    void* map(void* stream);
    void unmap(void* stream);

private:
    std::uint32_t vbo_ = 0;
    std::size_t size_bytes_ = 0;
    void* resource_ = nullptr;
};

}
